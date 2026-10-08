/**
 * How much there is to read in a transcript, as one number [pure].
 *
 * A live reply grows in place: its thinking, its text and its tool calls all
 * get longer while the message count stays put. A view that should follow
 * the newest line keys its "something grew" signal on this instead of on
 * the count, or it never moves while the agent works.
 */

import type { DbMessage } from "@/apps/agent/services/threads/thread-service";

const textLength = (value: unknown): number => {
  if (!Array.isArray(value)) return 0;
  let sum = 0;
  for (const event of value) {
    if (!event || typeof event !== "object") continue;
    const text = (event as { text?: unknown }).text;
    if (typeof text === "string") sum += text.length;
    else sum += 1;
  }
  return sum;
};

export function transcriptGrowth(messages: DbMessage[]): number {
  let sum = 0;
  for (const m of messages) {
    sum += typeof m.content === "string" ? m.content.length : 0;
    sum += textLength(m.timeline);
    for (const call of m.tool_calls ?? []) {
      sum += 1 + (call.arguments?.length ?? 0) + (call.result ? 1 : 0);
    }
  }
  return sum;
}
