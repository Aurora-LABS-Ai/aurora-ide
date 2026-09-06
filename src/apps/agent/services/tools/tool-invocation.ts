import type { ToolCallRequest } from "@/kernel/services/providers/types";

/** Project a completed invocation for tool cards only. Wire history and
 * execution authorization belong to Rust and retain the original envelope. */
export function toolCallForDisplay(call: ToolCallRequest): ToolCallRequest {
  if (call.function.name !== "call_tool") return call;
  try {
    const input: unknown = JSON.parse(call.function.arguments);
    if (!input || typeof input !== "object") return call;
    const { name, arguments: args } = input as Record<string, unknown>;
    if (
      typeof name !== "string" || !name ||
      name === "call_tool" || name === "tool_search" ||
      !args || typeof args !== "object" || Array.isArray(args)
    ) return call;
    return { ...call, function: { name, arguments: JSON.stringify(args) } };
  } catch {
    // Streaming arguments may be incomplete. Keep the preview until the
    // complete tool_use event supplies an unambiguous operation.
    return call;
  }
}
