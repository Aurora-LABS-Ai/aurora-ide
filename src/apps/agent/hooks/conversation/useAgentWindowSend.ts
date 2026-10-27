/**
 * Agent Window — send pipeline (P4).
 *
 * The IDE's `useAgentSend` is welded to ~10 IDE stores (chat, thread, audit,
 * checkpoint, context, live preview …). The agent window is a
 * separate OS window with its own isolated chat store, so it gets its OWN, much
 * thinner pipeline that:
 *
 *   1. materialises a project-scoped thread on the FIRST send (draft → thread),
 *   2. drives the SAME Rust `agent_chat_v2` runtime via the shared
 *      `AgentService` façade (so tool execution, persistence, and context all
 *      behave exactly like the IDE),
 *   3. streams tokens / thinking / tool calls into `useAgentChatStore` for a
 *      live transcript, then reloads the authoritative JSONL when the turn ends.
 *
 * Tool approval is honoured from the user's settings (auto / deny), with an
 * inline Approve/Reject prompt for `always_ask` tools (the window has no modal).
 *
 * NB: because this is a separate JS context, `getAgentService()` here is a
 * DISTINCT singleton from the IDE's — the two windows never share runtime state.
 *
 * The pieces that do not need the hook's closure live in `send/`: the caller
 * types, the per-message context blocks, the title maker, the turn registry,
 * the reply chips, the mid-turn steer, the manual compaction, the streaming
 * text buffer and the tool timer. This file is the turn itself.
 */

import { useCallback, useRef, useState } from "react";

import { AgentService, threadService } from "@/apps/agent/services";
import { useAgentSettingsStore } from "@/apps/agent/store/settings/useAgentSettingsStore";
import { useAgentThemeStore } from "@/apps/agent/store/ui/useAgentThemeStore";
import {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_OUTPUT_TOKENS,
  resolveModelRequest,
  resolveTemperature,
} from "@/apps/agent/services/runtime/model-request-config";
import type { SendOutcome } from "./send-outcome";
import type {
  AttachedPromptChip,
  DbMessage,
} from "@/apps/agent/services/threads/thread-service";
import {
  effectiveExecutionMode,
  effectiveProjectRoot,
} from "@/apps/agent/services/runtime/agent-execution-mode";
import { resolveThreadModel } from "@/apps/agent/lib/thread/thread-model";
import { imageModelFromSelection } from "@/apps/agent/services/providers/image-providers";
import { recordSuggestionOutcome } from "@/apps/agent/services/providers/reply-suggest-cloud";
import { runDirectImageTurn } from "./direct-image-turn";
import { useAgentSuggestStore } from "@/apps/agent/store/composer/useAgentSuggestStore";
import { useAgentChatStore } from "@/apps/agent/store/conversation/useAgentChatStore";
import { useAgentContextStore } from "@/apps/agent/store/conversation/useAgentContextStore";
import {
  composerImages,
  composerKey,
  useAgentAttachmentStore,
} from "@/apps/agent/store/composer/useAgentAttachmentStore";
import {
  buildCommandSelection,
  composerCommands,
  useAgentCommandStore,
} from "@/apps/agent/store/composer/useAgentCommandStore";
import { isChatPromptCommand, isDirectiveCommand } from "@/apps/agent/adapters/prompt-commands";
import { appendImageMarkers } from "@/apps/agent/lib/render/image-markers";
import {
  buildSelectionContext,
  buildSelectionPills,
  useAgentSelectionStore,
} from "@/apps/agent/store/composer/useAgentSelectionStore";
import { useAgentWorkspaceStore } from "@/apps/agent/store/workspace/useAgentWorkspaceStore";
import { upsertToolEvent } from "@/apps/agent/components/conversation/timeline";
import type {
  AgentWindowSend,
  BackgroundSendTarget,
  BoundConversation,
  PendingApproval,
  SendOptions,
} from "./send/types";
import { estimateTurnUsage } from "./send/turn-usage";
import {
  buildAutoRulesContext,
  buildImageRequest,
  buildMcpDirective,
  buildOpenFilesContext,
  buildRuleContext,
  joinContextBlocks,
} from "./send/context-blocks";
import type { EngineMessageContext } from "@/apps/agent/services/runtime/agent-runtime-client";
import { isFastOn } from "@/apps/agent/lib/model/cursor-fast";
import { maybeGenerateTitle } from "./send/title";
import {
  MODEL_SWITCH_END_TIMEOUT_MS,
  genId,
  nowIso,
  runningAgents,
  threadIsDeepResearch,
  turnModels,
  waitForTurnEnd,
} from "./send/turn-registry";
import { maybeSuggestReplies } from "./send/reply-suggestions";
import { timelineOf } from "./send/stream-text";
import { createTurnWriter } from "./send/turn-writer";
import { stopFollowedTurn } from "./send/followed-turns";
import { steerRunningTurn } from "./send/steer";
import { runManualCompaction } from "./send/compact";

// What the model is told about the path boundary now lives in the system
// prompt (`agent-prompt.ts`, `WORKSPACE_ACCESS_RULES`). It is a setting, so it
// is identical on every request of a conversation and belongs in the cached
// half rather than beside the things that actually change.

export function useAgentWindowSend(bound?: BoundConversation): AgentWindowSend {
  // The conversation this pipeline drives: an explicit binding, else the open
  // chat. Everything below reads THIS rather than `currentThreadId`, which is
  // what lets a docked chat run its own turn without touching the main pane.
  const openThreadId = useAgentChatStore((s) => s.currentThreadId);
  const targetThreadId = bound?.threadId ?? openThreadId;

  // "Sending" means THIS conversation is streaming — a turn running in any
  // other chat must not lock the composer you're looking at.
  const sending = useAgentChatStore(
    (s) => !!targetThreadId && !!s.liveTurns[targetThreadId],
  );
  const [pendingApprovals, setPendingApprovals] = useState<
    Record<string, PendingApproval>
  >({});
  const pendingApproval = targetThreadId
    ? pendingApprovals[targetThreadId] ?? null
    : null;
  // One unresolved `always_ask` promise per running thread. Parallel turns must
  // never overwrite each other's approval resolver.
  const approvalResolversRef = useRef(
    new Map<string, (ok: boolean) => void>(),
  );
  // Latest `send`, so the post-turn auto-flush can resubmit a queued injection
  // as a fresh turn without `send` having to depend on itself.
  const sendRef = useRef<
    | ((
        raw: string,
        target?: BackgroundSendTarget,
        fileChips?: AttachedPromptChip[],
        options?: SendOptions,
      ) => Promise<SendOutcome>)
    | null
  >(null);

  const resolveApproval = useCallback((ok: boolean) => {
    const threadId = targetThreadId;
    if (!threadId) return;
    const resolver = approvalResolversRef.current.get(threadId);
    approvalResolversRef.current.delete(threadId);
    setPendingApprovals((current) => {
      if (!(threadId in current)) return current;
      const next = { ...current };
      delete next[threadId];
      return next;
    });
    resolver?.(ok);
  }, [targetThreadId]);

  const approve = useCallback(() => resolveApproval(true), [resolveApproval]);
  const reject = useCallback(() => resolveApproval(false), [resolveApproval]);
  const approveAlways = useCallback(() => {
    const tool = pendingApproval?.toolName;
    if (tool) useAgentSettingsStore.getState().setToolApproval(tool, "auto");
    resolveApproval(true);
  }, [pendingApproval, resolveApproval]);

  const stop = useCallback(() => {
    // Cancel THIS conversation's turn only — every other running chat, docked
    // or backgrounded, keeps going.
    if (targetThreadId) {
      resolveApproval(false);
      // A turn another client sent is stopped in the runtime directly.
      const agent = runningAgents.get(targetThreadId);
      if (agent) agent.stop();
      else stopFollowedTurn(targetThreadId);
    }
  }, [resolveApproval, targetThreadId]);

  /**
   * Cancel `threadId`'s turn from inside the send pipeline, which is not bound
   * to one thread the way `stop` is. A tool waiting on approval is refused
   * first, or the cancelled turn would sit on that prompt forever.
   */
  const cancelThreadTurn = useCallback((threadId: string) => {
    const resolver = approvalResolversRef.current.get(threadId);
    approvalResolversRef.current.delete(threadId);
    setPendingApprovals((current) => {
      if (!(threadId in current)) return current;
      const next = { ...current };
      delete next[threadId];
      return next;
    });
    resolver?.(false);
    runningAgents.get(threadId)?.stop();
  }, []);

  const compact = useCallback(async () => {
    const store = useAgentChatStore.getState();
    const threadId = targetThreadId;
    const seed = bound ? bound.getSeed() : store.currentThread;
    if (!threadId || !seed || store.liveTurns[threadId]) return;
    await runManualCompaction({
      threadId,
      seed,
      projectRootHint: bound ? bound.projectRoot : store.projectRoot,
    });
  }, [bound, targetThreadId]);

  const sendTurn = useCallback(async (
    raw: string,
    requestedTarget?: BackgroundSendTarget,
    fileChips: AttachedPromptChip[] = [],
    options?: SendOptions,
  ): Promise<SendOutcome> => {
    const content = raw.trim();
    if (!content) return "skipped";
    // Re-seeded below when a model switch ends the running turn first: the
    // seed captured at send time predates whatever that turn wrote since.
    let target = requestedTarget;
    const scopedFileChips =
      useAgentSettingsStore.getState().auroraSurface === "chat" ? [] : fileChips;

    // Did a person press send, or is the pipeline resubmitting on their behalf?
    // Only a human send consumes what a composer staged and may queue mid-turn.
    const fromComposer = !target || target.interactive === true;

    // What the person did with the reply suggestions on offer — tapped one,
    // changed it, typed their own, or sent before they arrived — recorded once
    // against the run that wrote them. Only a person's send says anything
    // about the suggestions; a resubmission does not, and neither does a
    // process or sub-agent report, which arrives through this same function
    // with no target and was being logged as "typed their own" — a
    // `<subagent_report>` envelope as the developer's voice.
    const personSend = fromComposer && (options?.origin ?? "user") === "user";
    if (personSend) {
      const outcomeThread = target ? target.threadId : useAgentChatStore.getState().currentThreadId;
      if (outcomeThread) {
        const outcome = useAgentSuggestStore.getState().takeOutcome(outcomeThread, content);
        if (outcome) recordSuggestionOutcome(outcomeThread, outcome);
      }
    }

    // Which composer's staging tray this turn drains. Composers file under their
    // own thread (`"draft"` before one exists), so a docked chat's send can
    // never pick up what was staged in the main pane — they are different trays
    // that happen to look identical.
    const stageKey = composerKey(
      target ? target.threadId : useAgentChatStore.getState().currentThreadId,
    );

    // A message while a turn runs steers it (see `send/steer.ts`) — unless the
    // conversation's model changed after the turn started. A turn cannot
    // switch model, so steering would give this message to the model the user
    // just moved away from. The running turn is ended instead, and this
    // message starts a fresh turn on the model now chosen (Alvan's call,
    // 2026-10-12: end the turn, never steer across a model change).
    if (fromComposer) {
      const switchFrom = target?.threadId ?? useAgentChatStore.getState().currentThreadId;
      const runningOn = switchFrom ? turnModels.get(switchFrom) : undefined;
      if (
        switchFrom &&
        runningOn &&
        useAgentChatStore.getState().liveTurns[switchFrom] &&
        (options?.model?.trim() || resolveThreadModel(switchFrom)) !== runningOn
      ) {
        cancelThreadTurn(switchFrom);
        if (await waitForTurnEnd(switchFrom, MODEL_SWITCH_END_TIMEOUT_MS)) {
          if (target) {
            // The docked seed was read before the cancelled turn's last
            // writes; the file now holds them.
            const fresh = await threadService.loadThread(switchFrom).catch(() => null);
            if (fresh) target = { ...target, seed: fresh };
          }
        } else {
          console.warn(
            `[agent-window] turn on ${switchFrom} did not end within ` +
              `${MODEL_SWITCH_END_TIMEOUT_MS} ms of a model switch; steering it instead`,
          );
        }
      }
    }
    if (fromComposer) {
      const chat = useAgentChatStore.getState();
      const liveThreadId = target?.threadId ?? chat.currentThreadId;
      if (liveThreadId && chat.liveTurns[liveThreadId]) {
        await steerRunningTurn({
          content,
          liveThreadId,
          stageKey,
          fileChips: scopedFileChips,
          projectRootHint: target?.projectRoot,
        });
        return "queued";
      }
    }

    // Drain any staged image attachments into `<aurora_image>` markers appended
    // to the message. `contentForModel` is what the runtime sees and persists
    // (and what the user bubble renders images from); `content` stays clean for
    // the thread title/preview seed. Attachments are vision-gated at the
    // composer, so they're only present for a vision-capable model.
    const attachments = fromComposer
      ? composerImages(useAgentAttachmentStore.getState(), stageKey)
      : [];
    const contentForModel = appendImageMarkers(content, attachments);
    if (attachments.length > 0) useAgentAttachmentStore.getState().clear(stageKey);

    // Snapshot the inspector picks ONCE, up front: the compact `pills` ride on
    // the user bubble (display), the full `<selected_elements>` block rides to
    // the model via ideContext (below). Clear the composer chips now so the
    // selection isn't reused on the next turn.
    //
    // Still window-global, unlike the trays above: there is ONE inspector (the
    // browser panel), so its picks belong to whichever composer sends next
    // rather than to a particular conversation.
    const picks =
      fromComposer && useAgentSettingsStore.getState().auroraSurface !== "chat"
        ? useAgentSelectionStore.getState().selected
        : [];
    const selectionPills = buildSelectionPills(picks);
    if (picks.length > 0) useAgentSelectionStore.getState().clear();

    // Snapshot the staged `/` directives (skills / rules / MCP) for THIS turn,
    // then clear the chips so they don't ride along on the next message. Skills
    // thread through `explicitSkillKeys`; rules + MCP become context blocks below.
    const allStagedCommands = fromComposer
      ? composerCommands(useAgentCommandStore.getState(), stageKey).filter(
          isDirectiveCommand,
        )
      : [];
    const stagedCommands = allStagedCommands.filter((command) =>
      useAgentSettingsStore.getState().auroraSurface !== "chat" || isChatPromptCommand(command),
    );
    const commandSelection = buildCommandSelection(stagedCommands);
    // Compact chips snapshotted for the user bubble (display only — the
    // directive's effect rides to the model via ideContext / explicitSkillKeys).
    const commandChips = stagedCommands.map((c) => ({
      kind: c.kind,
      title: c.title,
    } satisfies AttachedPromptChip));
    const promptChips = [...scopedFileChips, ...commandChips];
    if (allStagedCommands.length > 0) {
      useAgentCommandStore.getState().clear(stageKey);
    }

    const store = useAgentChatStore.getState();

    const settings = useAgentSettingsStore.getState();

    // Execution mode for this turn. A per-turn override outranks the window's
    // setting, and is how `aurora agent --plan` gets read-only tools. It has to be per-turn: the
    // global setter would leave the window in plan mode after the dispatch
    // finished, and two concurrent dispatches in different modes would each
    // overwrite the other's.
    //
    // Below the override, the CONVERSATION's own mode, then the window's
    // default (what a new chat is born with). Reading only the window's
    // setting let switching one chat to Plan put the chat beside it in Plan.
    const knownThreadId = target?.threadId ?? store.currentThreadId;
    const requestedMode =
      options?.executionMode ??
      (knownThreadId ? store.threadModes[knownThreadId] : undefined) ??
      settings.agentExecutionMode;
    // `aurora agent --plan` can override the Build mode for one turn, but it
    // cannot reach across into Chat: a CLI task addresses a project, and Chat
    // has none. So the surface is applied AFTER the override, not before.
    const executionMode = effectiveExecutionMode(settings.auroraSurface, requestedMode);

    // Bootstrap the thread (create-on-first-send) BEFORE touching the UI so a
    // failed creation doesn't leave a half-rendered turn. Only the main pane can
    // be a draft — a docked chat always addresses a thread that already exists.
    const wasDraft = !target && !store.currentThreadId;
    // A draft has no conversation yet, so its model is the default (or the one
    // a dispatch named). It is handed to the creation so the conversation is
    // born owning it, rather than borrowing the default until a turn ends.
    const threadId =
      target?.threadId ??
      (await store.ensureThreadForSend(
        content,
        wasDraft ? options?.model?.trim() || resolveThreadModel(null) : undefined,
        // The window's default, never a one-turn `--plan` override: that
        // describes this turn, not the conversation.
        wasDraft && settings.agentExecutionMode !== "chat"
          ? settings.agentExecutionMode
          : undefined,
      ));

    // Per-THREAD guard: block a second turn on the SAME thread, but allow other
    // threads to run concurrently (that's the whole point of parallel turns).
    // Reported as `skipped`, never silently: the await above is a window in
    // which another send can open the turn first, and the loser's text is the
    // caller's to keep. Four sub-agent reports arriving together lost one here.
    if (useAgentChatStore.getState().liveTurns[threadId]) return "skipped";

    // The model belongs to the CONVERSATION, so it can only be resolved once we
    // know which thread this turn is for — which is why it's read here and not
    // with the rest of the settings above. Two chats streaming side by side each
    // run on their own model; a chat you haven't given one falls back to the
    // user's default. Resolved at SEND time so a pick made while the composer
    // was focused counts toward this turn.
    //
    // A dispatch that NAMED a model wins outright. It cannot go through the
    // thread: a conversation created for this very send is not in the summary
    // lists yet, so the pin has nowhere to live until the first message lands
    // (see `SendOptions.model`). Reading the thread first would silently run
    // the wrong model, which is exactly the bug this replaced.
    const modelSelection =
      options?.model?.trim() || resolveThreadModel(threadId);

    // Capture the project for THIS turn now — the user may navigate to another
    // project while it runs, and tools must stay rooted at the originating one.
    // A chat turn has none: the window keeps the project so Build can resume on
    // it, and `effectiveProjectRoot` is where that memory stops.
    const projectRoot = effectiveProjectRoot(
      executionMode,
      target?.projectRoot ?? store.projectRoot,
    );

    // The conversation's model IS an image model: the reply is a picture, made
    // by one call, with none of the language-model machinery below (no context
    // blocks, no tools, no stream). Decided here, after the pin is resolved and
    // before the live turn opens, so the two paths share everything up to the
    // point they genuinely differ. The staged `/` chips were consumed above
    // and are not forwarded — an image model cannot read a rule.
    const directImage = imageModelFromSelection(modelSelection, settings.imageProviders);
    if (directImage) {
      await runDirectImageTurn({
        threadId,
        // WITH the attached picture's marker: the tray was already cleared
        // above, so sending bare `content` here silently dropped the picture.
        // The image command splits it off and edits it.
        prompt: contentForModel,
        provider: directImage.provider,
        model: directImage.model,
        modelSelection,
        seed: target?.seed,
        projectRoot,
        executionMode,
      });
      return "started";
    }

    // Open a LIVE turn keyed to this thread. Streaming targets `liveTurns[id]`,
    // so navigating away mid-turn doesn't drop the in-flight work — it keeps
    // running and re-attaches when the user opens this chat again.
    // The mode this turn ACTUALLY runs under, which is not always the
    // window's setting — `aurora agent --plan` overrides it for one turn. The
    // composer reads this so it shows what is running rather than what is
    // configured.
    store.beginTurn(threadId, target?.seed, projectRoot, executionMode);
    turnModels.set(threadId, modelSelection);

    // Reset the turn's running cost. Every request this turn makes folds into
    // it, so a long tool-using turn shows a cost that climbs instead of one
    // that reports only its final request.
    useAgentContextStore.getState().beginTurn(threadId);

    // The checklist is NOT cleared here. Rust owns it and it is durable per
    // thread, so a multi-turn task list must survive into the next turn — the
    // agent is still working through it, and `todo_write` replaces it when a
    // genuinely new list starts.

    // Optimistic opener — the runtime re-persists this verbatim, so the
    // reload at the end reconciles it to the authoritative id.
    //
    // A turn Aurora started because a background process ended has no user
    // bubble — nobody typed "Failed pnpm test · exit 1". It gets a `process`
    // row instead, the exact shape `threads.rs` rebuilds from the persisted
    // `ProcessEvent` block, and `buildTurns` turns that row into a fresh
    // assistant turn whose first line is the beat. The row is what gives the
    // reply its own turn: seeding the beat into the streaming message with
    // no row above it left that message consecutive with the previous
    // reply, the two merged, and the answer streamed into a bubble that had
    // already settled and scrolled past. Live and reloaded now disagree
    // about nothing.
    if (options?.origin === "process") {
      store.appendTurnMessage(threadId, {
        id: genId(),
        role: "process",
        content: options.summary?.trim() || contentForModel,
        timestamp: nowIso(),
      });
    } else if (options?.origin === "subagent") {
      // A sub-agent's report woke this conversation. Same shape `threads.rs`
      // rebuilds from the persisted `AgentReport` block: a row of its own
      // role, whose timeline carries the card's data, so live and reloaded
      // draw the same agent card at the head of a fresh turn.
      const agent = options.agent;
      store.appendTurnMessage(threadId, {
        id: genId(),
        role: "agent_report",
        content: options.summary?.trim() || contentForModel,
        timestamp: nowIso(),
        timeline: [
          {
            kind: "agent_report",
            id: genId(),
            agentId: agent?.agentId ?? "",
            name: agent?.name ?? null,
            status: agent?.status ?? "completed",
            summary: options.summary?.trim() || "",
            detail: contentForModel,
            arrivedLive: true,
          },
        ],
      } as DbMessage);
    } else {
      store.appendTurnMessage(threadId, {
        id: genId(),
        role: "user",
        content: contentForModel,
        attachedSelectedElements: selectionPills.length > 0 ? selectionPills : undefined,
        attachedCommands: commandChips.length > 0 ? commandChips : undefined,
        attachedPromptChips: promptChips.length > 0 ? promptChips : undefined,
        timestamp: nowIso(),
      });
    }

    // AI title maker — ONLY for the first message of a NEW chat (never existing
    // threads). Fire-and-forget so it never blocks the turn; on success it
    // replaces the derived title in meta + UI, on any error the derived title
    // stands. Disabled or unconfigured → skipped entirely (no-op).
    if (wasDraft) {
      void maybeGenerateTitle(threadId, content);
    }

    // Resolve every model-specific request choice before doing the expensive
    // context work below. Cursor resolution is exact and can fail when a saved
    // combination no longer exists on the account. Surface that as a
    // recoverable assistant message and close the optimistic turn cleanly.
    let resolvedRequest: ReturnType<typeof resolveModelRequest>;
    try {
      // This is the SAME resolver the per-model connection test calls. It
      // applies the model-level API format, the typed reasoning request, and
      // provider-native variants once. Keeping a second hand-built path here
      // is how tests passed on one wire while real turns ran on another.
      resolvedRequest = resolveModelRequest(modelSelection, settings.thinkingEnabled);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      store.appendTurnMessage(threadId, {
        id: genId(),
        role: "assistant",
        content: `Cursor couldn't start this turn.\n\n${detail}`,
        timestamp: nowIso(),
      });
      store.endTurn(threadId);
      // A turn opened and ended with the reason on screen. `started`, not
      // `skipped`: a caller that retried on this would loop on a dead provider.
      return "started";
    }
    if (!resolvedRequest) {
      store.appendTurnMessage(threadId, {
        id: genId(),
        role: "assistant",
        content:
          "This chat's model is no longer available, or no provider is configured. Choose a model in Settings → Providers and try again.",
        timestamp: nowIso(),
      });
      store.endTurn(threadId);
      return "started";
    }
    const {
      providerConfig,
      model: activeModel,
      reasoning,
      thinkingEnabled,
      thinkingBudgetTokens,
    } = resolvedRequest;
    // The model this turn's requests are billed against. Use the row the
    // resolver actually selected (important when a deleted pin fell back),
    // while keeping Cursor's composed wire id out of durable accounting.
    const turnModel = activeModel
      ? `${activeModel.providerId}:${activeModel.modelKey}`
      : `${providerConfig.id}:${providerConfig.model}`;

    let compactionProvider;
    try {
      compactionProvider = settings.compactionModel
        ? resolveModelRequest(settings.compactionModel, settings.thinkingEnabled)
            ?.providerConfig
        : undefined;
    } catch {
      // Keep the chat usable when a pinned auxiliary Cursor variant vanished;
      // the Rust runtime will summarize on this conversation's own model.
      compactionProvider = undefined;
    }

    // The streaming assistant target. It follows the opener row appended
    // above — a user bubble or a process row — and `buildTurns` merges it
    // into the turn that row opened, whichever kind it was.
    const assistantId = genId();
    const assistantSeed: DbMessage = {
      id: assistantId,
      role: "assistant",
      content: "",
      timestamp: nowIso(),
      tool_calls: [],
      timeline: [],
    };
    store.appendTurnMessage(threadId, assistantSeed);

    // Everything the stream writes into the transcript (`send/turn-writer.ts`),
    // shared with a window following this turn from another client. What
    // stays here is what only the sender does: usage for the ring, approval,
    // and the end-of-turn hand-off.
    const writer = createTurnWriter(threadId, assistantId);
    const { patchMessage, timer } = writer;

    // The checklist is NOT mirrored from tool-call arguments any more. Rust
    // emits `agent_todo_write` after every todo tool call and
    // `useAgentTaskStore` subscribes to it, so `todo_update` and `todo_write`
    // both move the panel. Parsing args here only ever saw `todo_write`, which
    // is why the panel froze at 0/N while the agent worked the list.

    // The workspace path and the access rules used to ride here, and they do
    // not belong: neither changes while a conversation runs, so re-sending
    // them every time the checklist or the open files moved was pure repeat.
    // They are stated once in the cached system prompt now — see
    // `formatEnvironment`, which follows OpenCode's split of session-fixed
    // facts from per-turn state.

    // Full element context for the model (located by the snapshot taken above).
    // The block tells the agent to locate each element's source file.
    const selectionBlock = buildSelectionContext(picks);

    // `/`-directive context: skills are resolved from `explicitSkillKeys` in the
    // system prompt, but rules + MCP have no native channel here — so we surface
    // the user's selected project rules verbatim and nudge toward the named MCP
    // servers, both as authoritative IDE context blocks.
    const ruleBlock = await buildRuleContext(
      projectRoot,
      commandSelection.ruleFilenames,
    );
    const mcpBlock = buildMcpDirective(commandSelection.mcpServerNames);
    const imageBlock = buildImageRequest(commandSelection.imageRequested);

    // Standing `.aurora/*.md` project rules — capped, with `/`-attached rules
    // excluded since they already ride verbatim above. They go to the SYSTEM
    // PROMPT (via `promptContext.projectRules`), where every reference agent
    // keeps its instruction files: the same bytes on every request of the
    // conversation, inside the cached prefix. They used to ride in the
    // per-message context on the first message only, which put a standing
    // rule where a one-off fact belongs and lost it after a compaction.
    //
    // The skill catalogue and `/`-attached skills are composed into the
    // system prompt by `composeAgentSystemPrompt` from the same
    // `explicitSkillKeys`; nothing about skills is built here any more.
    const autoRulesBlock = await buildAutoRulesContext(
      projectRoot,
      commandSelection.ruleFilenames,
    );

    // What the user actually has open in the right dock. Rides on every turn
    // (it changes as they browse) and costs one line per file, because it
    // carries names and never content.
    //
    // Source is the DOCK TAB list, not the file tree's selection. Opening a
    // file from the tree creates its own tab (`openFileTab`), several files can
    // be open at once, and the tree's `selectedPath` is a different thing that
    // does not survive switching tabs — wiring to it produced a block that was
    // simply never there, which the agent reported verbatim: "this turn didn't
    // include the <open_files> block".
    const dock = useAgentWorkspaceStore.getState();
    const fileTabs =
      executionMode === "chat"
        ? []
        : dock.tabs.filter(
            (tab) => tab.kind === "file" && typeof tab.path === "string" && tab.path,
          );
    const activeFilePath =
      fileTabs.find((tab) => tab.id === dock.activeTabId)?.path ?? null;
    const openFilesBlock = buildOpenFilesContext(
      fileTabs.map((tab) => tab.path as string),
      activeFilePath,
    );

    // What belongs to THIS message and nothing else: where the user's
    // attention is and what they attached to it. The runtime saves it on the
    // message as its `aurora_context`, the model reads it after the user's
    // words, and it never changes again. Standing facts (rules, skills, the
    // mode) are in the system prompt — putting them here
    // meant a copy of the project rules in every message's saved context.
    const ideContext = joinContextBlocks([
      openFilesBlock,
      selectionBlock,
      ruleBlock,
      mcpBlock,
      imageBlock,
    ]);
    // The same facts, for the engine to build that text itself (Phase 3.5,
    // shadow for now: the engine compares its text with `ideContext`).
    const messageContext: EngineMessageContext = {
      openFiles: fileTabs.map((tab) => tab.path as string),
      activeFile: activeFilePath,
      pickedElements: picks.map((pick) => ({ index: pick.index, element: pick.element })),
      mcpServerNames: commandSelection.mcpServerNames,
      imageRequested: commandSelection.imageRequested,
    };

    // Per-model reasoning: the active model may carry an effort, toggle, or
    // budget profile set in Provider settings / the composer picker. The
    // provider-neutral profile is already resolved above; the Rust adapter
    // translates it into the selected API format.
    // THIS turn's model row, not the globally-active one: reasoning config
    // (effort tier / thinking budget) hangs off the model, so reading the
    // active row would apply another conversation's reasoning settings here.
    // Track whether the provider ever reported token usage this turn. If it
    // doesn't (many OpenAI-compatible backends skip `stream_options.include_usage`),
    // we fall back to a local tiktoken estimate so the context ring still shows.
    let usageFired = false;

    // A DEDICATED service instance for this turn so concurrent turns on other
    // threads keep their own client/config. Registered so `stop()` can target it.
    const agent = new AgentService();
    runningAgents.set(threadId, agent);
    // A new message supersedes the previous turn's reply chips immediately.
    useAgentSuggestStore.getState().clear(threadId);
    agent.setProvider(providerConfig);
    agent.setThreadId(threadId);
    agent.updateConfig({
      reasoning,
      // Backward-compatible mirrors for older runtime payload readers. Both
      // are derived from `reasoning`; no second resolution happens here.
      thinkingEnabled,
      thinkingBudgetTokens,
      executionMode,
      autoApproveTools: settings.autoApproveTools,
      // Pin tools to THIS turn's project (not the global store) so a turn keeps
      // operating on its own directory even after the user switches projects.
      workspacePath: projectRoot,
      // What the conversation is on, as opposed to what the request carries.
      // `applyCursorVariant` above folds the effort tier and Fast into
      // `providerConfig.model`; that composed id is a wire detail and must not
      // become the thread's model, or the row holding this model's context
      // window stops matching it.
      modelSelection,
      // Model → provider → Aurora's default. Set per model in Settings →
      // Providers; stripped in the Rust adapter for models that reject
      // sampling, so a value on a Claude 5 row costs nothing.
      temperature: resolveTemperature(activeModel, providerConfig.defaultTemperature),
      maxTokens:
        providerConfig.defaultMaxTokens ??
        providerConfig.maxOutputTokens ??
        DEFAULT_MAX_OUTPUT_TOKENS,
      // Agentic by design: no artificial tool-call cap — the runtime stops when
      // the model stops requesting tools.
      maxToolIterations: undefined,
      getToolApproval: settings.getToolApproval,
      // Context compaction (Settings → Agent). The runtime summarizes older
      // history into a persistent marker once the projected request crosses
      // the threshold; the summary budget caps the summarization call.
      compactionThresholdPct: settings.compactionThresholdPct,
      compactionSummaryBudget: settings.compactionSummaryBudget,
      // `null` when nothing is pinned (or the pin points at a deleted
      // provider) → the runtime summarizes on the conversation's own model.
      compactionProvider,
      workspaceAccess: settings.workspaceAccess,
      // Read once, here, for BOTH the tool roster and the prompt instruction —
      // this config field is what `AgentService` hands to
      // `composeAgentSystemPrompt` AND what the runtime client forwards to Rust,
      // so a turn can never have the tool without the instruction or vice versa.
      transcriptChapters: settings.transcriptChapters,
      // Transcript → Reply layout lives with the other transcript switches in
      // the theme store (it is how a reply is drawn); read per turn so the
      // instruction follows the switch from the next message on.
      replyLayout: useAgentThemeStore.getState().transcriptReplyLayout,
      browserTools: settings.browserTools,
      subagentsEnabled: settings.subagentsEnabled,
      subagentModel: settings.subagentModel,
      deferTools: settings.deferTools,
      // Aurora Chat's `generate_image` reads these on the Rust side. Read per
      // turn, like every other setting here, so a provider added or fixed in
      // Settings is usable from the very next message.
      imageProviders: executionMode === "chat" ? settings.imageProviders : undefined,
      // From the CONVERSATION, never from `deepResearchNext`. That setting only
      // decides what a new chat is born with; an open chat carries its own
      // answer, and reading the setting here would let flipping it change a
      // conversation that was framed the other way — and throw its prompt cache
      // away in the bargain.
      deepResearch: threadIsDeepResearch(threadId),
    });

    try {
      await agent.chat(
        contentForModel,
        {
          ...writer.callbacks,
          onUsage: (usage) => {
            usageFired = true;
            const context = useAgentContextStore.getState();
            // The context ring wants the LATEST request (each one resends the
            // whole history, so its input size IS the window occupancy). The
            // model travels with it: the ring holds a high-water reading, and
            // a reading from another tokenizer is not comparable to this one.
            context.setUsage(threadId, usage, turnModel);
            // The cost card wants the SUM: a turn makes one request per tool
            // iteration, and only adding them up gives what the turn actually
            // cost. Attributed to the model running this turn so a later
            // model switch prices its own requests, not these.
            context.addTurnUsage(threadId, turnModel, usage);
            // The conversation total is read from the transcript, and the
            // transcript just grew by this request. Marking it stale PER
            // REQUEST — not only at turn end — is what stops "This chat" from
            // reporting a figure that predates the turn you are watching: it
            // used to sit at the last completed turn's total, so a card opened
            // mid-turn showed a chat cost missing both the running turn and any
            // compaction it triggered. Marking is free; the refetch happens
            // only while the card is actually open.
            context.invalidateBreakdown(threadId);
            writer.addUsage(usage);
          },
          onToolApprovalRequired: async (tc) => {
            const approvalBegan = performance.now();
            try {
              const mode = settings.getToolApproval(tc.function.name);
              if (settings.autoApproveTools || mode === "auto") return true;
              if (mode === "deny") return false;
              // always_ask → block on the inline prompt.
              return await new Promise<boolean>((resolve) => {
                approvalResolversRef.current.get(threadId)?.(false);
                approvalResolversRef.current.set(threadId, resolve);
                setPendingApprovals((current) => ({
                  ...current,
                  [threadId]: {
                    id: tc.id,
                    toolName: tc.function.name,
                    args: tc.function.arguments || "",
                  },
                }));
              });
            } finally {
              // Native tools are already timing (execution_start precedes their
              // gate) — log the wait so it's excluded from the tool's duration.
              const approvalEnded = performance.now();
              timer.noteApproval(tc.id, approvalBegan, approvalEnded);
              // Push the card's clock forward by the same wait. Without this a
              // command approved after thinking about it for a minute would
              // read "1m 4s" while running and then settle to "4s" — the same
              // call contradicting itself as it finishes.
              const waited = Math.max(0, approvalEnded - approvalBegan);
              if (waited > 0) {
                patchMessage(assistantId, (m) => {
                  const calls = (m.tool_calls ?? []).map((c) =>
                    c.id === tc.id && c.startedAt !== undefined
                      ? { ...c, startedAt: c.startedAt + waited }
                      : c,
                  );
                  const updated = calls.find((c) => c.id === tc.id);
                  // The timeline holds the copy the card renders, so patching
                  // `tool_calls` alone would move nothing on screen.
                  return {
                    ...m,
                    tool_calls: calls,
                    timeline: updated
                      ? upsertToolEvent(timelineOf(m), updated)
                      : timelineOf(m),
                  };
                });
              }
            }
          },
        },
        undefined,
        ideContext,
        {
          userMessage: contentForModel,
          // Only ever `"process"` for the idle background report — see
          // `SendOptions.origin`. Nothing else about the request changes with
          // it, so the turn appends to the cached prefix like any other.
          userMessageOrigin: options?.origin ?? "user",
          userMessageSummary: options?.summary ?? null,
          userMessageAgent: options?.agent ?? null,
          workspacePath: projectRoot ?? undefined,
          isFirstMessage: wasDraft,
          // `/`-attached skills → resolved into the system prompt as explicit,
          // authoritative skills for this turn (works for any skill, toggled on
          // or not).
          explicitSkillKeys:
            commandSelection.explicitSkillKeys.length > 0
              ? commandSelection.explicitSkillKeys
              : undefined,
          // Standing facts for the system prompt: the project's rules.
          projectRules: autoRulesBlock,
          attachedRuleFiles: commandSelection.ruleFilenames,
          messageContext,
          // The one input of the model choice the engine cannot read itself.
          modelFacts: { cursorFast: activeModel ? isFastOn(activeModel.id) : null },
          // Persist the inspector chips natively onto the user message in the
          // session JSONL so they re-render above the bubble on reopen.
          attachedSelectedElements: selectionPills.length > 0 ? selectionPills : null,
          attachedPromptChips: promptChips.length > 0 ? promptChips : null,
          // Set only when a terminal dispatched this turn (`aurora agent`).
          // Rust uses it to tee the turn's events into the task's transcript
          // so `--follow` watches the same work this window is rendering.
          cliTaskId: options?.cliTaskId ?? target?.cliTaskId ?? null,
        },
      );

      // Provider reported nothing this turn → estimate locally so the context
      // ring still reflects usage (flagged `~` in the UI). Skipped entirely when
      // a real `usage` event already landed. We also PERSIST the estimate so the
      // ring survives reopening the thread (the runtime only persists usage it
      // actually received from the provider).
      if (!usageFired) {
        useAgentChatStore.getState().flushTurnPatches();
        const liveMsgs =
          useAgentChatStore.getState().liveTurns[threadId]?.messages ?? [];
        const contextWindow = providerConfig.contextWindow || DEFAULT_CONTEXT_WINDOW;
        const estMaxOutput =
          providerConfig.defaultMaxTokens ??
          providerConfig.maxOutputTokens ??
          DEFAULT_MAX_OUTPUT_TOKENS;
        const est = await estimateTurnUsage(
          liveMsgs,
          providerConfig.model,
          contextWindow,
          estMaxOutput,
          agent.getLastPromptOverhead(),
        );
        if (est && !usageFired) {
          useAgentContextStore.getState().setUsage(threadId, est);
          // Persist the same four disjoint slices the live ContextRing sums.
          // Otherwise reopening the thread could replace the live reading with
          // a smaller snapshot that silently dropped output/cache-write tokens.
          const usedTokens =
            est.promptTokens +
            est.completionTokens +
            (est.cacheReadTokens ?? 0) +
            (est.cacheWriteTokens ?? 0);
          void threadService
            .updateUsage(threadId, est, {
              usedTokens,
              contextWindow,
              percentage: Math.min(100, Math.round((usedTokens / contextWindow) * 100)),
            })
            .catch(() => {
              /* best-effort persistence; the live ring already updated */
            });
        }
      }
      // Turn settled cleanly → offer tappable follow-up replies (async, never
      // blocks teardown; errored/cancelled turns skip this by construction).
      maybeSuggestReplies(threadId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!/cancel|abort/i.test(message)) {
        console.error("[agent-window] turn failed:", err);
      }
    } finally {
      const unresolvedApproval = approvalResolversRef.current.get(threadId);
      approvalResolversRef.current.delete(threadId);
      unresolvedApproval?.(false);
      setPendingApprovals((current) => {
        if (!(threadId in current)) return current;
        const next = { ...current };
        delete next[threadId];
        return next;
      });
      // The transcript on disk just gained this turn's requests, so the stored
      // conversation total is out of date. Marked rather than re-read: a
      // background turn on a chat nobody is looking at should not pay for a
      // transcript parse. The card re-reads on its next open.
      //
      // In `finally` on purpose — a cancelled or failed turn still spent
      // tokens on every request it completed, and a total that quietly omits
      // them is exactly the kind of wrong this work exists to remove.
      useAgentContextStore.getState().invalidateBreakdown(threadId);
      // Land the stream's tail and stamp the message with when it settled.
      writer.settle();
      const s = useAgentChatStore.getState();
      // The settle patch above is queued; the turn is read back below.
      s.flushTurnPatches();
      const settledThread = useAgentChatStore.getState().liveTurns[threadId];
      runningAgents.delete(threadId);
      turnModels.delete(threadId);
      // Order matters: refresh the rail (which pulls THIS thread's now-persisted
      // row into `allThreads`) BEFORE closing the live turn. The rail dedupes a
      // live row against its persisted twin by thread id, so doing the disk
      // refresh first means the row is already present under its persisted form
      // when `endTurn` removes the live one — the chat never blinks out of the
      // rail during the hand-off. (The runtime persisted message #1 up front, so
      // a fresh chat is already listable here; this just swaps the live view for
      // the authoritative on-disk record.)
      //
      // We deliberately do NOT reload the open transcript from disk: the
      // optimistic messages already hold the full turn (thinking + tools +
      // content); a reload would swap every message for fresh ids → React
      // remounts the whole list (tool groups hard-collapse, view jumps up). Disk
      // stays authoritative on the NEXT open of this thread.
      await s.refreshThreads();
      // Close THIS thread's live turn (clears its rail spinner + drops the
      // global `sending` when no other turn remains).
      s.endTurn(threadId);
      // Completion cue: flash the header with this chat's title and — if the
      // turn finished in the background (another chat is open) — drop a "done"
      // dot on its rail row / project until the user opens it.
      s.noteTurnComplete(threadId);
      // The checklist is NOT settled here. Marking whatever the model left open
      // as "completed" invented completions the agent never reported — a task
      // it abandoned would show a tick. An item left in_progress by a finished
      // turn is *paused*, and the panel renders it that way (see
      // `AgentTaskPanel`), which is the truth and is recoverable: the next turn
      // picks the same list back up from disk.

      // Auto-flush a still-pending injection: if the turn ended before the
      // runtime hit a tool-result boundary to drain the queue, the message
      // would otherwise sit in the pill forever. Submit it as a fresh turn so
      // it's never silently lost (mirrors the IDE). Cleared first so it can't
      // double-fire; the Rust slot is also cleared (idempotent).
      const stillQueued = useAgentChatStore.getState().queuedByThread[threadId];
      if (stillQueued) {
        // Clear the Rust slot FIRST (awaited) so the fresh turn below can't
        // drain a stale copy and inject it twice, then resubmit as a new turn.
        // The MODEL copy is what resubmits — a steered message's directive
        // block must not evaporate because the turn ended before a tool
        // boundary; the chips ride along so the bubble renders its pills.
        useAgentChatStore.getState().clearQueuedMessage(threadId);
        await useAgentChatStore.getState().cancelQueuedMessage(threadId);
        if (settledThread) {
          void sendRef.current?.(
            stillQueued.modelText ?? stillQueued.text,
            {
              threadId,
              projectRoot,
              seed: settledThread,
            },
            stillQueued.chips,
          );
        }
      }
    }
    return "started";
  }, [cancelThreadTurn]);

  // Keep the ref pointing at the latest `send` so the post-turn auto-flush can
  // resubmit a queued injection without `send` depending on itself.
  sendRef.current = sendTurn;

  const send = useCallback(
    (text: string, fileChips?: AttachedPromptChip[], options?: SendOptions) => {
      // `options` rides alongside the target rather than inside it: a CLI
      // dispatch sends into the OPEN chat (it selects its thread first), so it
      // has no target to attach anything to.
      if (!bound) return sendTurn(text, undefined, fileChips, options);
      // A docked chat addresses its own thread explicitly. The seed is read
      // NOW (not at mount) so the live turn opens on the transcript actually on
      // screen; a live turn already in flight is the newer one, so it wins.
      const live = useAgentChatStore.getState().liveTurns[bound.threadId];
      const seed = live ?? bound.getSeed();
      if (!seed) return Promise.resolve<SendOutcome>("skipped");
      return sendTurn(
        text,
        {
          threadId: bound.threadId,
          projectRoot: bound.projectRoot,
          seed,
          interactive: true,
        },
        fileChips,
        options,
      );
    },
    [sendTurn, bound],
  );

  return {
    sending,
    send,
    compact,
    stop,
    pendingApproval,
    approve,
    approveAlways,
    reject,
  };
}
