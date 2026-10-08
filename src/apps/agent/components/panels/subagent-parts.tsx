/**
 * Agent Window — the marks the Agents tab and an agent's own tab share [view].
 *
 * A status glyph and the Stop button. Both panels draw them; one copy keeps the
 * list and the tab from drifting. The clock lives in `subagent-clock.ts`.
 *
 * Probe: Documents/aurora-agents-panel-designs.html (context panel).
 */

import React, { useState } from "react";

import { AgentIcon } from "@/apps/agent/shared/AgentIcon";
import { StreamingDotMatrix } from "@/apps/agent/components/theme/StreamingDotMatrix";
import type { SubagentStatus } from "@/apps/agent/services/subagents/events";

/**
 * The leading mark: the dot matrix while it works, a static status dot after.
 * Nothing pulses beyond the matrix the chat tab already uses.
 */
export const AgentLead: React.FC<{ status: SubagentStatus }> = ({ status }) =>
  status === "running" ? (
    <StreamingDotMatrix size={18} />
  ) : (
    <span className="agw-agent-dot" data-status={status} aria-hidden />
  );

/** Stop a running agent. Disabled while the stop request is in flight. */
export const StopAgentButton: React.FC<{
  agentId: string;
  label: string;
  onStop: (agentId: string) => Promise<boolean>;
}> = ({ agentId, label, onStop }) => {
  const [stopping, setStopping] = useState(false);
  return (
    <button
      type="button"
      className="agw-agents-stop"
      disabled={stopping}
      aria-label={`Stop ${label}`}
      onClick={(event) => {
        // Stopping must never also count as a click on the row around it.
        event.stopPropagation();
        setStopping(true);
        void onStop(agentId).finally(() => setStopping(false));
      }}
    >
      <AgentIcon name="stop" size={12} />
      Stop
    </button>
  );
};
