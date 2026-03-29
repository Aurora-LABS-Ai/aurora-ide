import { describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn(async () => undefined));
const executeToolCallMock = vi.hoisted(() =>
  vi.fn(async () => ({
    tool_call_id: "tool-1",
    role: "tool",
    content: "ok",
  }))
);
const requiresApprovalMock = vi.hoisted(() => vi.fn(() => true));
const executeMcpToolMock = vi.hoisted(() => vi.fn(async () => "mcp-result"));
const isMcpToolMock = vi.hoisted(() => vi.fn(() => false));
const shouldAutoApproveMcpToolMock = vi.hoisted(() => vi.fn(() => false));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

vi.mock("../tools", () => ({
  toolRegistry: {
    executeToolCall: executeToolCallMock,
    requiresApproval: requiresApprovalMock,
  },
}));

vi.mock("./mcp-tools", () => ({
  executeMcpTool: executeMcpToolMock,
  isMcpTool: isMcpToolMock,
  shouldAutoApproveMcpTool: shouldAutoApproveMcpToolMock,
}));

import { AgentToolRunner } from "./agent-tool-runner";
import type { ToolCallRequest } from "./providers/types";

const makeToolCall = (id: string, name = "file_read"): ToolCallRequest => ({
  id,
  type: "function",
  function: {
    name,
    arguments: JSON.stringify({ path: `file-${id}.ts` }),
  },
});

describe("AgentToolRunner", () => {
  it("requests approval sequentially in tool order", async () => {
    const approvalResolvers: Array<(value: boolean) => void> = [];
    const approvalCalls: string[] = [];
    const runner = new AgentToolRunner({
      threadId: "thread-1",
      isRunning: () => true,
      config: {
        autoApproveTools: false,
        getToolApproval: () => "always_ask",
      },
      callbacks: {
        onToolApprovalRequired: async (toolCall) => {
          approvalCalls.push(toolCall.id);
          return new Promise<boolean>((resolve) => {
            approvalResolvers.push(resolve);
          });
        },
      },
    });

    const runPromise = runner.executeToolCalls([
      makeToolCall("tool-1"),
      makeToolCall("tool-2"),
    ]);

    await vi.waitFor(() => {
      expect(approvalCalls).toEqual(["tool-1"]);
    });

    approvalResolvers[0]?.(true);
    await vi.waitFor(() => {
      expect(approvalCalls).toEqual(["tool-1", "tool-2"]);
    });

    approvalResolvers[1]?.(true);
    const result = await runPromise;

    expect(result.toolCalls.map((toolCall) => toolCall.id)).toEqual([
      "tool-1",
      "tool-2",
    ]);
    expect(executeToolCallMock).toHaveBeenCalledTimes(2);
  });
});
