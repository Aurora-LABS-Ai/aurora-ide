/**
 * Agent Window — a sub-agent's report in its parent's transcript [view].
 *
 * Probe: Documents/aurora-agents-panel-designs.html, 02 (picked 2026-10-08).
 *
 * The report arrives from the agent's side, so it sits on the right like a
 * message and borrows the user bubble's fill and measure — but it is not the
 * user's words. The first line says who: a static status dot, the agent's
 * name (a link to its tab), its type and how it ended. The body is the
 * report's opening summary; "Open report" shows the rest inline.
 *
 * The same component, flipped, draws a message FROM the parent inside a
 * child's transcript (`from="parent"`): there the "who" is the parent.
 */

import React, { useMemo, useState } from "react";

import { AgentIcon } from "@/apps/agent/shared/AgentIcon";
import { AgentMarkdown } from "@/apps/agent/components/conversation/AgentMarkdown";
import type { AgentReportEvent } from "@/apps/agent/components/conversation/timeline";
import { reportBody, reportLead } from "@/apps/agent/lib/subagents/report-body";
import { useAgentChatStore } from "@/apps/agent/store/conversation/useAgentChatStore";
import { useAgentWorkspaceStore } from "@/apps/agent/store/workspace/useAgentWorkspaceStore";
import { useAgentSubagentStore } from "@/apps/agent/store/subagents/useAgentSubagentStore";

const STATUS_WORD: Record<string, string> = {
  completed: "finished",
  failed: "failed",
  killed: "stopped",
  // A card with a running status is a MESSAGE the agent sent mid-run
  // (`message_parent`); finish reports always carry a terminal status.
  running: "message",
};

export const AgentReportCard: React.FC<{
  report: AgentReportEvent;
  /** `"agent"` (default): the child reporting to this parent. `"parent"`:
   *  the parent speaking inside the child's transcript. */
  from?: "agent" | "parent";
  /** For `from="parent"`: the parent conversation's title. */
  parentTitle?: string | null;
  /** For `from="parent"`: sent, but the agent has not taken it in yet. */
  waiting?: boolean;
}> = ({ report, from = "agent", parentTitle, waiting = false }) => {
  const [open, setOpen] = useState(false);
  const currentThreadId = useAgentChatStore((s) => s.currentThreadId);
  const openAgentTab = useAgentWorkspaceStore((s) => s.openAgentTab);
  const live = useAgentSubagentStore((s) =>
    currentThreadId
      ? s.byParent[currentThreadId]?.find((row) => row.agentId === report.agentId)
      : undefined,
  );

  const { body, meta } = useMemo(() => reportBody(report.detail), [report.detail]);
  const name = report.name?.trim() || live?.name || report.agentId || "agent";
  const status = live && live.status !== report.status && live.status === "running" ? "running" : report.status;
  // A mid-run message sent with `waitForReply` is a question the agent is
  // paused on; the envelope says so with `waiting="true"`.
  const asking = report.status === "running" && /^<subagent_message[^>]*\swaiting="true"/.test(report.detail);
  const word = asking ? "question" : (STATUS_WORD[status] ?? status);
  const type = live?.agentType ?? null;

  if (from === "parent") {
    // A brief from the parent is often hundreds of words. Lead with its first
    // paragraph, like the report card, and fold the rest behind one button.
    const text = report.summary.trim();
    const lead = reportLead(text);
    const folded = lead.length < text.length;
    return (
      <div className="agw-agent-card-row">
        <div
          className="agw-agent-card"
          data-from="parent"
          data-waiting={waiting ? "" : undefined}
        >
          <div className="agw-agent-card-head">
            <AgentIcon name="chat" size={12} />
            <span className="agw-agent-name" style={{ cursor: "default" }}>
              {parentTitle?.trim() || "Parent agent"}
            </span>
            <span>·</span>
            <span>{waiting ? "waiting for its next step" : "from the parent"}</span>
          </div>
          <div className="agw-agent-card-summary">{open ? text : lead}</div>
          {folded && (
            <div className="agw-agent-card-foot">
              <span />
              <button
                type="button"
                className="agw-agent-card-open"
                aria-expanded={open}
                onClick={() => setOpen((v) => !v)}
              >
                {open ? "Hide message" : "Show full message"}
                <AgentIcon name="chevron-down" size={12} />
              </button>
            </div>
          )}
        </div>
      </div>
    );
  }

  const openTab = () => {
    if (!currentThreadId || !report.agentId) return;
    openAgentTab(currentThreadId, report.agentId, name);
  };

  return (
    <div className="agw-agent-card-row" data-arrive={report.arrivedLive ? "" : undefined}>
      <div className="agw-agent-card" role="group" aria-label={`Report from ${name}`}>
        <div className="agw-agent-card-head">
          <span className="agw-agent-dot" data-status={status} aria-hidden />
          <button type="button" className="agw-agent-name" onClick={openTab} title={`Open ${name}`}>
            {name}
          </button>
          {type && <span>{type}</span>}
          <span>·</span>
          <span>
            {word}
            {meta ? ` in ${meta.split(" · ")[0]}` : ""}
          </span>
        </div>
        <div className="agw-agent-card-summary" data-status={status === "failed" ? "failed" : undefined}>
          {body ? reportLead(body) : report.summary}
        </div>
        <div className="agw-agent-card-foot">
          <span>{meta ? meta.split(" · ").slice(1).join(" · ") : ""}</span>
          {body && (
            <button
              type="button"
              className="agw-agent-card-open"
              aria-expanded={open}
              onClick={() => setOpen((v) => !v)}
            >
              {open ? "Hide report" : "Open report"}
              <AgentIcon name="chevron-down" size={12} />
            </button>
          )}
        </div>
        {open && body && (
          <div className="agw-agent-card-body">
            <AgentMarkdown content={body} />
          </div>
        )}
      </div>
    </div>
  );
};
