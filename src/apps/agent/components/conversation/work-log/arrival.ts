/**
 * Agent Window — work card: is a step drawing now new, or history [pure].
 *
 * Read from the call, once, when the step first draws — never from "it just
 * mounted". The card before decided arrival by mounting, and every remount
 * replayed every step (2026-10-16).
 */

import type { ToolCall } from "@/apps/agent/components/tools/tool-call";

/** A call that started this long ago is history, not an arrival. */
export const ARRIVAL_WINDOW_MS = 800;

/** New: the turn is running and the call has not started, or started just now.
 *  Reopening a chat or switching back to a running one replays nothing. */
export function isArriving(call: ToolCall, streaming: boolean, now: number): boolean {
  if (!streaming) return false;
  return call.startedAt === undefined || now - call.startedAt < ARRIVAL_WINDOW_MS;
}
