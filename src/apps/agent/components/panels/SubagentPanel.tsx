/**
 * Agent Window — one sub-agent's conversation, read-only [view].
 *
 * The child's transcript in the docked-chat view: the same `MessageBubble` and
 * `buildTurns` the main pane uses, no composer (the parent is its user), and a
 * status bar where the composer was. A user-role message in a child's
 * transcript comes from the PARENT agent, not from a person, so it is drawn as
 * a labelled card and never as the user's bubble.
 *
 * Live: `useSubagentTranscript` lays the agent's own stream (thinking, text,
 * tool calls as they happen) over its file, and shows the parent's messages
 * the moment they are sent, marked as waiting until the agent takes them in.
 *
 * Probe: Documents/aurora-agents-panel-designs.html (context panel).
 */

import React, { useLayoutEffect, useMemo } from "react";

import { JumpToLatest } from "@/apps/agent/components/conversation/JumpToLatest";
import { agentElapsedMs, fmtClock, useNow } from "@/apps/agent/components/panels/subagent-clock";
import { AgentLead, StopAgentButton } from "@/apps/agent/components/panels/subagent-parts";
import {
  recallScrollTop,
  rememberScroll,
  subagentMemoryKey,
} from "@/apps/agent/components/panels/subagent-memory";
import { SubagentTurns } from "@/apps/agent/components/panels/SubagentTurns";
import { useAgentAutoScroll } from "@/apps/agent/hooks/conversation/useAgentAutoScroll";
import { useSubagentTranscript } from "@/apps/agent/hooks/subagents/useSubagentTranscript";
import { formatTokens } from "@/apps/agent/lib/thread/model-label";
import { transcriptGrowth } from "@/apps/agent/lib/subagents/transcript-growth";
import { useAgentChatStore } from "@/apps/agent/store/conversation/useAgentChatStore";
import { useAgentSubagentStore } from "@/apps/agent/store/subagents/useAgentSubagentStore";

const OUTCOME_WORD: Record<string, string> = {
  completed: "Finished",
  failed: "Failed",
  killed: "Stopped",
};

const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

export const SubagentPanel: React.FC<{
  parentThreadId: string;
  agentId: string;
  title: string;
}> = ({ parentThreadId, agentId, title }) => {
  const { agent, running, messages, loading, missing, pending } = useSubagentTranscript(
    parentThreadId,
    agentId,
  );
  const kill = useAgentSubagentStore((s) => s.kill);
  const parentTitle = useAgentChatStore((s) =>
    s.currentThreadId === parentThreadId ? (s.currentThread?.title ?? null) : null,
  );
  const key = subagentMemoryKey(parentThreadId, agentId);
  const now = useNow(running);

  // The last message grows in place as the agent streams, without the
  // message count changing. Follow the amount of content, not the count.
  const growth = useMemo(() => transcriptGrowth(messages) + pending.length, [messages, pending]);
  // Where the reader was when this tab was last shown: a position they had
  // scrolled to is put back before paint; "bottom" (or nothing remembered)
  // leaves the hook's own bottom anchor in charge.
  const { containerRef, contentRef, bottomRef, showJump, jumpToBottom } = useAgentAutoScroll({
    isStreaming: running,
    resetKey: agentId,
    growthKey: growth,
    restoreScrollTop: recallScrollTop(key),
  });
  // Remember it on the way out. Re-bound when the scroller appears (`loading`
  // flips), because a first open renders "Loading…" before any scroller
  // exists and a cleanup bound to nothing would remember nothing.
  useLayoutEffect(() => {
    const el = containerRef.current;
    return () => {
      if (el) rememberScroll(key, el);
    };
  }, [containerRef, key, loading]);

  const toolCallsSeen = useMemo(
    () => messages.reduce((sum, m) => sum + (m.tool_calls?.length ?? 0), 0),
    [messages],
  );

  const footer = (() => {
    if (!agent) return "Controlled by the parent";
    const parts: string[] = [];
    if (running) {
      parts.push("Controlled by the parent", agent.agentType);
      parts.push(plural(toolCallsSeen, "tool call"));
      parts.push(fmtClock(agentElapsedMs({ ...agent, status: "running" }, now)));
    } else {
      parts.push(OUTCOME_WORD[agent.status] ?? "Finished", agent.agentType);
      parts.push(plural(agent.usage.toolCalls, "tool call"));
      const tokens = agent.usage.inputTokens + agent.usage.outputTokens;
      if (tokens > 0) parts.push(`${formatTokens(tokens)} tokens`);
      parts.push(fmtClock(agent.usage.durationMs));
    }
    return parts.join(" · ");
  })();

  return (
    <div className="agw-cp-root agw-subagent" aria-label={title}>
      <div className="agw-subagent-main">
        <div ref={containerRef} className="agw-cp-body agw-scroll">
          {missing ? (
            <div className="agw-cp-empty">
              <span>This agent&apos;s transcript could not be found.</span>
            </div>
          ) : loading && messages.length === 0 ? (
            <div className="agw-cp-empty">
              <span>Loading…</span>
            </div>
          ) : messages.length === 0 && pending.length === 0 ? (
            <div className="agw-cp-empty">
              <span>No messages yet.</span>
            </div>
          ) : (
            <div ref={contentRef} className="agw-chatpanel-turns select-text">
              <SubagentTurns
                agentId={agentId}
                title={title}
                parentTitle={parentTitle}
                messages={messages}
                running={running}
                pending={pending}
              />
              <div ref={bottomRef} style={{ height: 1 }} />
            </div>
          )}
        </div>
        <JumpToLatest show={showJump} streaming={running} onJump={() => jumpToBottom()} />
      </div>

      <div className="agw-subagent-foot">
        {agent ? (
          <span className="agw-subagent-foot-lead">
            <AgentLead status={running ? "running" : agent.status} />
          </span>
        ) : null}
        <span className="agw-subagent-foot-line">{footer}</span>
        {running ? (
          <StopAgentButton agentId={agentId} label={title} onStop={kill} />
        ) : (
          agent && (
            <span className="agw-subagent-foot-note">The parent can send it more work</span>
          )
        )}
      </div>
    </div>
  );
};
