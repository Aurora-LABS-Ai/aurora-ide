import { describe, expect, it } from "vitest";
import type { ToolCallRequest } from "@/kernel/services/providers/types";
import { toolCallForDisplay } from "./tool-invocation";

const call = (args: string, name = "call_tool"): ToolCallRequest => ({
  id: "provider-id", type: "function", function: { name, arguments: args },
});

describe("optional tool display", () => {
  it("projects the target without mutating the provider call", () => {
    const wire = call(JSON.stringify({ name: "mcp_docs_search", arguments: { query: "report" } }));
    expect(toolCallForDisplay(wire)).toEqual(call('{"query":"report"}', "mcp_docs_search"));
    expect(wire.function.name).toBe("call_tool");
    expect(JSON.parse(wire.function.arguments).name).toBe("mcp_docs_search");
  });
  it.each([
    '{"name":"mcp_docs_search",',
    '{"name":"mcp_docs_search","arguments":[]}',
    '{"name":"call_tool","arguments":{}}',
    '{"name":"tool_search","arguments":{}}',
    '{"arguments":{}}',
    "null",
  ])("retains incomplete or malformed input: %s", (args) => {
    const wire = call(args);
    expect(toolCallForDisplay(wire)).toBe(wire);
  });
  it("leaves core tools alone and supports empty optional arguments", () => {
    const direct = call('{"path":"a.ts"}', "file_read");
    expect(toolCallForDisplay(direct)).toBe(direct);
    expect(toolCallForDisplay(call('{"name":"team_status","arguments":{}}'))).toEqual(call("{}", "team_status"));
  });
});
