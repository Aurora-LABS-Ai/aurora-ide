/**
 * Agent Window — project-scoped chat store (feature state).
 *
 * The single owner of conversation state in the frontend. It enforces the core
 * architectural rule: **conversations are scoped to a project path**.
 *
 * Everything here is keyed on `projectRoot` (the workspace the window was opened
 * for, passed in via `?ws=`):
 *   - the chat list only ever shows threads whose `workspaceRoot === projectRoot`
 *     AND that already have at least one message (a 0-message thread is an
 *     abandoned draft / legacy empty "New Chat" and is filtered out);
 *   - "New chat" opens a DRAFT (centered empty state) — it does NOT create a
 *     thread or a rail row. The thread is materialised, tagged with
 *     `projectRoot`, only when the user sends the first message.
 *
 * Persistence is delegated to the Rust `SessionStore` through `threadService`;
 * this store holds only the in-memory view (list + the open thread).
 */

import { create } from "zustand";

import { isTauri } from "@/kernel/lib/ipc/tauri";
import { auroraInvoke } from "@/kernel/lib/ipc/runtime";
import { useAgentContextStore } from "@/apps/agent/store/conversation/useAgentContextStore";
import { useAgentSubagentStore } from "@/apps/agent/store/subagents/useAgentSubagentStore";
import { toast } from "@/apps/agent/store/ui/useAgentToastStore";
import { useAgentWorkspaceStore } from "@/apps/agent/store/workspace/useAgentWorkspaceStore";
import { deriveThreadTitle } from "@/apps/agent/lib/thread/thread-title";
import { mergeDiskModels } from "@/apps/agent/lib/thread/disk-models";
import {
  recentSurfaceThread,
  rememberSurfaceThread,
} from "@/apps/agent/lib/thread/surface-resume";
import { useWorkspaceStore } from "@/kernel/store/useWorkspaceStore";
import { useAgentSettingsStore, whenAgentSettingsReady } from "@/apps/agent/store/settings/useAgentSettingsStore";
import { databaseService } from "@/kernel/services/database";
import { AGENT_LAST_WORKSPACE_KEY } from "@/apps/agent/adapters/window";
import {
  threadService,
  type AttachedPromptChip,
  type ConversationMode,
  type DbMessage,
  type DbThread,
  type ThreadSummary,
} from "@/apps/agent/services/threads/thread-service";
import type { AgentActivity } from "@/apps/agent/components/conversation/activity";
import type {
  AgentExecutionMode,
  AuroraSurface,
} from "@/apps/agent/services/runtime/agent-execution-mode";

/**
 * The agent window never mounts the IDE explorer, but the agent runtime reads
 * the *workspace* path straight off `useWorkspaceStore` (see
 * `AgentService.chat`) to root file/shell tools. Because this is a separate OS
 * window with its own store instance, we point that instance at the window's
 * scoped project so tools operate on the right directory — without touching the
 * IDE window's workspace.
 */
/**
 * Which product the window is on, read at call time rather than subscribed to.
 *
 * This store is not a component and has no render to re-run; every caller here
 * is an action that already knows it is happening now. Reading the settings
 * store directly is also what keeps a stale closure from listing the wrong
 * store's conversations after a switch.
 */
function currentSurface(): AuroraSurface {
  return useAgentSettingsStore.getState().auroraSurface;
}

function bindRuntimeWorkspace(projectRoot: string | null): void {
  if (!isTauri()) return;
  try {
    useWorkspaceStore.setState({ rootPath: projectRoot ?? undefined });
  } catch (err) {
    console.warn("[agent-chat] failed to bind runtime workspace:", err);
  }
}

/**
 * Record the project this WINDOW is working in, so the next standalone launch
 * reopens it.
 *
 * The agent window had no memory of its own. On an icon launch the Rust
 * launcher fell back to `workspace_state` — the IDE's table — so the agent
 * window reopened wherever the IDE was last pointed. Someone who stops opening
 * the IDE gets a frozen row and the agent window returns to a project they
 * abandoned weeks ago, with no way to change it that sticks.
 *
 * Same storage precedent as `agent_window_bounds`: a plain `app_settings` key
 * this window owns, written as it is used rather than at close (a close-time
 * write races window teardown, and writing as you go also survives a crash).
 * Best-effort — failing to remember a path must never break switching to it.
 */
function rememberAgentWorkspace(projectRoot: string | null): void {
  if (!isTauri()) return;
  void databaseService
    .setSetting(AGENT_LAST_WORKSPACE_KEY, projectRoot ?? "")
    .catch((err) => console.warn("[agent-chat] failed to remember workspace:", err));
}

/**
 * Conversations whose model this window is writing to disk right now, with how
 * many writes are outstanding. A read of the sidecar that started before the
 * write landed reports the old model and is not adopted (see `disk-models`).
 */
const modelWritesInFlight = new Map<string, number>();
/** The same, for a conversation's Agent/Plan mode. */
const modeWritesInFlight = new Map<string, number>();

/** One deferred `patchTurnMessage` (see `queueTurnPatch`). */
interface QueuedTurnPatch {
  threadId: string;
  id: string;
  patch: (message: DbMessage) => DbMessage;
}

/** Patches waiting for the next frame, in the order they were made. */
let queuedTurnPatches: QueuedTurnPatch[] = [];
let patchFrame: number | null = null;
let patchBackstop: number | null = null;
/** Longest a queued patch waits when the window draws no frames (hidden). */
const PATCH_BACKSTOP_MS = 200;

/**
 * Apply a batch of patches to the live turns as one state change. Each
 * conversation's turn is copied once however many patches it takes, and the
 * open view follows its live turn as `patchTurnMessage` does.
 */
function applyTurnPatches(
  state: Pick<AgentChatState, "liveTurns" | "currentThreadId" | "currentThread">,
  batch: readonly QueuedTurnPatch[],
): Partial<AgentChatState> | AgentChatState {
  let liveTurns: Record<string, DbThread> | null = null;
  for (const { threadId, id, patch } of batch) {
    const live = (liveTurns ?? state.liveTurns)[threadId];
    if (!live) continue;
    liveTurns ??= { ...state.liveTurns };
    liveTurns[threadId] = {
      ...live,
      messages: live.messages.map((m) => (m.id === id ? patch(m) : m)),
    };
  }
  if (!liveTurns) return state as AgentChatState;
  const open = state.currentThreadId ? liveTurns[state.currentThreadId] : undefined;
  return {
    liveTurns,
    currentThread:
      open && open !== state.liveTurns[state.currentThreadId!] ? open : state.currentThread,
  };
}

/** A user message queued to ride in with the next tool result (mid-turn). */
export interface QueuedAgentMessage {
  /** What the user typed (the pill and the injected row show this). */
  text: string;
  /**
   * The model-facing copy: `text` plus the `<steering_context>` block
   * resolved from staged `/` directives. Absent when nothing was attached.
   * The post-turn auto-flush resubmits THIS, so directives survive a turn
   * that ended before a tool boundary could drain the queue.
   */
  modelText?: string;
  /** Composer pill metadata (file mentions, `/` directives), if any. */
  chips?: AttachedPromptChip[];
  /** Staged images riding the injection as `<aurora_image>` markers. */
  imageCount?: number;
  queuedAt: number;
}

interface AgentChatState {
  /** The project this window is CURRENTLY scoped to. `null` until `init` runs. */
  projectRoot: string | null;
  /**
   * Every project that has chats (deduped `workspaceRoot`s across all threads),
   * plus the current one. Powers the rail's project switcher so the window is
   * never hard-bound: it defaults to the IDE's live project but can re-scope to
   * any known project or a freshly opened folder.
   */
  knownProjects: string[];
  /** Project-scoped chat list, newest first (the active project's chats). */
  threads: ThreadSummary[];
  /**
   * Every project's chats (messageCount > 0), newest first. Powers the rail's
   * multi-project tree and the global Pinned section, so expanding a project
   * other than the active one doesn't require a re-scope or extra fetch.
   */
  allThreads: ThreadSummary[];
  /**
   * Each conversation's model (`providerId:modelKey`), keyed by thread id —
   * a copy of what its sidecar on disk says.
   *
   * Kept apart from `threads`/`allThreads` on purpose. Those lists hold only
   * conversations that already have a message, in the current surface, as of
   * the last listing, so a chat created a moment ago, or one docked from
   * elsewhere, was in neither — and every reader fell back to the app-wide
   * default, which is whatever was picked last in ANY chat. Every way this
   * window learns about a conversation (listing, opening, docking, creating)
   * records its model here, so a chat always reads its own.
   */
  threadModels: Record<string, string>;
  /**
   * Each Build conversation's own Agent/Plan mode, keyed by thread id — a copy
   * of its sidecar, learned the same ways as `threadModels`. A conversation
   * absent here follows the window's default (`agentExecutionMode`).
   */
  threadModes: Record<string, ConversationMode>;
  /** The currently open conversation (`null` = empty state). */
  currentThreadId: string | null;
  currentThread: DbThread | null;

  // ── Concurrent background turns ───────────────────────────────────
  // Multiple turns can run AT ONCE — one per thread (the Rust runtime locks
  // per-thread and runs different threads in parallel; the runtime client
  // isolates every turn by a unique `turnId`). Each in-flight turn streams into
  // its OWN live transcript in `liveTurns`, keyed by thread id, so it survives
  // the user navigating to a different project / chat and is re-attached when
  // that chat is re-opened. The rail shows a running indicator on every working
  // chat + its project.
  /** Live transcripts for in-flight turns, keyed by thread id. */
  liveTurns: Record<string, DbThread>;
  /** Project root each in-flight turn belongs to, keyed by thread id. */
  liveProjects: Record<string, string | null>;
  /**
   * Execution mode each in-flight turn is ACTUALLY running under, keyed by
   * thread id. Absent when no turn is running on that thread.
   *
   * Needed because a turn's mode is not always the window's setting: a task
   * dispatched with `aurora agent --plan` runs read-only for that turn alone,
   * deliberately without repointing the composer (which would leave the window
   * in plan mode afterwards, and would have two concurrent dispatches fight).
   *
   * Without this the composer showed "Agent" while a plan turn refused to
   * write — the mode was real and invisible. The selector reads it to show
   * what is running now, and falls back to the setting when nothing is.
   */
  liveModes: Record<string, AgentExecutionMode>;

  // ── Completion signals ────────────────────────────────────────────
  // When a turn finishes streaming we surface two lightweight cues: a rail
  // "done" dot for chats that completed while you were looking elsewhere (the
  // settled counterpart to the running spinner) and a brief header flash naming
  // the chat that just finished. Neither is persisted — they're transient UX.
  /** Chats whose last turn finished unwatched → rail dot. Value = finish stamp. */
  unseenDone: Record<string, number>;
  /** Most recent completion for the header flash; `null` = idle / dismissed. */
  justFinished: { threadId: string; title: string; at: number } | null;
  /**
   * Live one-line activity label per streaming thread (the header narrator).
   * Set as the turn streams (thinking → tool → responding), cleared at turn end.
   */
  activityByThread: Record<string, AgentActivity>;
  /** Set a thread's activity frame (no-op when unchanged, so token churn is free). */
  setThreadActivity: (threadId: string, activity: AgentActivity) => void;
  /** Record a turn completion: flash the header + (if unwatched) set the rail dot. */
  noteTurnComplete: (threadId: string) => void;
  /** Clear a chat's rail "done" dot (called when it's opened / viewed). */
  clearUnseenDone: (threadId: string) => void;
  /** Light the rail's "done" dot by hand ("Mark as unread" in the row menu). */
  markUnseenDone: (threadId: string) => void;
  /** Dismiss the header completion flash. */
  dismissJustFinished: () => void;

  // ── Mid-turn user-message queue ───────────────────────────────────
  // Sending while a thread's turn is streaming enqueues the text instead of
  // starting a new turn; the Rust runtime drains the slot at the next
  // tool-result boundary and injects it (matches the IDE). Keyed by thread id
  // so each parallel turn has its own pending slot.
  /** Pending mid-turn injection per thread (shows the composer "queued" pill). */
  queuedByThread: Record<string, QueuedAgentMessage>;
  /** Enqueue a mid-turn injection for `threadId` (optimistic; reverts on failure). */
  enqueueMessage: (
    threadId: string,
    text: string,
    opts?: {
      modelText?: string;
      displayText?: string;
      chips?: AttachedPromptChip[];
      imageCount?: number;
      /**
       * Who is queueing this. `"process"` is Aurora reporting a background
       * process — it is framed for the model as an event rather than as
       * something the user said, it renders as a one-line beat instead of a
       * message, and it never lights the composer's "queued" pill (nobody
       * queued anything to cancel).
       */
      origin?: "user" | "process" | "subagent";
      /** The agent a `"subagent"` report is about. */
      agent?: import("@/apps/agent/services/subagents/events").AgentReportMeta | null;
    },
  ) => Promise<void>;
  /** Cancel the pending injection for `threadId` (clears the UI + the Rust slot). */
  cancelQueuedMessage: (threadId: string) => Promise<void>;
  /** Drop the pending injection locally (e.g. after the runtime injected it). */
  clearQueuedMessage: (threadId: string) => void;

  listLoading: boolean;
  threadLoading: boolean;
  /** True while ANY turn is streaming (one or more threads, fg or bg). */
  sending: boolean;
  error: string | null;

  /** Bind the window to a project and load its chats. Idempotent. */
  init: (projectRoot: string | null) => Promise<void>;
  /**
   * Re-scope the window to a different project (switcher / open folder). Clears
   * the open chat (it belongs to the old project) and reloads the scoped list.
   */
  setProject: (projectRoot: string | null) => Promise<void>;
  /** Refresh the deduped list of projects that have chats. */
  loadKnownProjects: () => Promise<void>;
  /** Re-pull the scoped chat list from disk. */
  refreshThreads: () => Promise<void>;
  /**
   * Begin a NEW chat as a DRAFT: drops to the centered empty state WITHOUT
   * creating a thread. No row is added to the rail and nothing is persisted —
   * the thread is only materialised when the user sends the first message (wired
   * with the send pipeline). This is what prevents empty "New Chat" rows from
   * piling up in the list.
   */
  newChat: () => void;
  /**
   * Open an existing chat (loads its transcript). When `workspaceRoot` is
   * supplied (the rail knows each chat's project) and differs from the active
   * scope, the window re-binds to that project so runtime tools target the
   * right directory — this is how opening a chat from another project works.
   */
  selectThread: (id: string, workspaceRoot?: string | null) => Promise<void>;
  /**
   * Move the window to the other product.
   *
   * Clears the view, flips the setting, reloads the rail from the other store,
   * and reopens the conversation that side was left on — but only if it was
   * touched within the last two hours. Otherwise you land on the empty state.
   */
  enterSurface: (surface: AuroraSurface) => Promise<void>;
  /** Delete a chat; clears the view if it was open. */
  deleteThread: (id: string) => Promise<void>;
  /** Rename a chat (persisted); reflects everywhere it renders optimistically. */
  renameThread: (id: string, title: string) => Promise<void>;
  /** Pin or unpin a chat (persisted); updates the in-memory list optimistically. */
  togglePin: (id: string) => Promise<void>;
  /**
   * Pin a conversation to a model (`"providerId:modelKey"`), persisted on the
   * thread's own sidecar.
   *
   * The model is a property OF THE CONVERSATION, not of the app: picking one in
   * chat A must not silently re-point chat B. The runtime writes the same field
   * when each turn starts, so a chat you never touched still reports what it
   * actually ran on.
   */
  setThreadModel: (id: string, selection: string) => Promise<void>;
  /** Put a Build conversation in Agent or Plan mode (persisted on its sidecar). */
  setThreadMode: (id: string, mode: ConversationMode) => Promise<void>;
  /**
   * Record what a conversation's sidecar reported about its model and mode,
   * from any read of it (opening it, docking it). A field this window is
   * still writing for that conversation is skipped: the read may predate it.
   */
  adoptThreadSettings: (
    id: string,
    thread: Pick<DbThread, "model" | "execution_mode"> | null | undefined,
  ) => void;
  /**
   * Archive or unarchive a chat (persisted). Archived chats leave the rail tree
   * for the "Archived" view; if the archived chat is open it drops to the empty
   * state. Updates the in-memory list optimistically and reverts on failure.
   */
  toggleArchive: (id: string) => Promise<void>;
  /** Drop back to the empty state without deleting anything. */
  clearSelection: () => void;

  // ── Send pipeline (P4) ────────────────────────────────────────────
  setSending: (sending: boolean) => void;
  /**
   * Open a live turn on `threadId`: seeds its transcript from the open thread (a
   * just-created draft or an open chat being resent) so streaming has a target
   * that outlives navigation. Multiple turns may be open at once.
   */
  beginTurn: (
    threadId: string,
    seed?: DbThread,
    projectRoot?: string | null,
    executionMode?: AgentExecutionMode,
  ) => void;
  /** Append a message to a live turn (mirrors into the view when it's open). */
  appendTurnMessage: (threadId: string, message: DbMessage) => void;
  /** Patch a message in a live turn by id (mirrors into the view when open). */
  patchTurnMessage: (
    threadId: string,
    id: string,
    patch: (message: DbMessage) => DbMessage,
  ) => void;
  /**
   * `patchTurnMessage`, deferred to the next frame and applied together with
   * every other conversation's queued patches in ONE store update.
   *
   * The streaming path's writes go here. Each store update redraws whatever
   * reads the changed conversation, and a stream produces many per frame: a
   * text flush, every streamed chunk of a tool call's arguments, the tool
   * starting, its result. With two chats streaming, each wrote on its own, so
   * one frame could carry a dozen full redraws of two transcripts. Queued, a
   * frame carries one. Order is kept: every direct write below applies the
   * queue first.
   */
  queueTurnPatch: (
    threadId: string,
    id: string,
    patch: (message: DbMessage) => DbMessage,
  ) => void;
  /** Apply every queued patch now, in order. A no-op when none are queued. */
  flushTurnPatches: () => void;
  /** Close a live turn (clears its transcript; leaves the view intact). */
  endTurn: (threadId: string) => void;
  /**
   * Materialise a thread for the FIRST send of a draft: creates a project-scoped
   * thread titled from the message and selects it, returning its id. If a chat
   * is already open it just returns that id (no new thread).
   */
  ensureThreadForSend: (
    firstUserText: string,
    model?: string | null,
    mode?: ConversationMode | null,
  ) => Promise<string>;
  /** Optimistically append a message to the open thread (live streaming view). */
  appendMessage: (message: DbMessage) => void;
  /** Patch a single message in the open thread by id (token / tool updates). */
  patchMessage: (id: string, patch: (message: DbMessage) => DbMessage) => void;
  /**
   * Rewind the thread to just before the turn containing `messageId`,
   * dropping that turn and everything after it from BOTH the transcript and
   * the Rust session. Returns the user message text that opened the removed
   * turn so the caller can re-send it, or `null` when there is nothing to
   * rewind to.
   *
   * This is what makes Retry a retry rather than a resend: the re-sent
   * message lands on the same prefix, so history gains no duplicate and the
   * provider's prompt cache still hits. Rejects while a turn is streaming.
   */
  rewindToMessage: (messageId: string) => Promise<string | null>;
  /**
   * Reload the open thread from disk (the runtime owns the authoritative JSONL)
   * and refresh the scoped list so a freshly created chat appears in the rail.
   */
  reloadCurrentThread: () => Promise<void>;
}

export const useAgentChatStore = create<AgentChatState>((set, get) => ({
  projectRoot: null,
  knownProjects: [],
  threads: [],
  allThreads: [],
  threadModels: {},
  threadModes: {},
  currentThreadId: null,
  currentThread: null,
  liveTurns: {},
  liveProjects: {},
  liveModes: {},
  unseenDone: {},
  justFinished: null,
  activityByThread: {},
  queuedByThread: {},
  listLoading: false,
  threadLoading: false,
  sending: false,
  error: null,

  enqueueMessage: async (threadId, text, opts) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    // Three copies with distinct jobs: `trimmed` is what the user typed (the
    // pill shows it); `display` adds image markers (the injected row echoes
    // it, so thumbnails render); `model` adds the steering block on top (what
    // the model receives — the runtime prepends its own mid-turn framing).
    const display = opts?.displayText?.trim() || trimmed;
    const model = opts?.modelText?.trim() || display;
    const chips = opts?.chips && opts.chips.length > 0 ? opts.chips : undefined;
    const origin = opts?.origin ?? "user";
    // The pill is "your message is waiting to go in, here is the Cancel
    // button". A process report is not the user's message and cannot be
    // cancelled by them, so it never takes that slot — and must never evict a
    // real queued message that is sitting in it.
    const showsPill = origin === "user";
    // Optimistic: show the pill before the IPC round-trip resolves. Revert on
    // failure. The Rust slot is single-shot (a second enqueue replaces it).
    const prior = get().queuedByThread[threadId] ?? null;
    if (showsPill) {
      set((s) => ({
        queuedByThread: {
          ...s.queuedByThread,
          [threadId]: {
            text: trimmed,
            modelText: model !== trimmed ? model : undefined,
            chips,
            imageCount: opts?.imageCount,
            queuedAt: Date.now(),
          },
        },
      }));
    }
    try {
      await auroraInvoke("agent_enqueue_message", {
        threadId,
        text: model,
        displayText: display !== model ? display : null,
        chips: chips ?? null,
        origin,
        agent: opts?.agent ?? null,
      });
    } catch (err) {
      console.error("[agent-chat] agent_enqueue_message failed:", err);
      if (!showsPill) return;
      set((s) => {
        const next = { ...s.queuedByThread };
        if (prior) next[threadId] = prior;
        else delete next[threadId];
        return { queuedByThread: next };
      });
    }
  },

  cancelQueuedMessage: async (threadId) => {
    // Clear locally first so the pill dismisses instantly; the Rust side is
    // idempotent (Ok on an empty slot).
    get().clearQueuedMessage(threadId);
    try {
      await auroraInvoke("agent_cancel_queued_message", { threadId });
    } catch (err) {
      console.error("[agent-chat] agent_cancel_queued_message failed:", err);
    }
  },

  clearQueuedMessage: (threadId) =>
    set((s) => {
      if (!(threadId in s.queuedByThread)) return s;
      const next = { ...s.queuedByThread };
      delete next[threadId];
      return { queuedByThread: next };
    }),

  init: async (projectRoot) => {
    const normalized = projectRoot && projectRoot.length > 0 ? projectRoot : null;
    set({ projectRoot: normalized });
    bindRuntimeWorkspace(normalized);
    rememberAgentWorkspace(normalized);
    // Which product this window reopens on is a SAVED setting, and it has not
    // been read yet: React runs this window's effect before the app shell's,
    // and the shell's is what starts the settings load. Listing conversations
    // without waiting asked the default — Build — so a window reopening on
    // Aurora Chat filled its rail with Build's conversations and kept them,
    // because nothing lists them again when the real answer arrives.
    await whenAgentSettingsReady();
    // Sequential, not concurrent: `loadKnownProjects` reads the list
    // `refreshThreads` just fetched instead of scanning every conversation
    // again for itself. Run together they raced, both missed, and both
    // scanned. It costs nothing to wait — the second one does no I/O now.
    await get().refreshThreads();
    await get().loadKnownProjects();
  },

  setProject: async (projectRoot) => {
    const normalized = projectRoot && projectRoot.length > 0 ? projectRoot : null;
    if (normalized === get().projectRoot) return;
    // Dropping the open chat is intentional — it lives in the previous project.
    set({ projectRoot: normalized, currentThreadId: null, currentThread: null });
    bindRuntimeWorkspace(normalized);
    rememberAgentWorkspace(normalized);
    // Sequential for the same reason as above.
    await get().refreshThreads();
    await get().loadKnownProjects();
  },

  loadKnownProjects: async () => {
    if (!isTauri()) return;
    try {
      // The distinct workspace roots, taken from the unscoped list
      // `refreshThreads` has already fetched into `allThreads`.
      //
      // This used to list every thread again for itself. Both run together
      // from `setProject`, so the same scan of every conversation on disk ran
      // twice at once, to produce a set of folder names the first one had
      // already brought back. Only fall back to fetching when the list is
      // genuinely empty, which means nothing has loaded it yet.
      const loaded = get().allThreads;
      const all = loaded.length > 0 ? loaded : await threadService.listThreads(null);
      const roots = new Set<string>();
      for (const t of all) {
        if (t.workspaceRoot && t.workspaceRoot.length > 0) roots.add(t.workspaceRoot);
      }
      // Always include the current project so it shows even before its first chat.
      const current = get().projectRoot;
      if (current) roots.add(current);
      set({ knownProjects: [...roots].sort((a, b) => a.localeCompare(b)) });
    } catch (err) {
      console.error("[agent-chat] failed to list known projects:", err);
    }
  },

  refreshThreads: async () => {
    if (!isTauri()) {
      return;
    }
    const { projectRoot } = get();
    const surface = currentSurface();
    set({ listLoading: true, error: null });
    try {
      // One unscoped fetch powers BOTH the multi-project rail tree
      // (`allThreads`) and the active project's scoped list (`threads`).
      // Only surface chats that actually have a message — a 0-message thread is
      // an abandoned draft (lazily created on first send) or a legacy empty
      // "New Chat" and must never show in the rail.
      // Aurora Chat's conversations live in their own store and carry no
      // workspace, so the project filter below is skipped rather than applied:
      // filtering them by project would match none of them and empty the rail.
      const all = await threadService.listThreads(null, surface);
      // A slower request from the previous surface or project must not put
      // its conversations back into the rail after the user has switched.
      if (currentSurface() !== surface || get().projectRoot !== projectRoot) return;
      const withMessages = all.filter((t) => (t.messageCount ?? 0) > 0);
      const scoped =
        surface === "chat" || !projectRoot
          ? withMessages
          : withMessages.filter((t) => t.workspaceRoot === projectRoot);
      set((state) => ({
        threads: scoped,
        allThreads: withMessages,
        // Every listed conversation, empty ones included: a chat whose first
        // turn is still running has no message on disk the listing counts yet,
        // and it is exactly the one whose model must not fall back.
        threadModels: mergeDiskModels(state.threadModels, all, modelWritesInFlight),
        listLoading: false,
      }));
    } catch (err) {
      if (currentSurface() !== surface || get().projectRoot !== projectRoot) return;
      console.error("[agent-chat] failed to list threads:", err);
      set({ listLoading: false, error: String(err) });
    }
  },

  newChat: () => {
    // Draft only — no thread, no rail row, no persistence. The empty state's
    // composer materialises the thread when the first message is sent.
    set({ currentThreadId: null, currentThread: null, error: null });
  },

  enterSurface: async (surface) => {
    if (!isTauri()) return;
    // Remember where THIS side was before leaving it, so coming back lands on
    // the conversation you left rather than on whatever the other side did.
    const leaving = get().currentThreadId;
    if (leaving) rememberSurfaceThread(currentSurface(), leaving);

    // Nothing is carried across: the two sides have different conversations in
    // different stores, and a half-cleared view flashing the wrong transcript
    // is worse than a beat of empty.
    set({
      currentThreadId: null,
      currentThread: null,
      threads: [],
      allThreads: [],
      error: null,
    });

    useAgentSettingsStore.getState().setAuroraSurface(surface);
    await get().refreshThreads();
    if (currentSurface() !== surface) return;

    // Resume, but only if it is still RECENT. Alvan's rule: a conversation you
    // left more than two hours ago is not what you came back for, and dropping
    // into it is more disorienting than an empty composer.
    const resume = recentSurfaceThread(surface, get().allThreads);
    if (resume) await get().selectThread(resume);
  },

  selectThread: async (id, workspaceRoot) => {
    if (!isTauri()) {
      return;
    }
    if (get().currentThreadId === id && get().currentThread) {
      return;
    }
    // Opening a chat marks it seen — drop any background "done" dot it carried.
    get().clearUnseenDone(id);
    // Re-attaching to a still-running turn → show its LIVE transcript, never the
    // stale on-disk snapshot (the in-flight assistant text isn't persisted until
    // the turn ends).
    const live = get();
    const liveThread = live.liveTurns[id];
    if (liveThread) {
      const lws = live.liveProjects[id] ?? workspaceRoot ?? null;
      if (lws && lws !== live.projectRoot) {
        set({ projectRoot: lws });
        bindRuntimeWorkspace(lws);
        void get().refreshThreads();
      }
      set({
        currentThreadId: id,
        currentThread: liveThread,
        threadLoading: false,
        error: null,
      });
      return;
    }

    // Opening a chat from another project re-scopes the window so the agent's
    // file/shell tools operate on that chat's directory.
    const ws = workspaceRoot ?? null;
    if (ws && ws !== get().projectRoot) {
      set({ projectRoot: ws });
      bindRuntimeWorkspace(ws);
      void get().refreshThreads();
    }
    set({ currentThreadId: id, currentThread: null, threadLoading: true, error: null });
    try {
      const thread = await threadService.loadThread(id);
      get().adoptThreadSettings(id, thread);
      // Guard against a race where the user switched chats mid-load.
      if (get().currentThreadId !== id) {
        return;
      }
      set({ currentThread: thread, threadLoading: false });
    } catch (err) {
      console.error(`[agent-chat] failed to load chat ${id}:`, err);
      set({ threadLoading: false, error: String(err) });
    }
  },

  deleteThread: async (id) => {
    if (!isTauri()) {
      return;
    }
    // Drop any stale completion dot for a chat that's about to disappear.
    get().clearUnseenDone(id);
    try {
      await threadService.deleteThread(id);
    } catch (err) {
      console.error(`[agent-chat] failed to delete chat ${id}:`, err);
      toast("Could not finish deleting the chat. Stop its work and try again.", { tone: "error" });
      return;
    }
    useAgentSubagentStore.getState().forget(id);
    const workspace = useAgentWorkspaceStore.getState();
    for (const tab of workspace.tabs) {
      if (tab.kind === "agent" && tab.parentThreadId === id) workspace.closeTab(tab.id);
    }
    set((state) => ({
      threads: state.threads.filter((t) => t.id !== id),
      allThreads: state.allThreads.filter((t) => t.id !== id),
      currentThreadId: state.currentThreadId === id ? null : state.currentThreadId,
      currentThread: state.currentThreadId === id ? null : state.currentThread,
    }));
  },

  renameThread: async (id, title) => {
    const clean = title.replace(/\s+/g, " ").trim();
    const current =
      get().allThreads.find((t) => t.id === id) ?? get().threads.find((t) => t.id === id);
    if (!clean || clean === current?.title) return;
    const apply = (value: string) => (state: AgentChatState) => ({
      threads: state.threads.map((t) => (t.id === id ? { ...t, title: value } : t)),
      allThreads: state.allThreads.map((t) => (t.id === id ? { ...t, title: value } : t)),
      currentThread:
        state.currentThreadId === id && state.currentThread
          ? { ...state.currentThread, title: value }
          : state.currentThread,
      liveTurns: state.liveTurns[id]
        ? { ...state.liveTurns, [id]: { ...state.liveTurns[id], title: value } }
        : state.liveTurns,
    });
    // Optimistic — the row, header, and live turn all rename instantly.
    set(apply(clean));
    if (!isTauri()) return;
    try {
      await threadService.updateTitle(id, clean);
    } catch (err) {
      console.error(`[agent-chat] failed to rename chat ${id}:`, err);
      if (current) set(apply(current.title));
    }
  },

  togglePin: async (id) => {
    const current =
      get().allThreads.find((t) => t.id === id) ?? get().threads.find((t) => t.id === id);
    const next = !(current?.pinned ?? false);
    const flip = (value: boolean) => (state: AgentChatState) => ({
      threads: state.threads.map((t) => (t.id === id ? { ...t, pinned: value } : t)),
      allThreads: state.allThreads.map((t) => (t.id === id ? { ...t, pinned: value } : t)),
    });
    // Optimistic flip so the row jumps sections immediately.
    set(flip(next));
    if (!isTauri()) return;
    try {
      await threadService.setPinned(id, next);
    } catch (err) {
      console.error(`[agent-chat] failed to ${next ? "pin" : "unpin"} chat ${id}:`, err);
      set(flip(!next));
    }
  },

  setThreadModel: async (id, selection) => {
    const previous = get().threadModels[id] ?? null;
    if (!selection || previous === selection) return;
    const apply = (value: string | null) => (state: AgentChatState) => {
      const threadModels = { ...state.threadModels };
      if (value) threadModels[id] = value;
      else delete threadModels[id];
      return {
        threadModels,
        threads: state.threads.map((t) => (t.id === id ? { ...t, model: value } : t)),
        allThreads: state.allThreads.map((t) => (t.id === id ? { ...t, model: value } : t)),
      };
    };
    // Optimistic — the composer pill must change the instant it's picked.
    set(apply(selection));
    if (!isTauri()) return;
    // A listing or a load already on its way back read the sidecar BEFORE this
    // write; until the write lands, what it reports is the old model.
    modelWritesInFlight.set(id, (modelWritesInFlight.get(id) ?? 0) + 1);
    try {
      await threadService.setModel(id, selection);
    } catch (err) {
      console.error(`[agent-chat] failed to set model for chat ${id}:`, err);
      toast("Couldn't save this chat's model. It will use the previous one.", { tone: "error" });
      set(apply(previous));
    } finally {
      const left = (modelWritesInFlight.get(id) ?? 1) - 1;
      if (left > 0) modelWritesInFlight.set(id, left);
      else modelWritesInFlight.delete(id);
    }
  },

  setThreadMode: async (id, mode) => {
    const previous = get().threadModes[id];
    if (previous === mode) return;
    const apply = (value: ConversationMode | undefined) => (state: AgentChatState) => {
      const threadModes = { ...state.threadModes };
      if (value) threadModes[id] = value;
      else delete threadModes[id];
      return { threadModes };
    };
    set(apply(mode));
    if (!isTauri()) return;
    modeWritesInFlight.set(id, (modeWritesInFlight.get(id) ?? 0) + 1);
    try {
      await threadService.setExecutionMode(id, mode);
    } catch (err) {
      console.error(`[agent-chat] failed to set mode for chat ${id}:`, err);
      toast("Couldn't save this chat's mode. It will use the previous one.", { tone: "error" });
      set(apply(previous));
    } finally {
      const left = (modeWritesInFlight.get(id) ?? 1) - 1;
      if (left > 0) modeWritesInFlight.set(id, left);
      else modeWritesInFlight.delete(id);
    }
  },

  adoptThreadSettings: (id, thread) => {
    const model = thread?.model;
    const mode = thread?.execution_mode;
    const takeModel =
      !!model && !modelWritesInFlight.has(id) && get().threadModels[id] !== model;
    const takeMode =
      !!mode && !modeWritesInFlight.has(id) && get().threadModes[id] !== mode;
    if (!takeModel && !takeMode) return;
    set((state) => ({
      threadModels: takeModel ? { ...state.threadModels, [id]: model! } : state.threadModels,
      threadModes: takeMode ? { ...state.threadModes, [id]: mode! } : state.threadModes,
    }));
  },

  toggleArchive: async (id) => {
    const current =
      get().allThreads.find((t) => t.id === id) ?? get().threads.find((t) => t.id === id);
    const willArchive = !(current?.archivedAt ?? null);
    const stamp = willArchive ? new Date().toISOString() : null;
    const apply = (archivedAt: string | null) => (state: AgentChatState) => ({
      threads: state.threads.map((t) => (t.id === id ? { ...t, archivedAt } : t)),
      allThreads: state.allThreads.map((t) => (t.id === id ? { ...t, archivedAt } : t)),
      // Archiving the open chat hides it from the rail — drop to the empty state
      // so the transcript pane never shows a chat the rail can't navigate back to.
      currentThreadId:
        willArchive && state.currentThreadId === id ? null : state.currentThreadId,
      currentThread:
        willArchive && state.currentThreadId === id ? null : state.currentThread,
    });
    // Optimistic flip so the row leaves / re-enters the tree immediately.
    set(apply(stamp));
    // An archived row leaves the tree — clear its dot so it can't keep a
    // project marker lit from the "Archived" section.
    if (willArchive) get().clearUnseenDone(id);
    if (!isTauri()) return;
    try {
      await threadService.setArchived(id, willArchive);
    } catch (err) {
      console.error(
        `[agent-chat] failed to ${willArchive ? "archive" : "unarchive"} chat ${id}:`,
        err,
      );
      // Revert the optimistic flip (selection stays dropped — harmless).
      set(apply(current?.archivedAt ?? null));
    }
  },

  clearSelection: () => set({ currentThreadId: null, currentThread: null }),

  setSending: (sending) => set({ sending }),

  beginTurn: (threadId, seed, projectRoot, executionMode) => {
    get().flushTurnPatches();
    set((state) => {
      const now = new Date().toISOString();
      // The OPEN thread's own view outranks a supplied seed when they are the
      // same conversation. Both hold the same turns, but the open view holds
      // the optimistic messages this window has been rendering, while a seed
      // from elsewhere (a docked copy of this chat, which re-reads from disk)
      // carries fresh ids for the same content — swapping it in would remount
      // the whole transcript, collapsing tool groups and jumping the scroll for
      // no visible gain. A seed still wins for any OTHER thread, where the open
      // view says nothing about it.
      const openView =
        state.currentThreadId === threadId ? state.currentThread : null;
      const base: DbThread = openView ??
        seed ?? {
          id: threadId,
          title: "New Chat",
          summary: null,
          messages: [],
          created_at: now,
          updated_at: now,
        };
      return {
        liveTurns: { ...state.liveTurns, [threadId]: base },
        liveProjects: {
          ...state.liveProjects,
          [threadId]: projectRoot === undefined ? state.projectRoot : projectRoot,
        },
        // Recorded per thread so the composer can show what is actually
        // running. Omitted by callers that don't override the mode, which
        // leaves the entry absent and the selector on the window's setting.
        liveModes: executionMode
          ? { ...state.liveModes, [threadId]: executionMode }
          : state.liveModes,
        sending: true,
        currentThread: state.currentThreadId === threadId ? base : state.currentThread,
      };
    });
  },

  appendTurnMessage: (threadId, message) => {
    get().flushTurnPatches();
    set((state) => {
      const live = state.liveTurns[threadId];
      if (!live) return state;
      const lt: DbThread = { ...live, messages: [...live.messages, message] };
      return {
        liveTurns: { ...state.liveTurns, [threadId]: lt },
        currentThread:
          state.currentThreadId === threadId ? lt : state.currentThread,
      };
    });
  },

  patchTurnMessage: (threadId, id, patch) => {
    get().flushTurnPatches();
    set((state) => {
      const live = state.liveTurns[threadId];
      if (!live) return state;
      const lt: DbThread = {
        ...live,
        messages: live.messages.map((m) => (m.id === id ? patch(m) : m)),
      };
      return {
        liveTurns: { ...state.liveTurns, [threadId]: lt },
        currentThread:
          state.currentThreadId === threadId ? lt : state.currentThread,
      };
    });
  },

  queueTurnPatch: (threadId, id, patch) => {
    queuedTurnPatches.push({ threadId, id, patch });
    if (patchFrame !== null || patchBackstop !== null) return;
    const flush = () => get().flushTurnPatches();
    patchFrame = requestAnimationFrame(flush);
    // A hidden window gets no animation frames; the stream must still land.
    patchBackstop = window.setTimeout(flush, PATCH_BACKSTOP_MS);
  },

  flushTurnPatches: () => {
    if (patchFrame !== null) {
      cancelAnimationFrame(patchFrame);
      patchFrame = null;
    }
    if (patchBackstop !== null) {
      window.clearTimeout(patchBackstop);
      patchBackstop = null;
    }
    if (queuedTurnPatches.length === 0) return;
    const batch = queuedTurnPatches;
    queuedTurnPatches = [];
    set((state) => applyTurnPatches(state, batch));
  },

  endTurn: (threadId) => {
    get().flushTurnPatches();
    set((state) => {
      if (!(threadId in state.liveTurns)) return state;
      const liveTurns = { ...state.liveTurns };
      const liveProjects = { ...state.liveProjects };
      delete liveTurns[threadId];
      delete liveProjects[threadId];
      // The narrator only lives for the duration of the turn.
      const activityByThread = { ...state.activityByThread };
      delete activityByThread[threadId];
      // So does the mode override: once the turn is over the composer goes
      // back to describing what YOUR next message will do, which is the
      // window's own setting. Leaving it would strand the selector in a mode
      // nothing is running.
      const liveModes = { ...state.liveModes };
      delete liveModes[threadId];
      return {
        liveTurns,
        liveProjects,
        liveModes,
        activityByThread,
        sending: Object.keys(liveTurns).length > 0,
      };
    });
  },

  noteTurnComplete: (threadId) => {
    // Respect the user's preference — off silences both the header flash and the
    // rail "done" dot. Read non-reactively (this runs once per turn end).
    if (!useAgentSettingsStore.getState().notifyOnTurnComplete) return;
    const state = get();
    // Resolve a friendly title from whatever source currently knows it.
    const listRow =
      state.allThreads.find((t) => t.id === threadId) ??
      state.threads.find((t) => t.id === threadId);
    const raw =
      (state.currentThreadId === threadId ? state.currentThread?.title : null) ||
      state.liveTurns[threadId]?.title ||
      listRow?.title ||
      "";
    const title = raw && raw !== "New Chat" ? raw : "Chat";
    // If this chat is the one on screen, the user already watches it finish — no
    // rail dot needed; still flash the header as a lightweight "done" cue.
    const watched = state.currentThreadId === threadId;
    const at = Date.now();
    set((s) => ({
      justFinished: { threadId, title, at },
      unseenDone: watched ? s.unseenDone : { ...s.unseenDone, [threadId]: at },
    }));
  },

  clearUnseenDone: (threadId) =>
    set((s) => {
      if (!(threadId in s.unseenDone)) return s;
      const next = { ...s.unseenDone };
      delete next[threadId];
      return { unseenDone: next };
    }),

  markUnseenDone: (threadId) =>
    set((s) => ({ unseenDone: { ...s.unseenDone, [threadId]: Date.now() } })),

  dismissJustFinished: () =>
    set((s) => (s.justFinished ? { justFinished: null } : s)),

  setThreadActivity: (threadId, activity) =>
    set((s) => {
      const prev = s.activityByThread[threadId];
      // No-op when the visible frame is unchanged — this fires on every streamed
      // token during "Responding…", so the guard keeps it free.
      if (
        prev &&
        prev.label === activity.label &&
        prev.name === activity.name &&
        prev.kind === activity.kind
      ) {
        return s;
      }
      return { activityByThread: { ...s.activityByThread, [threadId]: activity } };
    }),

  ensureThreadForSend: async (firstUserText, model, mode) => {
    const existing = get().currentThreadId;
    if (existing) return existing;

    const { projectRoot } = get();
    const title = deriveThreadTitle(firstUserText);
    // A chat conversation is created in `Chats/` and given NO workspace. Both
    // matter: the workspace is what would project-scope it out of its own list,
    // and the runtime treats a workspace root as permission to reach the disk.
    const surface = currentSurface();
    const thread = await threadService.createThread(
      title,
      surface === "chat" ? null : projectRoot,
      surface,
      // The seed, read at the moment of creation. From here on the
      // conversation carries its own answer and this setting is irrelevant to
      // it — which is what lets the instruction sit in the cached prefix.
      surface === "chat" && useAgentSettingsStore.getState().deepResearchNext,
      // Born on its model and mode: the sidecar names both before the id
      // comes back. Chat has no modes, so none is sent for it.
      model,
      surface === "chat" ? null : mode,
    );
    set((state) => ({
      currentThreadId: thread.id,
      currentThread: thread,
      threadModels: thread.model
        ? { ...state.threadModels, [thread.id]: thread.model }
        : state.threadModels,
      threadModes: thread.execution_mode
        ? { ...state.threadModes, [thread.id]: thread.execution_mode }
        : state.threadModes,
    }));
    return thread.id;
  },

  appendMessage: (message) => {
    set((state) => {
      if (!state.currentThread) return state;
      return {
        currentThread: {
          ...state.currentThread,
          messages: [...state.currentThread.messages, message],
        },
      };
    });
  },

  patchMessage: (id, patch) => {
    set((state) => {
      if (!state.currentThread) return state;
      return {
        currentThread: {
          ...state.currentThread,
          messages: state.currentThread.messages.map((m) =>
            m.id === id ? patch(m) : m,
          ),
        },
      };
    });
  },

  rewindToMessage: async (messageId) => {
    const state = get();
    const thread = state.currentThread;
    if (!thread) return null;

    const cut = thread.messages.findIndex((m) => m.id === messageId);
    if (cut < 0) return null;

    // The message that opened the turn being retried. Retry re-runs THAT
    // message, not whatever the newest one happens to be.
    //
    // A `process` row opens a turn too — a background process ending woke
    // the conversation — and there is nothing to type again for one of
    // those: the ending already happened, and its report is not a request.
    // Walking past it to an older user message would rewind a turn the
    // person did not ask to retry, so it stops here and declines.
    let openerIndex = -1;
    for (let i = cut; i >= 0; i--) {
      const role = thread.messages[i].role;
      if (role === "user" || role === "process" || role === "agent_report") {
        openerIndex = i;
        break;
      }
    }
    if (openerIndex < 0) return null;
    // A sub-agent's report opens a turn the same way a process row does, and
    // there is nothing to type again for it either.
    const openerRole = thread.messages[openerIndex].role;
    if (openerRole === "process" || openerRole === "agent_report") return null;

    // Its ordinal among the runtime's user-role messages — the one ordering
    // the frontend transcript and the Rust session agree on, since the
    // runtime holds extra tool/notice messages the UI folds away. A process
    // row IS a user-role message on disk (a single process-event block), so
    // it counts here or every retry after one lands a turn early.
    const ordinal = thread.messages
      .slice(0, openerIndex)
      .filter((m) => m.role === "user" || m.role === "process" || m.role === "agent_report")
      .length;
    const userIndex = openerIndex;
    const content = thread.messages[userIndex].content;

    // Rust first: if it refuses (a turn is still streaming) the transcript
    // must stay exactly as it was, or the UI would drop messages the model
    // is still appending to.
    if (isTauri()) {
      await auroraInvoke("agent_rewind_to_user_message", {
        threadId: thread.id,
        userMessageOrdinal: ordinal,
      });
    }

    // The transcript really did shrink, so the high-water context reading from
    // before the rewind describes a request that no longer exists.
    useAgentContextStore.getState().resetContextFloor(thread.id);

    const kept = thread.messages.slice(0, userIndex);
    const trimmed: DbThread = { ...thread, messages: kept };
    set({ currentThread: trimmed });
    if (isTauri()) {
      await threadService.saveThread(trimmed);
    }
    return content;
  },

  reloadCurrentThread: async () => {
    const id = get().currentThreadId;
    if (!id || !isTauri()) return;
    try {
      const thread = await threadService.loadThread(id);
      // Guard against a race where the user switched chats during the turn.
      if (thread && get().currentThreadId === id) {
        set({ currentThread: thread });
      }
    } catch (err) {
      console.error(`[agent-chat] failed to reload chat ${id}:`, err);
    }
    await get().refreshThreads();
  },
}));
