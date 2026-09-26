/**
 * Agent Window — composer rail [view].
 *
 * The fixed-height strip directly under the composer. It replaces a line that
 * was dead most of the session (it only ever held the "AI can make mistakes"
 * disclaimer, or a transient microphone / prompt-refine notice) with the
 * window's one place for AMBIENT STATE:
 *
 *   AI can make mistakes. Review generated code.              ⧉ 2
 *   └─ notice slot (left) ────────────────┘                   └ chips ┘
 *
 * Why the strip and not another docked card: everything that wanted to tell the
 * user something used to mount its own full-width card ABOVE the composer, so
 * the transcript jumped down every time a process started or a checklist
 * arrived. The rail's height never changes — chips appear and disappear inside
 * a row that is always there — so the reading area stops moving.
 *
 * What does NOT belong here: anything that BLOCKS the turn. Tool approval
 * (`ApprovalBar`) and `ask_question` (`QuestionPrompt`) keep their docked
 * cards, because a stalled agent behind a 12px chip is a hang the user can't
 * see. The rule for adding a tenant: ambient → chip, blocking → card.
 *
 * The task checklist used to be the second chip here. It moved to the header
 * (`TaskIndicator`), beside context usage: it is something you consult WHILE the
 * agent works, and this strip sits in the writing zone. Background processes
 * stay, because stopping one is an action you take from the composer.
 */

import React from "react";

import { BackgroundTaskDock } from "@/apps/agent/components/panels/BackgroundTaskDock";
import { useAgentChatStore } from "@/apps/agent/store/conversation/useAgentChatStore";
import {
  useAgentBackgroundStore,
  visibleProcesses,
} from "@/apps/agent/store/conversation/useAgentBackgroundStore";
import { RailChip } from "@/apps/agent/components/composer-rail/RailChip";
import { useAgentSettingsStore } from "@/apps/agent/store/settings/useAgentSettingsStore";

export interface RailNotice {
  text: string;
  tone: "subtle" | "warning" | "error";
}

const NOTICE_COLOR: Record<RailNotice["tone"], string> = {
  subtle: "var(--agw-text-subtle)",
  warning: "var(--agw-warning)",
  error: "var(--agw-removed)",
};

export const ComposerRail: React.FC<{
  /**
   * Transient message for the left slot (microphone state, prompt-refine
   * failure). When absent the disclaimer takes the slot back, so the rail is
   * never blank and never changes height.
   */
  notice?: RailNotice | null;
  /**
   * The conversation this rail belongs to. Omit for the open chat; a composer
   * for a docked chat passes its own, or the chip would count and stop the
   * wrong conversation's background processes.
   */
  threadId?: string | null;
}> = ({ notice, threadId: boundThreadId }) => {
  const openThreadId = useAgentChatStore((s) => s.currentThreadId);
  const threadId = boundThreadId === undefined ? openThreadId : boundThreadId;

  const chatSurface = useAgentSettingsStore((s) => s.auroraSurface) === "chat";
  const byThread = useAgentBackgroundStore((s) => s.byThread);
  const processes = visibleProcesses(byThread, threadId);
  const running = processes.filter((entry) => entry.status === "running").length;

  return (
    <div className="agw-crail">
      <p className="agw-crail-notice" style={{ color: NOTICE_COLOR[notice?.tone ?? "subtle"] }}>
        {/* "Review generated code" is Build's warning and is wrong in Aurora
            Chat, which writes no code. The risk there is a confident wrong
            answer, so the line names that instead of nothing. */}
        {notice?.text ??
          (chatSurface
            ? "AI can make mistakes. Check anything that matters."
            : "AI can make mistakes. Review generated code.")}
      </p>

      <div className="agw-crail-chips">
        {processes.length > 0 && (
          <RailChip
            icon="terminal"
            label="Background processes"
            readout={`${running}/${processes.length}`}
            // A live process is the thing most likely to need stopping, so it
            // asks for attention while it runs — not only when it fails.
            attention={running > 0}
          >
            <BackgroundTaskDock variant="popover" threadId={threadId} />
          </RailChip>
        )}
      </div>
    </div>
  );
};
