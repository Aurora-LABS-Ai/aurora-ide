import type { ToolCall } from "./tool-call";
import { toolCallForDisplay } from "@/apps/agent/services/tools/tool-invocation";
import { parseMcpToolName } from "@/apps/agent/services/tools/mcp-tools";

/** Read only a closed top-level name string. Nested request fields and strings
 * inside a script cannot identify the invocation. This is presentation only. */
function streamedInvocationName(raw: string): string | null {
  if (!raw.trimStart().startsWith("{")) return null;
  let depth = 0;
  for (let i = 0; i < raw.length; i++) {
    const char = raw[i];
    if (char === "{" || char === "[") depth++;
    else if (char === "}" || char === "]") depth--;
    else if (char === '"') {
      const start = i++;
      for (; i < raw.length; i++) {
        if (raw[i] === "\\") i++;
        else if (raw[i] === '"') break;
      }
      if (i >= raw.length) return null;
      if (depth !== 1) continue;
      let cursor = i + 1;
      while (/\s/.test(raw[cursor] ?? "")) cursor++;
      if (raw[cursor] !== ":") continue;
      try {
        if (JSON.parse(raw.slice(start, i + 1)) !== "name") continue;
        cursor++;
        while (/\s/.test(raw[cursor] ?? "")) cursor++;
        if (raw[cursor] !== '"') return null;
        const valueStart = cursor++;
        for (; cursor < raw.length; cursor++) {
          if (raw[cursor] === "\\") cursor++;
          else if (raw[cursor] === '"') {
            return JSON.parse(raw.slice(valueStart, cursor + 1)) as string;
          }
        }
      } catch {
        return null;
      }
      return null;
    }
  }
  return null;
}

/**
 * Which server a call belongs to, or null if it is not an MCP call.
 *
 * This is the key a lane groups on: consecutive calls sharing it are one run to
 * one server. It resolves through `mcpCallForCard`, so a call still wearing its
 * `call_tool` envelope groups with the plainly-named calls around it instead of
 * splitting the lane in two.
 */
export function mcpServerIdForCard(call: ToolCall): string | null {
  const resolved = mcpCallForCard(call);
  if (!resolved) return null;
  const serverId = parseMcpToolName(resolved.name)?.serverId;
  if (serverId) return serverId;
  // The server is gone from the config, or has not loaded yet, so its id cannot
  // be separated from the tool name (both may contain underscores). Key on the
  // whole name instead: two calls to the SAME tool still group, and two calls
  // that might be different servers never do. The alternative — one bucket for
  // everything unresolved — would put two vendors under one header.
  return `unresolved:${resolved.name}`;
}

/** Keep provider/event data intact. Only the card previews an MCP target before
 * its large argument object is complete; execution still uses Rust's gate. */
export function mcpCallForCard(call: ToolCall): ToolCall | null {
  if (call.name.startsWith("mcp_")) return call;
  if (call.name !== "call_tool") return null;
  const projected = toolCallForDisplay({
    id: call.id, type: "function",
    function: { name: call.name, arguments: call.arguments },
  });
  if (projected.function.name.startsWith("mcp_")) {
    return { ...call, name: projected.function.name, arguments: projected.function.arguments };
  }
  // A complete but invalid envelope must keep its real wrapper error card.
  try {
    JSON.parse(call.arguments);
    return null;
  } catch {
    if (call.result != null) return null;
    const name = streamedInvocationName(call.arguments);
    return name?.startsWith("mcp_") ? { ...call, name, arguments: "" } : null;
  }
}
