/**
 * Agent Window — the work card's header words [pure].
 */

import { describeToolActivity } from "@/apps/agent/components/conversation/activity";
import type { IndexedRow, WorkTally } from "@/apps/agent/components/conversation/work-log/split-turn";

/** What the turn is doing right now, from its newest work row. */
export function nowDoing(work: readonly IndexedRow[]): string {
  for (let i = work.length - 1; i >= 0; i -= 1) {
    const row = work[i].row;
    if (row.type === "tools") {
      const call = row.tools[row.tools.length - 1];
      return call ? describeToolActivity(call.name, call.arguments || "").label : "Working";
    }
    if (row.type === "chapter") return row.title;
    if (row.type === "thinking") return "Thinking";
  }
  return "Working";
}

/** "73 thoughts · 144 calls · 29 files read · 99 commands", zeros left out. */
export function tallyLine(tally: WorkTally): string {
  const parts: string[] = [];
  const count = (n: number, one: string, many: string) => {
    if (n > 0) parts.push(`${n} ${n === 1 ? one : many}`);
  };
  count(tally.thoughts, "thought", "thoughts");
  count(tally.calls, "call", "calls");
  count(tally.reads, "file read", "files read");
  count(tally.commands, "command", "commands");
  return parts.join(" · ");
}
