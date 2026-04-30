import { beforeEach, describe, expect, it, vi } from "vitest";

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

vi.mock("../lib/runtime", () => ({
  auroraInvoke: invokeMock,
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
  beforeEach(() => {
    vi.useRealTimers();
    invokeMock.mockClear();
    executeToolCallMock.mockClear();
    requiresApprovalMock.mockClear();
    executeMcpToolMock.mockClear();
    isMcpToolMock.mockReturnValue(false);
    shouldAutoApproveMcpToolMock.mockClear();
  });

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

  it("rejects write-capable tools in plan mode before approval or execution", async () => {
    const onToolApprovalRequired = vi.fn(async () => true);
    const onToolRejected = vi.fn();
    const runner = new AgentToolRunner({
      threadId: "thread-1",
      isRunning: () => true,
      config: {
        executionMode: "plan",
        autoApproveTools: false,
        getToolApproval: () => "always_ask",
      },
      callbacks: {
        onToolApprovalRequired,
        onToolRejected,
      },
    });

    const result = await runner.executeToolCalls([
      makeToolCall("tool-1", "file_write"),
    ]);

    expect(onToolApprovalRequired).not.toHaveBeenCalled();
    expect(executeToolCallMock).not.toHaveBeenCalled();
    expect(onToolRejected).toHaveBeenCalledWith(
      expect.objectContaining({ id: "tool-1" }),
      expect.stringContaining("Plan mode blocked file_write"),
    );
    expect(result.toolCalls[0]?.status).toBe("rejected");
  });

  it("blocks mutating shell commands in plan mode", async () => {
    const runner = new AgentToolRunner({
      threadId: "thread-1",
      isRunning: () => true,
      config: {
        executionMode: "plan",
        autoApproveTools: true,
        getToolApproval: () => "auto",
      },
      callbacks: {},
    });

    await runner.executeToolCalls([
      {
        id: "tool-1",
        type: "function",
        function: {
          name: "shell_execute",
          arguments: JSON.stringify({ command: "echo test > file.txt" }),
        },
      },
    ]);

    expect(executeToolCallMock).not.toHaveBeenCalled();
  });

  it("fails a stuck tool call when the agent-level timeout expires", async () => {
    vi.useFakeTimers();
    executeToolCallMock.mockImplementationOnce(
      () => new Promise(() => undefined),
    );
    const onToolExecutionError = vi.fn();
    const runner = new AgentToolRunner({
      threadId: "thread-1",
      isRunning: () => true,
      config: {
        autoApproveTools: true,
        getToolApproval: () => "auto",
      },
      callbacks: {
        onToolExecutionError,
      },
    });

    const resultPromise = runner.executeToolCalls([makeToolCall("tool-1")]);

    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    const result = await resultPromise;

    expect(onToolExecutionError).toHaveBeenCalledWith(
      expect.objectContaining({ id: "tool-1" }),
      expect.stringContaining('Tool "file_read" timed out'),
    );
    expect(result.toolCalls[0]?.status).toBe("failed");
  });
});
