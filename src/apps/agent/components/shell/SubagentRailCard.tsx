/**
 * Agent Window — a sub-agent's card beside the icon rail [view].
 *
 * Probe: Documents/aurora-subagent-rail-designs.html (03). Opened from the
 * agent's rail cell: a head that says who it is and how it is doing, and the
 * same live tail the Agents tab shows under a row (`SubagentTail`).
 *
 * Painted opaque, unlike the context card. A pinned card can sit over a
 * streaming conversation for minutes, and a backdrop blur re-composites what
 * is behind it every time that changes.
 */

import React from "react";

import { AgentIcon } from "@/apps/agent/shared/AgentIcon";
import { agentElapsedMs, fmtClock, useNow } from "@/apps/agent/components/panels/subagent-clock";
import { StopAgentButton } from "@/apps/agent/components/panels/subagent-parts";
import { SubagentTail } from "@/apps/agent/components/panels/SubagentTail";
import { agentInitial } from "@/apps/agent/lib/subagents/rail-layout";
import { formatTokens, prettyModel } from "@/apps/agent/lib/thread/model-label";
import { subagentLabel, type SubagentSnapshot } from "@/apps/agent/services/subagents/commands";
import { useAgentSettingsStore } from "@/apps/agent/store/settings/useAgentSettingsStore";
import {
  selectExpanded,
  useSubagentRailStore,
} from "@/apps/agent/store/subagents/useSubagentRailStore";

const OUTCOME: Record<SubagentSnapshot["status"], string> = {
  running: "Running",
  completed: "Finished",
  failed: "Failed",
  killed: "Stopped",
};

/**
 * The live tail, memoised on strings: the card re-renders on every list poll
 * and on the clock, and neither is a reason to re-render a tail that follows
 * its own store.
 */
const CardTail = React.memo<{ parentThreadId: string; agentId: string; label: string }>(
  function CardTail({ parentThreadId, agentId, label }) {
    // Saved with the conversation, so a card grown last week opens grown.
    const more = useSubagentRailStore(selectExpanded(parentThreadId, agentId));
    return (
      <SubagentTail
        parentThreadId={parentThreadId}
        agentId={agentId}
        label={label}
        more={more}
        onMoreChange={(next) =>
          useSubagentRailStore.getState().setExpanded(parentThreadId, agentId, next)
        }
      />
    );
  },
);

/** Status, clock, context and model in one line. Only this ticks. */
const CardFacts: React.FC<{ agent: SubagentSnapshot; modelName: string | null }> = ({
  agent,
  modelName,
}) => {
  const now = useNow(agent.status === "running");
  const parts = [
    agent.status === "failed" && agent.error?.trim() ? agent.error.trim() : OUTCOME[agent.status],
    fmtClock(agentElapsedMs(agent, now)),
    agent.contextTokens ? `${formatTokens(agent.contextTokens)} ctx` : null,
    modelName,
  ].filter(Boolean);
  return <div className="agw-railcard-sub">{parts.join(" · ")}</div>;
};

export const SubagentRailCard: React.FC<{
  parentThreadId: string;
  agent: SubagentSnapshot;
  pinned: boolean;
  /** Pinning this one would pass the cap. */
  pinFull: boolean;
  onTogglePin: () => void;
  onClose: () => void;
  onOpenTab: () => void;
  onStop: (agentId: string) => Promise<boolean>;
}> = ({ parentThreadId, agent, pinned, pinFull, onTogglePin, onClose, onOpenTab, onStop }) => {
  const models = useAgentSettingsStore((s) => s.models);
  const label = subagentLabel(agent);
  const description = agent.description.trim();
  const running = agent.status === "running";
  const modelName = agent.model ? prettyModel(agent.model, models) : null;
  const pinTitle = pinned
    ? "Unpin"
    : pinFull
      ? "Three cards are pinned. Unpin one to pin this."
      : "Keep this card open";

  return (
    <div
      className="agw-railcard"
      data-agent={agent.agentId}
      data-pinned={pinned ? "" : undefined}
      role="dialog"
      aria-label={label}
    >
      <div className="agw-railcard-head">
        <span className="agw-railcard-tile" data-status={agent.status} aria-hidden>
          {agentInitial(label)}
        </span>
        <div className="agw-railcard-main">
          <div className="agw-railcard-name">
            <span className={running ? "agw-shimmer" : undefined}>{label}</span>
            {description && description !== label && (
              <span className="agw-railcard-desc">{description}</span>
            )}
          </div>
          <CardFacts agent={agent} modelName={modelName} />
        </div>
        <div className="agw-railcard-acts">
          {running && <StopAgentButton agentId={agent.agentId} label={label} onStop={onStop} />}
          <button
            type="button"
            className="agw-railcard-btn"
            onClick={onOpenTab}
            aria-label={`Open ${label} in its own tab`}
            title="Open in its own tab"
          >
            <AgentIcon name="external" size={13} />
          </button>
          <button
            type="button"
            className="agw-railcard-btn"
            onClick={onTogglePin}
            aria-pressed={pinned}
            aria-disabled={!pinned && pinFull ? true : undefined}
            aria-label={pinned ? `Unpin ${label}` : `Pin ${label}`}
            title={pinTitle}
          >
            <AgentIcon name="pin" size={13} />
          </button>
          <button
            type="button"
            className="agw-railcard-btn"
            onClick={onClose}
            aria-label={`Close ${label}`}
            title="Close"
          >
            <AgentIcon name="close" size={13} />
          </button>
        </div>
      </div>
      <div className="agw-railcard-body">
        <CardTail parentThreadId={parentThreadId} agentId={agent.agentId} label={label} />
      </div>
      {!pinned && <div className="agw-railcard-hint">Double-click its icon to keep this open.</div>}
    </div>
  );
};
