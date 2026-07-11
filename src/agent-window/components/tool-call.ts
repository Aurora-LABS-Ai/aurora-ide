/**
 * Agent Window — tool-call contract + status (leaf, non-component).
 *
 * Kept out of `ToolCallCard.tsx` so that file only exports a component (Fast
 * Refresh rule) and so `ToolGroup` can share the status helper without a
 * component import cycle.
 */

export interface ToolCall {
  id: string;
  name: string;
  /** JSON-encoded argument object (provider format). */
  arguments: string;
  result?: string | null;
}

export type ToolStatus = "running" | "done" | "failed";

/**
 * Infer a tool's status. `isActivelyStreaming` distinguishes a tool that is
 * genuinely in flight (turn streaming) from a stale one left "running" by a
 * previous session — the IDE treats the latter as failed.
 */
export function toolStatus(call: ToolCall, isActivelyStreaming = false): ToolStatus {
  const r = call.result;
  if (r == null || r === "") return isActivelyStreaming ? "running" : "failed";
  if (/^\s*\[(error|rejected)\]/i.test(r)) return "failed";
  return "done";
}
