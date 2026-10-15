/**
 * Agent Window — a sub-agent's report in its parent's transcript [view].
 *
 * Probe: Documents/aurora-subagent-report-designs.html, round 3 "B — no
 * edge, only the fill" (Alvan's pick, 2026-10-12). It replaced the right-hand
 * bubble picked on 2026-10-08 (aurora-agents-panel-designs.html, 02), which
 * wore the user bubble's fill and read as the user's own message, and whose
 * "Open report" poured the whole report into the conversation with no ceiling.
 *
 * Now it sits in the agent's column like the work around it: a soft fill, no
 * edge. One row says who and how it went — status dot, the agent's name (a
 * link to its tab), its type, how it ended, the numbers — and the rest of the
 * row opens and closes the card the way a tool card's row does, with its
 * chevron. Under it is ONE text area: the report as the agent wrote it, summary
 * first and everything after it. Closed, it shows the first lines and fades
 * out; open, the same area grows to the locked height every tool card uses
 * and scrolls inside itself.
 *
 * The same component, flipped, draws a message FROM the parent inside a
 * child's transcript (`from="parent"`): there the "who" is the parent.
 */

import React, { useLayoutEffect, useMemo, useRef, useState } from "react";

import { AgentIcon } from "@/apps/agent/shared/AgentIcon";
import { AgentMarkdown } from "@/apps/agent/components/conversation/AgentMarkdown";
import type { AgentReportEvent } from "@/apps/agent/components/conversation/timeline";
import { reportBody } from "@/apps/agent/lib/subagents/report-body";
import { useAgentChatStore } from "@/apps/agent/store/conversation/useAgentChatStore";
import { useConversationScope } from "@/apps/agent/lib/thread/conversation-scope";
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

/**
 * The card's text area: the whole text in one place. Closed it is clipped to
 * its first lines with a fade; open it is the locked, scrolling area. A text
 * short enough to fit is never clipped, and then there is nothing to open.
 */
function useFoldable(text: string) {
  const ref = useRef<HTMLDivElement>(null);
  const [foldable, setFoldable] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      // Measured against the CLOSED height (the CSS cap, in `em` so it follows
      // the text size), whatever state the card is in, so opening it never
      // makes the chevron disappear.
      const style = getComputedStyle(el);
      const raw = style.getPropertyValue("--agw-agent-card-fold").trim();
      const value = parseFloat(raw) || 0;
      const cap = raw.endsWith("em") ? value * (parseFloat(style.fontSize) || 16) : value;
      setFoldable(cap > 0 && el.scrollHeight > cap + 1);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [text]);
  return { ref, foldable };
}

const CardShell: React.FC<{
  who: React.ReactNode;
  dotStatus?: string;
  words: React.ReactNode;
  stats?: string | null;
  text: string;
  plain?: boolean;
  failed?: boolean;
  from?: "agent" | "parent";
  waiting?: boolean;
  arrive?: boolean;
  label: string;
}> = ({ who, dotStatus, words, stats, text, plain = false, failed = false, from, waiting, arrive, label }) => {
  const [open, setOpen] = useState(false);
  const { ref, foldable } = useFoldable(text);
  const isOpen = open && foldable;
  return (
    <div className="agw-agent-card-row" data-arrive={arrive ? "" : undefined}>
      <div
        className="agw-agent-card"
        role="group"
        aria-label={label}
        data-from={from === "parent" ? "parent" : undefined}
        data-waiting={waiting ? "" : undefined}
        data-open={isOpen ? "" : undefined}
        data-foldable={foldable ? "" : undefined}
      >
        <div className="agw-agent-card-head">
          {dotStatus && <span className="agw-agent-dot" data-status={dotStatus} aria-hidden />}
          {who}
          {/* The rest of the row is the toggle — a tool card's row, so the
              name stays its own link to the agent's tab. */}
          <button
            type="button"
            className="agw-agent-card-toggle"
            aria-expanded={foldable ? isOpen : undefined}
            disabled={!foldable}
            onClick={() => setOpen((v) => !v)}
          >
            <span className="agw-agent-card-words" data-status={failed ? "failed" : undefined}>
              {words}
            </span>
            {stats && <span className="agw-agent-card-stats">{stats}</span>}
            {foldable && (
              <AgentIcon name="chevron-down" size={13} className="agw-agent-card-chev" />
            )}
          </button>
        </div>
        <div className="agw-agent-card-text" ref={ref}>
          {plain ? <div className="agw-agent-card-plain">{text}</div> : <AgentMarkdown content={text} />}
        </div>
      </div>
    </div>
  );
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
  // The conversation this card is drawn in. A docked chat declares its own
  // through the scope; reading the open chat looked the agent up under the
  // main pane's conversation, where it is not.
  const scope = useConversationScope();
  const openThreadId = useAgentChatStore((s) => s.currentThreadId);
  const parentThreadId = scope?.threadId ?? openThreadId;
  const openAgentTab = useAgentWorkspaceStore((s) => s.openAgentTab);
  const live = useAgentSubagentStore((s) =>
    parentThreadId
      ? s.byParent[parentThreadId]?.find((row) => row.agentId === report.agentId)
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
    // A brief from the parent is often hundreds of words — the same text
    // area folds it to its first lines.
    return (
      <CardShell
        from="parent"
        waiting={waiting}
        label={`Message from ${parentTitle?.trim() || "the parent agent"}`}
        who={<span className="agw-agent-name agw-agent-name-static">{parentTitle?.trim() || "Parent agent"}</span>}
        words={waiting ? "waiting for its next step" : "from the parent"}
        text={report.summary.trim()}
        plain
      />
    );
  }

  const openTab = () => {
    if (!parentThreadId || !report.agentId) return;
    openAgentTab(parentThreadId, report.agentId, name);
  };

  return (
    <CardShell
      arrive={report.arrivedLive}
      label={`Report from ${name}`}
      dotStatus={status}
      who={
        <button type="button" className="agw-agent-name" onClick={openTab} title={`Open ${name}`}>
          {name}
        </button>
      }
      words={
        <>
          {type && <span>{type}</span>}
          {type && <span aria-hidden>·</span>}
          <span>{word}</span>
        </>
      }
      // `7m 55s · 80 tool calls · 252023 tokens` — the numbers, on the right.
      stats={meta}
      failed={status === "failed"}
      text={body || report.summary}
    />
  );
};
