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
 * The turn it starts carries `origin: "subagent"` and the agent's identity,
 * which change only how the message is persisted and drawn (an agent-report
 * block, the agent's card). The request is otherwise a person's turn, so it
 * appends to the cached prefix.
 */

import { useEffect, useRef } from "react";

import type { AgentReportMeta } from "@/apps/agent/services/subagents/events";
import { useAgentChatStore } from "@/apps/agent/store/conversation/useAgentChatStore";
import { useAgentDraftStore } from "@/apps/agent/store/conversation/useAgentDraftStore";
import {
  peekSubagentReport,
  subscribeToSubagentReports,
  takeSubagentReport,
} from "@/apps/agent/hooks/useSubagentWatch";

type SendSubagentReport = (
  detail: string,
  summary: string,
  agent: AgentReportMeta,
) => Promise<void>;

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
      if (!peekSubagentReport(threadId)) return;
      const chat = useAgentChatStore.getState();
      if (chat.liveTurns[threadId]) return;
      if (chat.queuedByThread[threadId]) return;
      if (useAgentDraftStore.getState().drafts[threadId]?.trim()) return;
      const claimed = takeSubagentReport(threadId);
      if (!claimed) return;
      void sendRef.current(claimed.detail, claimed.summary, claimed.agent).catch(() => {
        // The child's transcript holds the report. A failed announcement
        // costs the parent a notification, not the record.
      });
    };

    const unsubscribe = subscribeToSubagentReports(drain);
    drain();
    const unsubscribeChat = useAgentChatStore.subscribe(drain);
    return () => {
      disposed = true;
      unsubscribe();
      unsubscribeChat();
    };
  }, [threadId]);
};
