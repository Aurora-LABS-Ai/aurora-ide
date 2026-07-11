/**
 * useTeamStore — the visible team view's data source (Phase 5, §13).
 *
 * A thin reactive projection of the on-disk shared brain. It holds one
 * {@link TeamProjectState} snapshot and keeps it fresh from the live
 * `team_event` stream (the TeamBus broadcast, §7): every persisted channel
 * event is appended optimistically, and a debounced full re-read refreshes
 * the roster / scope / board / gate / phase so the team view stays in sync
 * no matter which window renders it.
 *
 * It is deliberately read-only — the Lead drives the team through the
 * `team-client` control surface; this store only *watches*. It works in any
 * window (main IDE or the detached `show_team` window) because it reads from
 * Rust + the global event channel, not from cross-window Zustand sync.
 */
import { create } from "zustand";

import {
  getTeamState,
  resolveProjectId,
  subscribeTeamEvents,
  subscribeTeamStream,
} from "../services/team-client";
import type {
  ChannelEvent,
  TeamProjectState,
  TeamStreamDelta,
} from "../types/team";

/** How many channel events the snapshot carries (matches the Rust tail). */
const CHANNEL_LIMIT = 200;
/** Debounce window for the full re-read fired off live events. */
const REFRESH_DEBOUNCE_MS = 160;
/**
 * How long a *finished* live draft lingers before it is dropped, as a fallback
 * for the build phase (whose authoritative content arrives via the transcript
 * poll, not a channel event). Kept just above {@link TRANSCRIPT_POLL_MS} so the
 * persisted turn has landed before the draft clears — a brief hand-off, no gap
 * and no lasting duplicate. Group-phase drafts are cleared the instant their
 * authoritative {@link ChannelEvent} lands, so this timer rarely fires there.
 */
const DRAFT_SETTLE_MS = 1200;
/**
 * Safety-net poll interval. The live `team_event` + `team_stream` broadcasts
 * drive the real-time view (the team screen is embedded in this window, so
 * they're reliable); the poll only guarantees eventual consistency if a
 * broadcast is ever missed. Kept slow on purpose — a fast full-brain re-read
 * repaints the feed under the live stream and reads as jank.
 */
const POLL_INTERVAL_MS = 2000;

/**
 * A live, in-flight message being streamed by one agent, keyed by agent id.
 * Ephemeral: built from `team_stream` frames and dropped once the authoritative
 * content (a posted {@link ChannelEvent} or the agent's transcript) supersedes
 * it. This is what makes the Team view stream in real time.
 */
export interface TeamLiveDraft {
  agentId: string;
  /** `"planning" | "building" | "integrating"`. */
  phase: string;
  /** Visible answer text streamed so far. */
  text: string;
  /** Reasoning/thinking streamed so far. */
  thinking: string;
  /** True once the model call finished (an `end` frame arrived). */
  done: boolean;
  /** ms epoch of the first frame — anchors "is this persisted event newer". */
  startedAt: number;
  /** ms epoch of the last frame — powers the "is actively typing" shimmer. */
  updatedAt: number;
}

interface TeamStoreState {
  /** Repo whose brain is being watched (null until {@link start}). */
  repoPath: string | null;
  /** Resolved stable project id for the watched repo. */
  projectId: string | null;
  /** Latest brain snapshot, or null before the first load. */
  snapshot: TeamProjectState | null;
  /** Live in-flight drafts per agent id (streamed tokens, not yet persisted). */
  liveDrafts: Record<string, TeamLiveDraft>;
  /** True while the first load is in flight. */
  loading: boolean;
  /** Last load/subscribe error, if any. */
  error: string | null;

  /** Begin watching `repoPath`: load the snapshot + subscribe live. */
  start: (repoPath: string) => Promise<void>;
  /** Force a full re-read of the brain. */
  refresh: () => Promise<void>;
  /**
   * Drop one agent's live draft NOW — its authoritative copy has landed
   * (the member-transcript poll observed the persisted turn). The streamed
   * copy and the persisted copy must never render together.
   */
  clearDraft: (agentId: string) => void;
  /** Stop watching and tear down the live subscription. */
  stop: () => void;
}

// Module-scoped (non-reactive) handles for the live subscription + timers.
let unsubscribe: (() => void) | null = null;
let streamUnsubscribe: (() => void) | null = null;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let watchToken = 0;
/** Pending "drop this settled draft" timers, keyed by agent id. */
const draftClearTimers: Record<string, ReturnType<typeof setTimeout>> = {};

const cancelDraftClear = (agentId: string): void => {
  const t = draftClearTimers[agentId];
  if (t) {
    clearTimeout(t);
    delete draftClearTimers[agentId];
  }
};

const clearAllDraftTimers = (): void => {
  for (const id of Object.keys(draftClearTimers)) cancelDraftClear(id);
};

/** Merge a live event into the snapshot's channel tail (dedupe by id). */
const appendEvent = (
  snapshot: TeamProjectState | null,
  event: ChannelEvent,
): TeamProjectState | null => {
  if (!snapshot) return snapshot;
  if (snapshot.channel.some((e) => e.id === event.id)) return snapshot;
  const channel = [...snapshot.channel, event].slice(-CHANNEL_LIMIT);
  return { ...snapshot, channel };
};

/** Drop one agent's live draft (immutably) from a drafts map. */
const withoutDraft = (
  drafts: Record<string, TeamLiveDraft>,
  agentId: string,
): Record<string, TeamLiveDraft> => {
  if (!(agentId in drafts)) return drafts;
  const next = { ...drafts };
  delete next[agentId];
  return next;
};

const emptyDraft = (agentId: string, phase: string): TeamLiveDraft => ({
  agentId,
  phase,
  text: "",
  thinking: "",
  done: false,
  startedAt: Date.now(),
  updatedAt: Date.now(),
});

/**
 * Ghost-draft ceiling: a draft whose frames stopped arriving this long ago is
 * dropped on the next reconcile even without an `end` frame. Comfortably above
 * the Rust `TEAM_MODEL_CALL_TIMEOUT` (300s), which always brackets a call with
 * `end` — this only catches a genuinely lost frame.
 */
const DRAFT_MAX_IDLE_MS = 6 * 60_000;

/**
 * Reconcile live drafts against a fresh snapshot — the single rule that makes
 * the streamed copy and the persisted copy of a message NEVER show together.
 * A finished (`done`) draft is dropped as soon as the channel carries an event
 * from the same author that is newer than the draft started — regardless of
 * whether that event arrived via the live broadcast or the safety poll (the
 * poll path previously left the settled draft on screen next to its persisted
 * twin: the "two streams" overlap). A draft with no frames for
 * {@link DRAFT_MAX_IDLE_MS} is a ghost (lost `end`) and is dropped too.
 */
const reconcileDrafts = (
  drafts: Record<string, TeamLiveDraft>,
  snapshot: TeamProjectState | null,
): Record<string, TeamLiveDraft> => {
  const ids = Object.keys(drafts);
  if (ids.length === 0) return drafts;
  const now = Date.now();
  let next: Record<string, TeamLiveDraft> | null = null;
  for (const id of ids) {
    const draft = drafts[id];
    const superseded =
      draft.done &&
      !!snapshot?.channel.some(
        (e) => e.author === id && Date.parse(e.ts) >= draft.startedAt,
      );
    const ghost = now - draft.updatedAt > DRAFT_MAX_IDLE_MS;
    if (superseded || ghost) {
      cancelDraftClear(id);
      if (!next) next = { ...drafts };
      delete next[id];
    }
  }
  return next ?? drafts;
};

/**
 * Fold one live token frame into `liveDrafts`. `start` opens a fresh bubble,
 * `delta` appends text/thinking, `end` marks it settled and schedules a
 * fallback drop (for the build phase, whose authoritative content arrives via
 * the transcript poll rather than a channel event that would clear it).
 */
const ingestStreamFrame = (frame: TeamStreamDelta): void => {
  const { agentId } = frame;
  cancelDraftClear(agentId);

  if (frame.event === "start") {
    useTeamStore.setState((state) => ({
      liveDrafts: { ...state.liveDrafts, [agentId]: emptyDraft(agentId, frame.phase) },
    }));
    return;
  }

  if (frame.event === "end") {
    useTeamStore.setState((state) => {
      const existing = state.liveDrafts[agentId];
      if (!existing) return {} as Partial<TeamStoreState>;
      return {
        liveDrafts: {
          ...state.liveDrafts,
          [agentId]: { ...existing, done: true, updatedAt: Date.now() },
        },
      };
    });
    draftClearTimers[agentId] = setTimeout(() => {
      delete draftClearTimers[agentId];
      useTeamStore.setState((state) => ({
        liveDrafts: withoutDraft(state.liveDrafts, agentId),
      }));
    }, DRAFT_SETTLE_MS);
    return;
  }

  // delta
  if (!frame.delta) return;
  useTeamStore.setState((state) => {
    const existing = state.liveDrafts[agentId] ?? emptyDraft(agentId, frame.phase);
    const next: TeamLiveDraft = {
      ...existing,
      phase: frame.phase || existing.phase,
      done: false,
      updatedAt: Date.now(),
    };
    if (frame.kind === "thinking") {
      next.thinking = existing.thinking + frame.delta;
    } else {
      next.text = existing.text + frame.delta;
    }
    return { liveDrafts: { ...state.liveDrafts, [agentId]: next } };
  });
};

export const useTeamStore = create<TeamStoreState>((set, get) => ({
  repoPath: null,
  projectId: null,
  snapshot: null,
  liveDrafts: {},
  loading: false,
  error: null,

  start: async (repoPath: string) => {
    // Tear down any prior watch first.
    get().stop();
    const token = ++watchToken;
    set({
      repoPath,
      loading: true,
      error: null,
      snapshot: null,
      projectId: null,
      liveDrafts: {},
    });

    // Start the safety-net poll IMMEDIATELY — before any await. The live
    // `team_event` stream travels cross-window and the Tauri `listen` handshake
    // can be slow (or, in a freshly-spawned WebView, briefly hang); if we set
    // the poll up only *after* awaiting the subscription, a slow handshake would
    // leave the window frozen until a manual refresh. Polling first guarantees
    // the view goes live the moment the brain has data, no matter what the event
    // stream does.
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(() => {
      if (token !== watchToken) return;
      void get().refresh();
    }, POLL_INTERVAL_MS);

    try {
      const [projectId, snapshot] = await Promise.all([
        resolveProjectId(repoPath).catch(() => null),
        getTeamState(repoPath, CHANNEL_LIMIT),
      ]);
      if (token !== watchToken) return; // superseded by a newer start()
      set({ snapshot, projectId, loading: false });
    } catch (err) {
      if (token !== watchToken) return;
      set({ loading: false, error: err instanceof Error ? err.message : String(err) });
    }

    // Subscribe to the live stream for instant updates (the poll already
    // guarantees liveness; this just makes it feel real-time). Best-effort and
    // intentionally NOT awaited inline before liveness is established.
    try {
      const unlisten = await subscribeTeamEvents((payload) => {
        if (token !== watchToken) return;
        const { projectId } = get();
        if (projectId && payload.projectId !== projectId) return;
        // The authoritative post from this author supersedes its FINISHED live
        // draft — drop it in the same commit so the streamed copy and the
        // persisted copy never render together. A draft that is still
        // streaming is left alone: mid-run events can be authored FOR an agent
        // while it is generating (e.g. an `ask_owner` reply posted as the
        // owner), and clearing its live draft would restart its bubble from
        // empty mid-message.
        const author = payload.event.author;
        set((state) => {
          const authorDraft = state.liveDrafts[author];
          const dropDraft = !!authorDraft && authorDraft.done;
          if (dropDraft) cancelDraftClear(author);
          return {
            snapshot: appendEvent(state.snapshot, payload.event),
            liveDrafts: dropDraft
              ? withoutDraft(state.liveDrafts, author)
              : state.liveDrafts,
          };
        });
        // Debounced full re-read keeps roster/scope/gate/phase fresh.
        if (refreshTimer) clearTimeout(refreshTimer);
        refreshTimer = setTimeout(() => {
          void get().refresh();
        }, REFRESH_DEBOUNCE_MS);
      }, get().projectId ?? undefined);
      // A newer start()/stop() may have superseded this watch while the Tauri
      // listen handshake was in flight. Adopting the listener now would leak it
      // (stop() already ran, so nothing would ever unlisten) — tear it down
      // immediately instead of stashing it.
      if (token !== watchToken) {
        try {
          unlisten();
        } catch {
          // already torn down
        }
        return;
      }
      unsubscribe = unlisten;
    } catch (err) {
      if (token !== watchToken) return;
      // A failed subscription is non-fatal — the poll keeps the view live.
      set({ error: err instanceof Error ? err.message : String(err) });
    }

    // Live token stream → per-agent drafts. Pure real-time enhancement layered
    // on top of the authoritative snapshot; its failure must never break the
    // view (the persisted events/transcripts still render without it).
    try {
      const streamUnlisten = await subscribeTeamStream((frame) => {
        if (token !== watchToken) return;
        const { projectId } = get();
        if (projectId && frame.projectId !== projectId) return;
        ingestStreamFrame(frame);
      }, get().projectId ?? undefined);
      if (token !== watchToken) {
        try {
          streamUnlisten();
        } catch {
          // already torn down
        }
        return;
      }
      streamUnsubscribe = streamUnlisten;
    } catch {
      // Streaming is optional; ignore and rely on the snapshot + poll.
    }
  },

  refresh: async () => {
    const { repoPath } = get();
    if (!repoPath) return;
    try {
      const snapshot = await getTeamState(repoPath, CHANNEL_LIMIT);
      // Reconcile drafts against the fresh channel in the SAME commit — a
      // persisted message that arrives via this poll must supersede its
      // settled draft exactly like one that arrives via the live broadcast.
      set((state) => ({
        snapshot,
        error: null,
        liveDrafts: reconcileDrafts(state.liveDrafts, snapshot),
      }));
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    }
  },

  clearDraft: (agentId: string) => {
    cancelDraftClear(agentId);
    set((state) => ({ liveDrafts: withoutDraft(state.liveDrafts, agentId) }));
  },

  stop: () => {
    watchToken += 1;
    if (refreshTimer) {
      clearTimeout(refreshTimer);
      refreshTimer = null;
    }
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    if (unsubscribe) {
      try {
        unsubscribe();
      } catch {
        // already torn down
      }
      unsubscribe = null;
    }
    if (streamUnsubscribe) {
      try {
        streamUnsubscribe();
      } catch {
        // already torn down
      }
      streamUnsubscribe = null;
    }
    clearAllDraftTimers();
    set({ liveDrafts: {} });
  },
}));
