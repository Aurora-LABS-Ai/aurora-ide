/**
 * Agent Window — send pipeline: writing a running turn into the transcript.
 *
 * One streaming assistant message per turn, patched from the runtime's
 * stream: text and thinking, tool calls and their results, compaction
 * markers, notices, reconnects, mid-turn injections. Two clients write a turn
 * this way and must draw it the same: the window that sent the message
 * (`useAgentWindowSend`) and a window following a turn another client sent
 * (`hooks/window/follow-turn.ts`). What only the sender does (usage
 * accounting for the ring, tool approval, the end-of-turn hand-off) stays
 * with the sender.
 */

import type { ToolCallRequest } from "@/apps/agent/services";
import type { AgentRuntimeCallbacks } from "@/apps/agent/services/runtime/agent-runtime-client";
import type { DbMessage, TokenUsage } from "@/apps/agent/services/threads/thread-service";
import { classifyError } from "@/apps/agent/lib/error-classifier";
import { useAgentChatStore } from "@/apps/agent/store/conversation/useAgentChatStore";
import { useAgentContextStore } from "@/apps/agent/store/conversation/useAgentContextStore";
import {
  parseKillResult,
  parseSpawnResult,
  useAgentBackgroundStore,
} from "@/apps/agent/store/conversation/useAgentBackgroundStore";
import { useAgentArtifactStore } from "@/apps/agent/store/artifacts/useAgentArtifactStore";
import {
  appendAgentReport,
  appendCompaction,
  appendContent,
  appendNotice,
  appendProcessBeat,
  appendUserInjection,
  beginReconnect,
  clearReconnect,
  finishCompaction,
  nextEventId,
  textOf,
  upsertToolEvent,
} from "@/apps/agent/components/conversation/timeline";
import { describeToolActivity, type AgentActivity } from "@/apps/agent/components/conversation/activity";
import { createStreamText, timelineOf, type StreamText } from "./stream-text";
import { createToolTimer, type ToolTimer } from "./tool-timing";
import { nowIso } from "./turn-registry";

/** The stream callbacks a writer answers; the sender adds its own beside them. */
export type TurnWriterCallbacks = Required<
  Pick<
    AgentRuntimeCallbacks,
    | "onToken"
    | "onThinking"
    | "onQueuedMessageInjected"
    | "onCompactionStarted"
    | "onCompactionCompleted"
    | "onCompactionFailed"
    | "onToolCall"
    | "onToolExecutionStart"
    | "onToolExecutionComplete"
    | "onToolExecutionError"
    | "onToolRejected"
    | "onRuntimeNotice"
    | "onStreamAttemptStarted"
    | "onPartialReplyDiscarded"
    | "onError"
  >
>;

export interface TurnWriter {
  callbacks: TurnWriterCallbacks;
  stream: StreamText;
  timer: ToolTimer;
  patchMessage: (id: string, patch: (m: DbMessage) => DbMessage) => void;
  setActivity: (activity: AgentActivity) => void;
  /** Add one request's tokens to the turn summary on the streaming message. */
  addUsage: (usage: TokenUsage) => void;
  /** Land the stream's tail and stamp the message with the moment it settled. */
  settle: () => void;
}

/** Write `threadId`'s running turn into its streaming message `assistantId`. */
export function createTurnWriter(threadId: string, assistantId: string): TurnWriter {
  let streamAttemptCheckpoint: DbMessage | null = null;
  // The live compaction timeline-event id, set when a compaction starts mid-
  // turn so its completion can flip the same inline marker (before→after,
  // stop shimmer). It rides INSIDE the streaming assistant message's timeline
  // so content streamed after compaction renders below the marker.
  let compactionEventId: string | null = null;
  // Runtime notices already shown inline this turn. A failure the runtime
  // announces first and then fails on (a dropped stream) arrives twice —
  // once as the notice event, once as the rejection — and must only be said
  // once. Scoped per turn so a later turn can legitimately repeat it.
  const noticedMessages = new Set<string>();

  // Every streaming write is queued for the next frame and lands together
  // with every other conversation's in one store update (`queueTurnPatch`).
  // Patches still apply in the order they are made, so a patch that reads
  // the message (the stream checkpoint below) sees exactly what came before.
  // Anything that READS the live turn back synchronously must call
  // `flushTurnPatches()` first.
  const queueTurn = useAgentChatStore.getState().queueTurnPatch;
  const patchMessage = (id: string, patch: (m: DbMessage) => DbMessage) =>
    queueTurn(threadId, id, patch);
  // Header narrator: a short, plain-language line of what the agent is doing
  // right now. Written on phase changes (thinking → tool → responding); the
  // store setter no-ops when unchanged, so calling it per token is free.
  const setActivity = (activity: AgentActivity) =>
    useAgentChatStore.getState().setThreadActivity(threadId, activity);

  // Streaming text lands in frame-sized buffers (`stream-text.ts`); anything
  // that appends a non-text timeline event flushes first so the ordered
  // timeline stays exact.
  const stream = createStreamText((patch) => patchMessage(assistantId, patch));
  // Wall-clock per tool call, approval waits taken out (`tool-timing.ts`).
  const timer = createToolTimer();

  const upsertToolCall = (tc: ToolCallRequest, result?: string | null, startedAt?: number) => {
    // Keep timeline order exact: buffered text lands BEFORE this tool event.
    stream.flush();
    patchMessage(assistantId, (m) => {
      const calls = m.tool_calls ? [...m.tool_calls] : [];
      const idx = calls.findIndex((c) => c.id === tc.id);
      const next = {
        id: tc.id,
        name: tc.function.name,
        arguments: tc.function.arguments || "",
        result: result !== undefined ? result : idx >= 0 ? calls[idx].result : null,
        durationMs: idx >= 0 ? calls[idx].durationMs : undefined,
        // This object is rebuilt from scratch on every argument delta, so a
        // field that is not carried forward here is a field that is wiped
        // dozens of times per call.
        startedAt: startedAt ?? (idx >= 0 ? calls[idx].startedAt : undefined),
      };
      if (idx >= 0) calls[idx] = next;
      else calls.push(next);
      // A tool starting means the reasoning phase is over — collapse it
      // (mirrors the IDE flipping `isThinking` off once work begins). The
      // tool is also appended to the ORDERED timeline so it renders in the
      // exact spot the model emitted it (between content segments).
      return {
        ...m,
        tool_calls: calls,
        isThinking: false,
        // `clearReconnect` for the case where the recovered attempt opens
        // with a tool call instead of text — the text flush is the usual
        // place the marker goes, and it never runs on that path.
        timeline: upsertToolEvent(clearReconnect(timelineOf(m)), next),
      };
    });
  };

  // `shell_spawn` starts something that outlives the tool call, so the user
  // needs a way to see and stop it. Mirror the spawn into the per-thread
  // background store, which drives the cards docked above the composer; a
  // `shell_kill` settles the matching card so it stops claiming to run.
  const captureBackgroundProcess = (tc: ToolCallRequest, result: string) => {
    if (tc.function.name === "shell_spawn") {
      const spawned = parseSpawnResult(result);
      if (spawned) useAgentBackgroundStore.getState().track(threadId, spawned);
      return;
    }
    if (tc.function.name === "shell_kill") {
      const killed = parseKillResult(result);
      // "stopped", not "exited": the agent ended it deliberately, which is
      // also what the log's closing line says. A row reporting a natural
      // finish for a kill would contradict the file.
      if (killed) useAgentBackgroundStore.getState().settle(killed, "stopped");
    }
  };

  // `generate_image` lands its picture on the Canvas from the Rust side, so
  // the artifact store has not seen it. Re-read the bundle on success (an
  // error result is a sentinel string, never a marker) so the card's "Open in
  // Canvas" finds the entry and the dock's Canvas tab lists it without a
  // reload. Fire-and-forget: the tool already succeeded.
  const captureCanvasWrite = (tc: ToolCallRequest, result: string) => {
    if (tc.function.name !== "generate_image") return;
    if (result.trimStart().startsWith("[error]")) return;
    void useAgentArtifactStore.getState().absorbRuntimeWrite(threadId);
  };

  const setToolResult = (tc: ToolCallRequest, result: string, durationMs?: number) => {
    stream.flush();
    patchMessage(assistantId, (m) => {
      const calls = (m.tool_calls ?? []).map((c) =>
        c.id === tc.id ? { ...c, result, durationMs: durationMs ?? c.durationMs } : c,
      );
      const updated = calls.find((c) => c.id === tc.id);
      return {
        ...m,
        tool_calls: calls,
        timeline: updated ? upsertToolEvent(timelineOf(m), updated) : timelineOf(m),
      };
    });
  };

  const callbacks: TurnWriterCallbacks = {
    onToken: (token) => {
      // Final-answer text is streaming — the narrator reads "Responding…".
      setActivity({ label: "Responding…" });
      stream.queue("content", token);
    },
    onThinking: (text) => {
      setActivity({ label: "Thinking…" });
      // A zero-length thinking event carries no renderable text — the
      // Anthropic adapter emits one at `content_block_stop` purely to
      // hand over the block signature, which the UI has no use for.
      // Appending it would open an empty reasoning segment that renders
      // as a bare "…" (AgentThinkingBlock's `content || "…"` fallback),
      // and after a tool row it can't merge into a prior segment so it
      // becomes its own stray row.
      if (!text) return;
      stream.queue("thinking", text);
    },
    onQueuedMessageInjected: (text, chips, origin, agent, detail) => {
      // The runtime drained the queue and stapled the user's text onto the
      // tool message it's about to send. Render it inline in the streaming
      // assistant message — after the tool result, before the agent
      // continues — so the order matches what the model saw. No separate
      // user bubble (that would land after the streaming message and read
      // as if the agent replied before the user spoke). Then drop the pill.
      // `text` is the display copy; `chips` re-render the composer pills.
      //
      // The same slot also carries machine events — a background process
      // ending or being stopped. Those are nobody's words, so they get
      // the checklist beat's one-line row instead of the user's, and they
      // never touch the composer pill (they never lit it).
      stream.flush();
      if (origin === "process") {
        patchMessage(assistantId, (m) => ({
          ...m,
          timeline: appendProcessBeat(timelineOf(m), text),
        }));
        return;
      }
      if (origin === "subagent") {
        // A sub-agent reported back mid-turn. `text` is the one-line
        // summary, `detail` the report the model read; both ride the
        // card, the same shape `threads.rs` rebuilds after a reload.
        patchMessage(assistantId, (m) => ({
          ...m,
          timeline: appendAgentReport(timelineOf(m), {
            agentId: agent?.agentId ?? "",
            name: agent?.name ?? null,
            status: agent?.status ?? "completed",
            summary: text,
            detail: detail ?? "",
            arrivedLive: true,
          }),
        }));
        return;
      }
      patchMessage(assistantId, (m) => ({
        ...m,
        timeline: appendUserInjection(timelineOf(m), text, chips),
      }));
      useAgentChatStore.getState().clearQueuedMessage(threadId);
    },
    // Context compaction (Rust runtime). The marker is appended to the
    // live transcript so the user sees it immediately; the authoritative
    // inline marker re-renders from the session JSONL on reopen. The
    // summary text is never sent to the UI — only the before→after drop.
    onCompactionStarted: () => {
      setActivity({ label: "Compacting context…" });
      stream.flush();
      const id = nextEventId();
      compactionEventId = id;
      // Drop the marker INTO the streaming assistant timeline at the
      // current point, so prior content stays above it and everything the
      // agent streams next lands below it.
      patchMessage(assistantId, (m) => ({
        ...m,
        timeline: appendCompaction(timelineOf(m), id),
      }));
    },
    onCompactionCompleted: (beforeTokens, afterTokens) => {
      setActivity({ label: "Responding…" });
      if (compactionEventId) {
        const id = compactionEventId;
        patchMessage(assistantId, (m) => ({
          ...m,
          timeline: finishCompaction(timelineOf(m), id, {
            status: "completed",
            beforeTokens,
            afterTokens,
          }),
        }));
        compactionEventId = null;
      }
      // Drop the ring immediately to the post-compaction size; the next
      // real usage event replaces it with a measurement. Recorded as a
      // PROJECTION rather than as usage — see `setProjectedUsage`.
      useAgentContextStore.getState().setProjectedUsage(threadId, afterTokens);
    },
    onCompactionFailed: ({ beforeTokens, reason, cancelled }) => {
      setActivity({ label: cancelled ? "Stopped" : "Responding…" });
      if (!compactionEventId) return;
      const id = compactionEventId;
      patchMessage(assistantId, (m) => ({
        ...m,
        timeline: finishCompaction(timelineOf(m), id, {
          status: cancelled ? "cancelled" : "failed",
          beforeTokens,
          reason,
        }),
      }));
      compactionEventId = null;
    },
    onToolCall: (tc) => {
      setActivity(describeToolActivity(tc.function.name, tc.function.arguments || ""));
      upsertToolCall(tc);
    },
    onToolExecutionStart: (tc) => {
      timer.start(tc.id);
      setActivity(describeToolActivity(tc.function.name, tc.function.arguments || ""));
      // The card's clock starts here, on the same event `timer.start`
      // anchors the measured duration to, so the running number and the
      // settled one describe the same span.
      upsertToolCall(tc, undefined, Date.now());
    },
    onToolExecutionComplete: (tc, result) => {
      captureBackgroundProcess(tc, result);
      captureCanvasWrite(tc, result);
      setToolResult(tc, result, timer.settle(tc.id));
    },
    onToolExecutionError: (tc, error) => setToolResult(tc, `[error] ${error}`, timer.settle(tc.id)),
    onToolRejected: (tc, reason) => {
      timer.forget(tc.id);
      setToolResult(tc, `[rejected] ${reason}`);
    },
    // Something the runtime needs to say that the model did NOT say —
    // most importantly "this reply is cut off at the output limit".
    // Its own marker, never folded into the assistant's text.
    onRuntimeNotice: ({ message }) => {
      noticedMessages.add(message);
      stream.flush();
      patchMessage(assistantId, (m) => ({
        ...m,
        // Retrying is over — either it worked and this notice is about
        // something else, or it ran out of attempts and THIS is the
        // explanation. Either way a spinner promising another try would
        // be a lie, so it goes.
        timeline: appendNotice(clearReconnect(timelineOf(m)), message),
      }));
    },
    onStreamAttemptStarted: () => {
      // Text queued before this point belongs to an earlier attempt and
      // survives a discard of this one.
      stream.beginAttempt();
      // Store patches and timeline appenders replace their values; this
      // immutable snapshot also preserves text merged into an older row.
      patchMessage(assistantId, (m) => {
        streamAttemptCheckpoint = m;
        return m;
      });
    },
    // Restore only this attempt's output. The next flush replaces the
    // reconnect marker with the new response from its first token.
    onPartialReplyDiscarded: ({ attempt, maxAttempts }) => {
      stream.dropPending();
      patchMessage(assistantId, (m) => {
        const timeline = beginReconnect(
          timelineOf(m),
          nextEventId(),
          attempt,
          maxAttempts,
          streamAttemptCheckpoint ? timelineOf(streamAttemptCheckpoint) : undefined,
        );
        return {
          ...m,
          timeline,
          // Flat mirrors of the timeline, used by Copy and as the reload
          // fallback. They cannot be un-appended, so they are rebuilt
          // from what survived — otherwise the discarded text is gone
          // from the transcript but still in everything derived from it.
          content: textOf(timeline, "content"),
          thinking: textOf(timeline, "thinking"),
          // Drop abandoned tool IDs from the flat mirror too. Otherwise
          // timeline hydration can resurrect a discarded preview card.
          tool_calls: timeline.flatMap((event) => (event.kind === "tool" ? [event.call] : [])),
          isThinking: false,
        };
      });
      setActivity({ label: "Reconnecting…" });
    },
    onError: (error) => {
      const message = error instanceof Error ? error.message : String(error);
      if (/cancel|abort/i.test(message)) return; // user stop → not an error
      // Already shown as an inline notice (the runtime emits the event
      // first, then fails the turn with the same message). Re-appending
      // it as message prose would say it twice, in two different voices.
      if (noticedMessages.has(message)) return;
      const classified = classifyError(error instanceof Error ? error : new Error(message));
      const note = `\n\n**${classified.title}**\n\n${classified.message}\n\n${classified.suggestion}`;
      stream.flush();
      patchMessage(assistantId, (m) => ({
        ...m,
        content: `${m.content || ""}${note}`,
        timeline: appendContent(timelineOf(m), note),
      }));
    },
  };

  return {
    callbacks,
    stream,
    timer,
    patchMessage,
    setActivity,
    addUsage: (usage) => {
      // The transcript's turn summary counts what this turn generated.
      // Every request of the turn lands on this one streaming message, so
      // they are added up here; a reload reads the same numbers back per
      // message from the session file.
      patchMessage(assistantId, (m) => ({
        ...m,
        usage: {
          input_tokens: (m.usage?.input_tokens ?? 0) + usage.promptTokens,
          output_tokens: (m.usage?.output_tokens ?? 0) + usage.completionTokens,
          estimated: m.usage?.estimated === true || usage.estimated === true || undefined,
        },
      }));
    },
    settle: () => {
      // Land any tail of buffered stream text, then close the reasoning phase.
      stream.flush();
      // Re-stamp the assistant message to the moment the turn SETTLED. It was
      // seeded at send time because there was nothing to stamp yet, and
      // `buildTurns` reads the last assistant message's timestamp as the turn's
      // `endedAt` — so leaving the seed value makes every just-finished turn
      // measure ~0ms and the "Worked 4m" footer silently disappears. It only
      // came back after reopening the thread, because the runtime stamps the
      // PERSISTED message at end-of-stream. This mirrors that on the optimistic
      // message so the live view and the reloaded view agree.
      const settledAt = nowIso();
      patchMessage(assistantId, (m) => ({
        ...m,
        isThinking: false,
        timestamp: settledAt,
        // The turn has settled, so no further attempt is coming — and a live
        // "Connection lost — retrying (2 of 3)" spinner is now a promise
        // nothing will keep. It was only ever cleared by a recovered attempt
        // streaming text or a tool event, or by a runtime notice landing in
        // its place; a turn that ran out of attempts fails through `onError`,
        // which cleared nothing, and a turn cancelled mid-retry returned from
        // `onError` earlier still. Both left the spinner promising a fourth
        // try, above a composer that had correctly gone back to Send — the
        // transcript and the composer disagreeing about whether anything was
        // running. Clearing here covers every way a turn can end, rather than
        // one more path at a time.
        timeline: clearReconnect(timelineOf(m)),
      }));
    },
  };
}
