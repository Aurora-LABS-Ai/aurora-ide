/**
 * Agent Window — docked "queued message" card [view].
 *
 * When the user sends while the open thread's turn is streaming, the text is
 * queued as a mid-turn injection (the Rust runtime drains it at the next
 * tool-result boundary). This card docks directly above the composer — the
 * SAME slot the task panel uses — so the pending message is visible and
 * cancellable. It stacks cleanly above/below the task panel when both are
 * present (both are `--agw-*` dock cards that tuck behind the composer).
 *
 * Per-thread via `useAgentChatStore.queuedByThread`, so a background turn's
 * queue never leaks into the open chat.
 */

import React from "react";
import { AnimatePresence, motion } from "framer-motion";

import { AgentIcon } from "../shared/AgentIcon";
import { useAgentChatStore } from "../store/useAgentChatStore";

export const AgentQueuedDock: React.FC<{
  /** The conversation whose queue this shows. Omit for the open chat. */
  threadId?: string | null;
}> = ({ threadId }) => {
  const openThreadId = useAgentChatStore((s) => s.currentThreadId);
  const currentThreadId = threadId === undefined ? openThreadId : threadId;
  const queued = useAgentChatStore((s) =>
    currentThreadId ? s.queuedByThread[currentThreadId] : undefined,
  );
  const cancel = useAgentChatStore((s) => s.cancelQueuedMessage);

  return (
    <AnimatePresence initial={false}>
      {queued && (
        <motion.div
          className="agw-dock-card agw-queued"
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 8 }}
          transition={{ duration: 0.18, ease: "easeOut" }}
        >
          <div className="agw-queued-head">
            <AgentIcon name="message" size={13} />
            <span className="agw-queued-label">Queued</span>
            <span className="agw-queued-body">{queued.text}</span>
            <button
              type="button"
              className="agw-tasks-x"
              title="Cancel queued message"
              aria-label="Cancel queued message"
              onClick={() => {
                if (currentThreadId) void cancel(currentThreadId);
              }}
            >
              <AgentIcon name="close" size={13} />
            </button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};
