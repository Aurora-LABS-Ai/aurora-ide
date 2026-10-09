/**
 * Start a turn when a sub-agent reported back and nothing is running.
 *
 * The twin of `useIdleProcessReport`, for the same reason: the runtime's
 * queued slot only drains at a tool-result boundary, so a report that lands
 * while the conversation is idle has to START a turn or it is never read.
 * Same conditions, in the same order — nothing running, this conversation
 * open, the person not mid-sentence — and no staleness cut-off: an agent's
 * report is work the parent asked for, and it is still the answer an hour
 * later.
 *
 * The reports come from the sub-agent store's copy of Rust's wake outbox,
 * filled by the `report` event and by every list poll, so one is found
 * whether or not its event was delivered. A report is carried ONCE:
 *
 * - one send in flight per conversation. The pipeline awaits before it marks
 *   the turn live, and every chat-store change in that window re-runs this
 *   drain; without the guard two drains took two reports for one idle
 *   moment, the second opened the turn, and the first returned `void` with
 *   its report gone (2026-10-08, four reports, one never reached the model);
 * - the report is claimed from Rust only after the send says a turn
 *   `started` (or `queued` it into one). A `skipped` send leaves it where it
 *   is for the next idle moment.
 *
 * The turn it starts carries `origin: "subagent"` and the agent's identity,
 * which change only how the message is persisted and drawn (an agent-report
 * block, the agent's card). The request is otherwise a person's turn, so it
 * appends to the cached prefix.
 */

import { useEffect, useRef } from "react";

import type { SendOutcome } from "@/apps/agent/hooks/conversation/send-outcome";
import type { AgentReportMeta } from "@/apps/agent/services/subagents/events";
import { auroraInvoke } from "@/kernel/lib/ipc/runtime";
import { useAgentChatStore } from "@/apps/agent/store/conversation/useAgentChatStore";
import { useAgentDraftStore } from "@/apps/agent/store/conversation/useAgentDraftStore";
import {
  selectWakesFor,
  useAgentSubagentStore,
} from "@/apps/agent/store/subagents/useAgentSubagentStore";

type SendSubagentReport = (
  detail: string,
  summary: string,
  agent: AgentReportMeta,
) => Promise<SendOutcome>;

/**
 * Conversations with a report send in flight: from the moment a wake is
 * taken to the moment its send settles. Module-level because the window has
 * one pipeline per conversation however many views mount this.
 */
const inFlight = new Set<string>();

/** Test seam. */
export const clearSubagentReportFlights = (): void => {
  inFlight.clear();
};

const report = (level: "warn" | "error", message: string): void => {
  void auroraInvoke("logs_report", {
    level,
    component: "subagents.wake",
    message,
  }).catch(() => {});
};

export const useIdleSubagentReport = (
  threadId: string | null,
  send: SendSubagentReport,
): void => {
  // Out of the effect's deps on purpose; see `useIdleProcessReport`.
  const sendRef = useRef(send);
  useEffect(() => {
    sendRef.current = send;
  }, [send]);

  useEffect(() => {
    if (!threadId) return;
    let disposed = false;

    const drain = (): void => {
      if (disposed) return;
      if (inFlight.has(threadId)) return;
      const wake = selectWakesFor(threadId)(useAgentSubagentStore.getState())[0];
      if (!wake) return;
      const chat = useAgentChatStore.getState();
      if (chat.liveTurns[threadId]) return;
      if (chat.queuedByThread[threadId]) return;
      if (useAgentDraftStore.getState().drafts[threadId]?.trim()) return;

      inFlight.add(threadId);
      void sendRef
        .current(wake.detail, wake.summary, wake.agent)
        .then(async (outcome) => {
          if (outcome === "skipped") {
            // Nothing carried it: a turn opened on this conversation first.
            // The wake stays in Rust's outbox and in the store; the next
            // idle moment (that turn ending) runs this drain again.
            return;
          }
          const claimed = await useAgentSubagentStore
            .getState()
            .claimWake(threadId, wake.id);
          if (!claimed) {
            report(
              "warn",
              `wake ${wake.id} for ${threadId} was sent but Rust no longer held it: ` +
                `it may have been carried twice`,
            );
          }
        })
        .catch((err: unknown) => {
          // The child's transcript holds the report and the wake stays
          // pending; the next change of state tries again. Said out loud:
          // a report that never arrives must leave a line somewhere.
          report(
            "error",
            `could not start a turn for wake ${wake.id} on ${threadId}: ${String(err)}`,
          );
        })
        .finally(() => {
          inFlight.delete(threadId);
        });
    };

    // Reports arrive through the store (event or poll); the turn ending is
    // the other moment worth re-checking, and it is a chat-store change.
    const unsubscribeWakes = useAgentSubagentStore.subscribe(drain);
    const unsubscribeChat = useAgentChatStore.subscribe(drain);
    drain();
    return () => {
      disposed = true;
      unsubscribeWakes();
      unsubscribeChat();
    };
  }, [threadId]);
};
