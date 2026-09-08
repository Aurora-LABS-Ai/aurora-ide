/**
 * Start a turn when a background process ended and nothing is running.
 *
 * Without this, an ending that lands while the conversation is idle is thrown
 * away: the runtime's queued-message slot only drains at a tool-result
 * boundary, so with no turn in flight there is nothing to drain it. The agent's
 * last memory of a four-minute test run stays "still running" — and it will say
 * so, confidently, however long ago the run actually failed.
 *
 * Modelled on Claude Code's `useQueueProcessor` (thirdparty/claude-code-cli),
 * which does the same thing for the same reason: idle plus something waiting
 * means start a turn, in this conversation, without anyone typing. Its queue
 * puts background news behind user input on purpose — "so user input is never
 * starved by system messages" — and the conditions below are Aurora's version
 * of that rule.
 *
 * A report is announced only when ALL of these hold:
 *
 * - **Nothing is running.** Otherwise the mid-turn path already handled it.
 * - **The thread is open.** Aurora has many conversations where the CLI has one
 *   session. Starting a turn in a chat nobody is looking at spends tokens out
 *   of sight, and the ending is not lost by waiting — it is announced when that
 *   conversation is opened, or dropped when it goes stale.
 * - **The person is not mid-sentence.** A draft in the composer, or a message
 *   already queued, means they are about to speak. They go first, and the
 *   report rides the turn they start.
 * - **It is still news.** Older than {@link IDLE_REPORT_MAX_AGE_MS} and it is
 *   dropped: the dock row and the log still say what happened, and a
 *   conversation that opens with two-hour-old housekeeping is worse than one
 *   that says nothing.
 *
 * The turn it starts is an ordinary one — same system prompt, same tools, same
 * model — carrying `origin: "process"`, which changes only how the message is
 * persisted and drawn. That matters for the prompt cache: the turn APPENDS to
 * the cached prefix exactly as a person's turn would, so it costs a normal
 * request rather than re-billing the conversation as a cache write.
 */

import { useEffect, useRef } from "react";

import { useAgentChatStore } from "@/apps/agent/store/conversation/useAgentChatStore";
import { useAgentDraftStore } from "@/apps/agent/store/conversation/useAgentDraftStore";
import {
  IDLE_REPORT_MAX_AGE_MS,
  peekIdleReport,
  subscribeToIdleReports,
  takeIdleReport,
} from "@/apps/agent/hooks/useBackgroundProcessWatch";

/** Send exactly as the composer does; only the origin differs. */
type SendProcessReport = (
  text: string,
  summary: string,
) => Promise<void>;

export const useIdleProcessReport = (
  threadId: string | null,
  send: SendProcessReport,
): void => {
  // Held in a ref and deliberately OUT of the effect's deps. The send pipeline
  // is rebuilt on every render of the conversation pane, so depending on it
  // meant tearing down and re-subscribing this watch on every streaming token —
  // hundreds of times a turn, to end up in exactly the same place.
  const sendRef = useRef(send);
  useEffect(() => {
    sendRef.current = send;
  }, [send]);

  useEffect(() => {
    if (!threadId) return;

    let disposed = false;

    const drain = (): void => {
      if (disposed) return;
      const report = peekIdleReport(threadId);
      if (!report) return;

      const chat = useAgentChatStore.getState();
      // Something started between the ending landing and this running. The
      // report stays parked; the next idle moment picks it up, and if a turn is
      // running the mid-turn path will have queued its own.
      if (chat.liveTurns[threadId]) return;
      // The person is speaking. Theirs goes first — this is the "later"
      // priority the reference queue gives system messages, expressed as a
      // condition because Aurora has one slot rather than a queue.
      if (chat.queuedByThread[threadId]) return;
      if (useAgentDraftStore.getState().drafts[threadId]?.trim()) return;

      // Claim it before the await so a second drain cannot send it twice.
      const claimed = takeIdleReport(threadId);
      if (!claimed) return;
      if (Date.now() - claimed.endedAtMs > IDLE_REPORT_MAX_AGE_MS) return;

      void sendRef.current(claimed.detail, claimed.summary).catch(() => {
        // The dock row and the log still say what happened. A failed
        // announcement costs the agent a notification, not the record.
      });
    };

    const unsubscribe = subscribeToIdleReports(drain);
    // A report may have been parked while another thread was open, or while a
    // turn was still finishing. Opening the conversation is the moment to say
    // so.
    drain();

    // The turn ending is the other moment worth re-checking, and it is a store
    // change rather than a report change.
    const unsubscribeChat = useAgentChatStore.subscribe(drain);

    return () => {
      disposed = true;
      unsubscribe();
      unsubscribeChat();
    };
  }, [threadId]);
};
