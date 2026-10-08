/**
 * Agent Window — one sub-agent's turns [view].
 *
 * What the agent's own tab and its preview in the Agents tab both draw, so
 * the two cannot drift: the transcript's turns, where a user-role message is
 * the PARENT speaking (a labelled card, never the user's bubble), and below
 * them the parent's messages the agent has not taken in yet.
 */

import React, { useMemo } from "react";

import { AgentReportCard } from "@/apps/agent/components/conversation/AgentReportCard";
import { MessageBubble } from "@/apps/agent/components/conversation/MessageBubble";
import { buildTurns, turnWorkedMs } from "@/apps/agent/components/conversation/timeline";
import { ConversationScopeContext } from "@/apps/agent/lib/thread/conversation-scope";
import type { DbMessage } from "@/apps/agent/services/threads/thread-service";
import type { PendingParentMessage } from "@/apps/agent/store/subagents/useAgentSubagentStore";

export const SubagentTurns: React.FC<{
  agentId: string;
  /** The agent's name: the speaker on its own turns. */
  title: string;
  parentTitle: string | null;
  messages: DbMessage[];
  running: boolean;
  pending: PendingParentMessage[];
  /** Tighter spacing for the inline preview. */
  compact?: boolean;
}> = ({ agentId, title, parentTitle, messages, running, pending, compact = false }) => {
  const turns = useMemo(() => buildTurns(messages), [messages]);
  const lastTurnIndex = turns.length - 1;
  const scope = useMemo(() => ({ threadId: agentId, projectRoot: null }), [agentId]);
  const gap = compact ? 12 : 20;

  return (
    <ConversationScopeContext.Provider value={scope}>
      {turns.map((turn, i) => {
        const isAssistant = turn.role === "assistant";
        const isLast = i === lastTurnIndex;
        return (
          <div key={turn.id} style={{ marginTop: i === 0 ? 0 : gap }}>
            {turn.role === "user" ? (
              <AgentReportCard
                from="parent"
                parentTitle={parentTitle ?? "Parent agent"}
                report={{
                  kind: "agent_report",
                  id: turn.id,
                  agentId,
                  name: null,
                  status: "completed",
                  summary: turn.content,
                  detail: "",
                }}
              />
            ) : (
              <MessageBubble
                message={{
                  role: turn.role,
                  content: turn.content,
                  isThinking: turn.isThinking,
                }}
                events={isAssistant ? turn.events : undefined}
                showLabel={isAssistant}
                // Inside an agent's own view the speaker is the agent, by
                // the name the parent gave it, never "Aurora".
                label={title}
                streaming={running && isAssistant && isLast}
                workedMs={isAssistant ? turnWorkedMs(turn) : null}
                startedAt={isAssistant ? turn.startedAt : undefined}
                outputTokens={isAssistant ? turn.outputTokens : undefined}
                outputTokensEstimated={isAssistant ? turn.outputTokensEstimated : undefined}
                showActions={false}
              />
            )}
          </div>
        );
      })}
      {pending.map((message) => (
        <div key={message.id} style={{ marginTop: gap }}>
          <AgentReportCard
            from="parent"
            parentTitle={parentTitle ?? "Parent agent"}
            waiting
            report={{
              kind: "agent_report",
              id: message.id,
              agentId,
              name: null,
              status: "running",
              summary: message.text,
              detail: "",
            }}
          />
        </div>
      ))}
    </ConversationScopeContext.Provider>
  );
};
