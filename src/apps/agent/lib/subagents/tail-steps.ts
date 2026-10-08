/**
 * A sub-agent's work as tail lines [pure].
 *
 * The Agents tab's live tail shows the SHAPE of an agent's work, oldest first:
 * the tools it ran (drawn as the transcript's own tool rows), what it thought,
 * what it said, and the messages that reached it from the parent. It reads
 * the same merged transcript the agent's tab does (file + live stream), so the
 * two never disagree.
 *
 * Probe: Documents/aurora-agent-preview-designs.html, 06 (picked 2026-10-08).
 */

import { buildTurns } from "@/apps/agent/components/conversation/timeline";
import type { ToolCall } from "@/apps/agent/components/tools/tool-call";
import type { DbMessage } from "@/apps/agent/services/threads/thread-service";
import type { PendingParentMessage } from "@/apps/agent/store/subagents/useAgentSubagentStore";

/**
 * `live` marks a line that arrived from the agent's stream while the window
 * watched, as opposed to one read from its file. Only live lines animate in:
 * opening an old agent must not start an arrival animation on every line of
 * its history at once.
 */
export type TailStep = (
  | { kind: "tool"; id: string; call: ToolCall }
  | { kind: "thought"; id: string; text: string }
  | { kind: "said"; id: string; text: string }
  | { kind: "note"; id: string; text: string }
  | { kind: "parent"; id: string; text: string; waiting?: boolean }
) & { live?: boolean };

const flat = (text: string): string => text.replace(/\s+/g, " ").trim();

/** The id `mergeLive` gives the streamed reply laid over the file. */
const isLiveMessage = (id: string): boolean => id.startsWith("live-");

export function tailSteps(messages: DbMessage[], pending: PendingParentMessage[] = []): TailStep[] {
  const steps: TailStep[] = [];
  // Which turn each live event belongs to is lost in the merge, so the live
  // reply's events are known by their ids.
  const liveIds = new Set<string>();
  for (const m of messages) {
    if (!isLiveMessage(m.id) || !Array.isArray(m.timeline)) continue;
    for (const e of m.timeline as { id?: unknown }[]) {
      if (typeof e?.id === "string") liveIds.add(e.id);
    }
  }
  const push = (step: TailStep) => {
    steps.push(liveIds.has(step.id) ? { ...step, live: true } : step);
  };
  for (const turn of buildTurns(messages)) {
    if (turn.role === "user") {
      const text = flat(turn.content);
      if (text) push({ kind: "parent", id: turn.id, text });
      continue;
    }
    if (turn.role !== "assistant") continue;
    for (const event of turn.events) {
      switch (event.kind) {
        case "tool":
          push({ kind: "tool", id: event.id, call: event.call });
          break;
        case "thinking": {
          const text = flat(event.text);
          if (text) push({ kind: "thought", id: event.id, text });
          break;
        }
        case "content": {
          const text = flat(event.text);
          // The runtime's filler (a block of dots between tool calls) is not
          // something the agent said.
          if (text && !/^[.\-–—…\s]+$/.test(text)) push({ kind: "said", id: event.id, text });
          break;
        }
        case "user_injection":
          push({ kind: "parent", id: event.id, text: flat(event.text) });
          break;
        case "process_beat":
          push({ kind: "note", id: event.id, text: flat(event.text) });
          break;
        default:
          break;
      }
    }
  }
  // Sent a moment ago and shown at once: these arrive while the window watches.
  for (const message of pending) {
    steps.push({ kind: "parent", id: message.id, text: flat(message.text), waiting: true, live: true });
  }
  return steps;
}
