/**
 * Agent Window — the Agents dock tab [view].
 *
 * The sub-agents the OPEN conversation has started, by the names the agent
 * gave them: running first, then finished. Each row says who it is (a
 * lettered tile, its name, the model it runs on), how it is doing, and how
 * full its context is. Clicking the name opens the agent's live tail under the
 * row (`SubagentTail`); several can be open at once, so three agents can be
 * watched side by side. The open-tab button gives the full view.
 *
 * Probes: Documents/aurora-agents-panel-designs.html (context panel),
 * Documents/aurora-agent-preview-designs.html (the tail, 06).
 */

import React, { useEffect, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";

import { AgentIcon } from "@/apps/agent/shared/AgentIcon";
import { agentElapsedMs, fmtClock, useNow } from "@/apps/agent/components/panels/subagent-clock";
import {
  isPreviewGrown,
  isPreviewOpen,
  setPreviewGrown,
  setPreviewOpen,
} from "@/apps/agent/components/panels/subagent-memory";
import { AgentLead, StopAgentButton } from "@/apps/agent/components/panels/subagent-parts";
import { SubagentTail } from "@/apps/agent/components/panels/SubagentTail";
import { prefetchSubagentTranscript } from "@/apps/agent/hooks/subagents/useSubagentTranscript";
import { formatTokens, prettyModel } from "@/apps/agent/lib/thread/model-label";
import { subagentLabel, type SubagentSnapshot } from "@/apps/agent/services/subagents/commands";
import { useAgentChatStore } from "@/apps/agent/store/conversation/useAgentChatStore";
import { useAgentSettingsStore } from "@/apps/agent/store/settings/useAgentSettingsStore";
import {
  orderForPanel,
  selectSubagents,
  useAgentSubagentStore,
} from "@/apps/agent/store/subagents/useAgentSubagentStore";
import { useAgentWorkspaceStore } from "@/apps/agent/store/workspace/useAgentWorkspaceStore";

/** What the agent is doing or how it ended, in a line. */
function describeOutcome(agent: SubagentSnapshot): string {
  if (agent.status === "running") return "Running";
  if (agent.status === "killed") return "Stopped";
  if (agent.status === "failed") return agent.error?.trim() || "Failed";
  return "Finished";
}

/** The tile's letter: the first letter or digit of the name. */
function initialOf(label: string): string {
  const match = label.match(/[\p{L}\p{N}]/u);
  return (match?.[0] ?? "A").toUpperCase();
}

/**
 * The live tail under an open row, opening the way a tool group does: the
 * height grows from nothing while the lines rise out of a soft blur.
 */
const AgentPreview: React.FC<{
  parentThreadId: string;
  agent: SubagentSnapshot;
  id: string;
}> = ({ parentThreadId, agent, id }) => {
  const reduce = useReducedMotion();
  const [more, setMore] = useState(() => isPreviewGrown(parentThreadId, agent.agentId));
  const changeMore = (next: boolean) => {
    setPreviewGrown(parentThreadId, agent.agentId, next);
    setMore(next);
  };
  const duration = reduce ? 0 : 0.22;
  return (
    <motion.div
      id={id}
      className="agw-agents-preview"
      initial={{ height: 0, opacity: 0 }}
      animate={{ height: "auto", opacity: 1 }}
      exit={{ height: 0, opacity: 0 }}
      transition={{ duration, ease: [0.16, 1, 0.3, 1] }}
      style={{ overflow: "hidden" }}
    >
      <motion.div
        initial={{ y: 8, filter: "blur(4px)" }}
        animate={{ y: 0, filter: "blur(0px)" }}
        exit={{ y: 8, filter: "blur(4px)" }}
        transition={{ duration: reduce ? 0 : 0.24, ease: [0.16, 1, 0.3, 1] }}
      >
        <SubagentTail
          parentThreadId={parentThreadId}
          agentId={agent.agentId}
          label={subagentLabel(agent)}
          more={more}
          onMoreChange={changeMore}
        />
      </motion.div>
    </motion.div>
  );
};

const AgentRow: React.FC<{
  parentThreadId: string;
  agent: SubagentSnapshot;
  now: number;
  modelName: string | null;
  open: boolean;
  onToggle: (agentId: string) => void;
  onOpenTab: (agent: SubagentSnapshot) => void;
  onStop: (agentId: string) => Promise<boolean>;
}> = ({ parentThreadId, agent, now, modelName, open, onToggle, onOpenTab, onStop }) => {
  const label = subagentLabel(agent);
  const running = agent.status === "running";
  const previewId = `agw-agent-preview-${agent.agentId}`;
  const sub = [
    modelName,
    agent.description.trim() !== label ? agent.description.trim() : null,
    describeOutcome(agent),
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <div className="agw-agents-item" data-open={open ? "" : undefined}>
      <div className="agw-agents-row" data-status={agent.status}>
        <span className="agw-agents-avatar" aria-hidden>
          {initialOf(label)}
        </span>
        <div className="agw-agents-row-main">
          <button
            type="button"
            className="agw-agents-row-open"
            onClick={() => onToggle(agent.agentId)}
            // Read the transcript while the pointer travels to the click, so
            // the tail opens with its content instead of landing mid-motion.
            onPointerEnter={() => prefetchSubagentTranscript(parentThreadId, agent.agentId)}
            onFocus={() => prefetchSubagentTranscript(parentThreadId, agent.agentId)}
            aria-expanded={open}
            aria-controls={open ? previewId : undefined}
            title={open ? `Hide ${label}` : `Watch ${label}`}
          >
            <AgentIcon name="chevron-right" size={12} />
            {/* The window's live-label sweep, as on a streaming turn's label. */}
            <span className={running ? "agw-shimmer" : undefined}>{label}</span>
          </button>
          <span className="agw-agents-row-sub">{sub}</span>
        </div>
        <div className="agw-agents-row-right">
          {agent.contextTokens ? (
            <span title="Context the agent is using">{formatTokens(agent.contextTokens)} ctx</span>
          ) : null}
          <span className="agw-agents-row-time">{fmtClock(agentElapsedMs(agent, now))}</span>
          <AgentLead status={agent.status} />
          {running && <StopAgentButton agentId={agent.agentId} label={label} onStop={onStop} />}
          <button
            type="button"
            className="agw-agents-tab"
            onClick={() => onOpenTab(agent)}
            aria-label={`Open ${label} in its own tab`}
            title="Open in its own tab"
          >
            <AgentIcon name="external" size={13} />
          </button>
        </div>
      </div>
      <AnimatePresence initial={false}>
        {open && (
          <AgentPreview
            key="preview"
            parentThreadId={parentThreadId}
            agent={agent}
            id={previewId}
          />
        )}
      </AnimatePresence>
    </div>
  );
};

export const AgentsPanel: React.FC = () => {
  const parentThreadId = useAgentChatStore((s) => s.currentThreadId);
  const agents = useAgentSubagentStore(selectSubagents(parentThreadId));
  const load = useAgentSubagentStore((s) => s.load);
  const kill = useAgentSubagentStore((s) => s.kill);
  const openAgentTab = useAgentWorkspaceStore((s) => s.openAgentTab);
  const models = useAgentSettingsStore((s) => s.models);
  // Which previews are open, kept outside the component: the dock mounts
  // only its active tab, and switching away must not fold them all.
  const [, setOpenTick] = useState(0);

  useEffect(() => {
    if (parentThreadId) void load(parentThreadId);
  }, [parentThreadId, load]);

  const rows = orderForPanel(agents);
  const running = rows.filter((row) => row.status === "running");
  const finished = rows.filter((row) => row.status !== "running");
  const now = useNow(running.length > 0);

  const openTab = (agent: SubagentSnapshot) => {
    if (parentThreadId) openAgentTab(parentThreadId, agent.agentId, subagentLabel(agent));
  };
  const toggle = (agentId: string) => {
    if (!parentThreadId) return;
    setPreviewOpen(parentThreadId, agentId, !isPreviewOpen(parentThreadId, agentId));
    setOpenTick((n) => n + 1);
  };

  const group = (title: string, list: SubagentSnapshot[]) =>
    list.length === 0 || !parentThreadId ? null : (
      <section className="agw-agents-group" aria-label={title}>
        <div className="agw-agents-group-label">{title}</div>
        {list.map((agent) => (
          <AgentRow
            key={agent.agentId}
            parentThreadId={parentThreadId}
            agent={agent}
            now={now}
            modelName={agent.model ? prettyModel(agent.model, models) : null}
            open={isPreviewOpen(parentThreadId, agent.agentId)}
            onToggle={toggle}
            onOpenTab={openTab}
            onStop={kill}
          />
        ))}
      </section>
    );

  return (
    <div className="agw-agents agw-scroll">
      <div className="agw-agents-head">
        <h2>Agents</h2>
        {rows.length > 0 && <span>{rows.length} in this conversation</span>}
      </div>
      {!parentThreadId ? (
        <div className="agw-agents-empty">Open a conversation to see its agents.</div>
      ) : rows.length === 0 ? (
        <div className="agw-agents-empty">
          No sub-agents in this conversation yet.
          <br />
          The agent starts one when a task is worth handing off; each appears here under the
          name it gives it.
        </div>
      ) : (
        <>
          {group("Running", running)}
          {group("Finished", finished)}
        </>
      )}
    </div>
  );
};
