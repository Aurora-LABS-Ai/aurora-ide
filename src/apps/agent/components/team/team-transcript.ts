/**
 * Agent Window — team-member transcript adapter (leaf, non-component).
 *
 * Converts a member's `AgentTurn[]` (from `team_get_agent_transcript`) into the
 * SAME `TimelineEvent`-backed bubbles the normal conversation renders, so an IC's
 * work shows with the identical thinking blocks, tool-call cards, and markdown as
 * a regular chat. Consecutive assistant turns merge into one bubble (mirrors the
 * conversation's `buildTurns`). Deterministic ids (no global counter) so repeated
 * polls don't remount the list.
 */

import type { AgentToolResult, AgentTurn } from "@/kernel/types/team";
import type { TimelineEvent } from "@/apps/agent/components/conversation/timeline";

/** One rendered bubble — fed straight into `MessageBubble`. */
export interface MemberBubble {
  id: string;
  role: "user" | "assistant";
  /** Concatenated assistant text (for copy) or the user message. */
  content: string;
  /** Assistant only — ordered events (thinking / content / tools). */
  events: TimelineEvent[];
}

/** Build the tool result string the tool card expects (error sentinel prefixed). */
function resultText(res: AgentToolResult | undefined): string | null {
  if (!res || res.content == null) return null;
  return res.isError ? `[error] ${res.content}` : res.content;
}

/**
 * Convert a member's turns into conversation bubbles.
 *
 * The transcript shape (verified against `mergeTurns` + the Rust `AgentTurn`):
 * ONE turn = one conversation message. An assistant turn holds the agent's
 * thinking/prose + its `toolCalls`, but the RESULTS for those calls arrive in
 * the FOLLOWING `tool`-role turn's `toolResults` (paired by index). `user`/
 * `tool`/`system` turns are prompt plumbing (goal injection, live-team updates,
 * nudges, raw tool output) and are NOT rendered on their own — only the agent's
 * assistant turns are shown, each as one bubble carrying its cards + outcomes.
 */
export function buildMemberBubbles(agentId: string, turns: AgentTurn[]): MemberBubble[] {
  const bubbles: MemberBubble[] = [];

  turns.forEach((turn, i) => {
    if (turn.role !== "assistant") return; // plumbing turn — skip

    const events: TimelineEvent[] = [];
    if (turn.thinking) {
      events.push({ kind: "thinking", id: `${agentId}-${i}-th`, text: turn.thinking });
    }
    if (turn.text) {
      events.push({ kind: "content", id: `${agentId}-${i}-c`, text: turn.text });
    }

    // Results live in the next tool-role turn, paired by index with the calls.
    const next = turns[i + 1];
    const results = next && next.role === "tool" ? next.toolResults : [];
    turn.toolCalls.forEach((tc, j) => {
      const id = `${agentId}-${i}-t${j}`;
      events.push({
        kind: "tool",
        id,
        call: { id, name: tc.name, arguments: tc.input, result: resultText(results[j]) },
      });
    });

    if (events.length === 0) return; // empty assistant turn — nothing to show
    bubbles.push({ id: `${agentId}-a${i}`, role: "assistant", content: turn.text, events });
  });

  return bubbles;
}
