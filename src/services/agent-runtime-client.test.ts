import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Hoisted mocks for the IPC primitives ────────────────────────────
const invokeMock = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => undefined as unknown));
type ListenHandler = (event: { event: string; payload: unknown }) => void;
const listenHandlers = vi.hoisted(() => new Map<string, ListenHandler>());
const listenUnsubs = vi.hoisted(() => new Map<string, () => void>());
const listenMock = vi.hoisted(() =>
  vi.fn(async (eventName: string, handler: ListenHandler) => {
    listenHandlers.set(eventName, handler);
    const unsub = vi.fn(() => {
      listenHandlers.delete(eventName);
    });
    listenUnsubs.set(eventName, unsub);
    return unsub;
  }),
);

vi.mock("../lib/runtime", () => ({
  auroraInvoke: invokeMock,
  auroraListen: listenMock,
}));

// ── Hoisted mocks for the MCP bridge ────────────────────────────────
//
// After the Rust migration, only `mcp_*` tools round-trip through the
// frontend bridge. Native Rust tools are dispatched server-side and
// never reach `dispatchToolPending`. The tests below mock the MCP
// helpers so we can exercise the bridge without booting an MCP server.
const executeMcpToolMock = vi.hoisted(() =>
  vi.fn(async (_name: string, _args: unknown) => "mcp-result"),
);
const isMcpToolMock = vi.hoisted(() =>
  vi.fn((name: string) => name.startsWith("mcp_")),
);
const shouldAutoApproveMcpToolMock = vi.hoisted(() => vi.fn(() => true));
vi.mock("./mcp-tools", () => ({
  executeMcpTool: executeMcpToolMock,
  isMcpTool: isMcpToolMock,
  shouldAutoApproveMcpTool: shouldAutoApproveMcpToolMock,
}));

import {
  AGENT_CANCEL_COMMAND,
  AGENT_CHAT_COMMAND,
  AGENT_EVENT_CHANNEL,
  AGENT_POST_TOOL_RESULT_COMMAND,
  AGENT_TOOL_PENDING_CHANNEL,
  AGENT_TURN_COMPLETE_CHANNEL,
  AGENT_TURN_ERROR_CHANNEL,
  AgentRuntimeClient,
  type AgentRuntimeCallbacks,
  type AgentRuntimeChatInput,
  type AgentRuntimeClientOptions,
} from "./agent-runtime-client";
import type { ProviderConfig } from "./providers/types";

// ── Test helpers ────────────────────────────────────────────────────

const sampleProviderConfig: ProviderConfig = {
  id: "fireworks",
  name: "Fireworks",
  baseUrl: "https://api.fireworks.ai",
  apiKey: "fw-test-key",
  model: "accounts/fireworks/models/glm-4p7",
  contextWindow: 128000,
  maxOutputTokens: 8192,
  supportsThinking: true,
  supportsToolStream: true,
  supportsVision: false,
  providerType: "fireworks",
  customHeaders: { "X-Foo": "bar" },
  customParams: { reasoning_effort: "medium" },
  defaultTemperature: 0.5,
  defaultMaxTokens: 4096,
};

const sampleInput: AgentRuntimeChatInput = {
  userMessage: "hi",
  systemPrompt: "you are aurora",
  ideContext: "<workspace>...</workspace>",
  tools: [
    {
      type: "function",
      function: {
        name: "file_read",
        description: "Read a file",
        parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      },
    },
  ],
  workspacePath: "E:/VOID-EDITOR/Aurora-Agent-IDE",
};

const buildClient = (
  callbacks: AgentRuntimeCallbacks = {},
  overrides: Partial<AgentRuntimeClientOptions> = {},
) =>
  new AgentRuntimeClient({
    callbacks,
    config: { temperature: 0.7, maxTokens: 1024, thinkingEnabled: true },
    threadId: "thread-1",
    providerConfig: sampleProviderConfig,
    ...overrides,
  });

const dispatch = (channel: string, payload: unknown): void => {
  const handler = listenHandlers.get(channel);
  if (!handler) throw new Error(`No listener registered for ${channel}`);
  handler({ event: channel, payload });
};

/**
 * Wait for `chat()` to finish wiring listeners and call
 * `agent_chat_v2`. Returns the camelCase request the client built so
 * tests can grab the `turnId` and dispatch matching events.
 *
 * The actual `chat()` body does five `await auroraListen(...)` calls
 * before its `auroraInvoke('agent_chat_v2', …)` — the four core
 * channels plus the Phase 4 `agent_permission_request` channel.
 * Those awaits are microtasks, so a synchronous read after
 * `client.chat(input)` is too eager.
 */
const awaitChatInvocation = async (): Promise<{ turnId: string }> => {
  await vi.waitFor(() => {
    const call = invokeMock.mock.calls.find((c) => c[0] === AGENT_CHAT_COMMAND);
    expect(call).toBeDefined();
  });
  const call = invokeMock.mock.calls.find((c) => c[0] === AGENT_CHAT_COMMAND)!;
  return (call[1] as { request: { turnId: string } }).request;
};

describe("AgentRuntimeClient.buildRequest", () => {
  it("builds a camelCase request snapshot from the chat input", () => {
    const request = AgentRuntimeClient.buildRequest({
      turnId: "turn-fixed",
      threadId: "thread-1",
      input: sampleInput,
      providerConfig: sampleProviderConfig,
      config: { temperature: 0.7, maxTokens: 1024, thinkingEnabled: true },
    });

    expect(request).toMatchObject({
      turnId: "turn-fixed",
      threadId: "thread-1",
      userMessage: "hi",
      providerId: "fireworks",
      model: "accounts/fireworks/models/glm-4p7",
      systemPrompt: "you are aurora",
      ideContext: "<workspace>...</workspace>",
      temperature: 0.7,
      maxOutputTokens: 1024,
      thinkingEnabled: true,
      workspacePath: "E:/VOID-EDITOR/Aurora-Agent-IDE",
    });

    expect(request.providerConfig).toEqual({
      providerId: "fireworks",
      baseUrl: "https://api.fireworks.ai",
      apiKey: "fw-test-key",
      model: "accounts/fireworks/models/glm-4p7",
      customHeaders: { "X-Foo": "bar" },
      customParams: { reasoning_effort: "medium" },
      defaultTemperature: 0.5,
      defaultMaxTokens: 4096,
      supportsThinking: true,
      contextWindow: 128000,
      maxOutputTokens: 8192,
    });

    expect(request.tools).toEqual([
      {
        name: "file_read",
        description: "Read a file",
        parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      },
    ]);

    // The Rust runtime uses `contextWindow` to apply a budget-aware
    // trim before each API call. Sourced from the active provider's
    // advertised window so the trim aligns with the chat-header
    // indicator already shown to the user.
    expect(request.contextWindow).toBe(128000);
  });

  it("nulls empty system prompt and ide context per contract", () => {
    const request = AgentRuntimeClient.buildRequest({
      turnId: "t",
      threadId: "thread-1",
      input: { ...sampleInput, systemPrompt: "", ideContext: "" },
      providerConfig: sampleProviderConfig,
      config: {},
    });

    expect(request.systemPrompt).toBeNull();
    expect(request.ideContext).toBeNull();
    expect(request.temperature).toBeNull();
    expect(request.maxOutputTokens).toBeNull();
    expect(request.thinkingEnabled).toBeNull();
    // Provider's window still flows through even with a minimal config.
    expect(request.contextWindow).toBe(128000);
  });

  it("nulls contextWindow when the provider doesn't advertise one", () => {
    const providerWithoutWindow = {
      ...sampleProviderConfig,
      contextWindow: undefined as unknown as number,
    };
    const request = AgentRuntimeClient.buildRequest({
      turnId: "t",
      threadId: "thread-1",
      input: sampleInput,
      providerConfig: providerWithoutWindow,
      config: {},
    });
    // null on the wire means "no enforcement" — the Rust runtime
    // falls back to the legacy whole-session behaviour.
    expect(request.contextWindow).toBeNull();
  });
});

describe("AgentRuntimeClient.chat — event routing", () => {
  beforeEach(() => {
    invokeMock.mockReset().mockImplementation(async () => undefined);
    listenHandlers.clear();
    listenUnsubs.clear();
    listenMock.mockClear();
    executeMcpToolMock.mockClear();
    isMcpToolMock.mockClear();
    shouldAutoApproveMcpToolMock.mockClear();
  });

  afterEach(() => {
    listenHandlers.clear();
    listenUnsubs.clear();
  });

  it("subscribes to all five channels and invokes agent_chat_v2 with the request", async () => {
    const client = buildClient();
    const chatPromise = client.chat(sampleInput);

    const request = await awaitChatInvocation();

    // All five listeners are wired before the IPC call fires (the
    // four core channels plus the Phase 4 permission-request channel).
    expect(listenMock).toHaveBeenCalledTimes(5);
    expect(listenHandlers.has(AGENT_EVENT_CHANNEL)).toBe(true);
    expect(listenHandlers.has(AGENT_TOOL_PENDING_CHANNEL)).toBe(true);
    expect(listenHandlers.has(AGENT_TURN_COMPLETE_CHANNEL)).toBe(true);
    expect(listenHandlers.has(AGENT_TURN_ERROR_CHANNEL)).toBe(true);
    expect(listenHandlers.has("agent_permission_request")).toBe(true);
    expect(typeof request.turnId).toBe("string");

    dispatch(AGENT_TURN_COMPLETE_CHANNEL, {
      turnId: request.turnId,
      stop_reason: "end_turn",
      iterations: 1,
    });

    const result = await chatPromise;
    expect(result.stopReason).toBe("end_turn");
    expect(result.iterations).toBe(1);
  });

  it("routes each AssistantEvent variant to the matching callback", async () => {
    const onToken = vi.fn();
    const onThinking = vi.fn();
    const onToolCall = vi.fn();
    const onToolExecutionStart = vi.fn();
    const onToolExecutionComplete = vi.fn();
    const onToolExecutionError = vi.fn();
    const onUsage = vi.fn();
    const onMessageStop = vi.fn();
    const onError = vi.fn();
    const onStart = vi.fn();

    const client = buildClient({
      onToken,
      onThinking,
      onToolCall,
      onToolExecutionStart,
      onToolExecutionComplete,
      onToolExecutionError,
      onUsage,
      onMessageStop,
      onError,
      onStart,
    });

    const promise = client.chat(sampleInput);
    const { turnId } = await awaitChatInvocation();

    expect(onStart).toHaveBeenCalledTimes(1);

    dispatch(AGENT_EVENT_CHANNEL, {
      turnId,
      seq: 1,
      event: { type: "thinking", text: "let me think" },
    });
    dispatch(AGENT_EVENT_CHANNEL, {
      turnId,
      seq: 2,
      event: { type: "text_delta", delta: "Hello" },
    });
    dispatch(AGENT_EVENT_CHANNEL, {
      turnId,
      seq: 3,
      event: {
        type: "tool_use",
        id: "tu-1",
        name: "file_read",
        input: { path: "package.json" },
      },
    });
    dispatch(AGENT_EVENT_CHANNEL, {
      turnId,
      seq: 4,
      event: {
        type: "tool_execution_start",
        id: "tu-1",
        name: "file_read",
        input: { path: "package.json" },
      },
    });
    dispatch(AGENT_EVENT_CHANNEL, {
      turnId,
      seq: 5,
      event: {
        type: "tool_execution_result",
        id: "tu-1",
        name: "file_read",
        input: { path: "package.json" },
        content: "file contents",
        is_error: false,
      },
    });
    dispatch(AGENT_EVENT_CHANNEL, {
      turnId,
      seq: 6,
      event: {
        type: "tool_execution_result",
        id: "tu-2",
        name: "grep",
        input: { pattern: "TODO" },
        content: "no matches",
        is_error: true,
      },
    });
    dispatch(AGENT_EVENT_CHANNEL, {
      turnId,
      seq: 7,
      event: { type: "usage", input_tokens: 10, output_tokens: 20 },
    });
    dispatch(AGENT_EVENT_CHANNEL, {
      turnId,
      seq: 8,
      event: { type: "message_stop", stop_reason: "end_turn" },
    });
    dispatch(AGENT_EVENT_CHANNEL, {
      turnId,
      seq: 9,
      event: { type: "error", message: "soft error", recoverable: true },
    });

    expect(onThinking).toHaveBeenCalledWith("let me think");
    expect(onToken).toHaveBeenCalledWith("Hello");
    expect(onToolCall).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "tu-1",
        function: expect.objectContaining({
          name: "file_read",
          arguments: JSON.stringify({ path: "package.json" }),
        }),
      }),
    );
    expect(onToolExecutionStart).toHaveBeenCalledWith(
      expect.objectContaining({ id: "tu-1" }),
    );
    expect(onToolExecutionComplete).toHaveBeenCalledWith(
      expect.objectContaining({ id: "tu-1" }),
      "file contents",
    );
    expect(onToolExecutionError).toHaveBeenCalledWith(
      expect.objectContaining({ id: "tu-2" }),
      "no matches",
    );
    expect(onUsage).toHaveBeenCalledWith(
      expect.objectContaining({ promptTokens: 10, completionTokens: 20, totalTokens: 30 }),
    );
    expect(onMessageStop).toHaveBeenCalledWith("end_turn");
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "soft error" }));

    dispatch(AGENT_TURN_COMPLETE_CHANNEL, { turnId, stop_reason: "end_turn", iterations: 1 });
    await promise;
  });

  it("filters events by turnId so concurrent turns don't cross-talk", async () => {
    const onToken = vi.fn();
    const client = buildClient({ onToken });
    const promise = client.chat(sampleInput);
    const { turnId } = await awaitChatInvocation();

    dispatch(AGENT_EVENT_CHANNEL, {
      turnId: "different-turn",
      seq: 1,
      event: { type: "text_delta", delta: "ignored" },
    });
    expect(onToken).not.toHaveBeenCalled();

    dispatch(AGENT_EVENT_CHANNEL, {
      turnId,
      seq: 1,
      event: { type: "text_delta", delta: "kept" },
    });
    expect(onToken).toHaveBeenCalledWith("kept");

    dispatch(AGENT_TURN_COMPLETE_CHANNEL, { turnId, stop_reason: "end_turn", iterations: 1 });
    await promise;
  });
});

describe("AgentRuntimeClient.chat — bridge round-trip", () => {
  beforeEach(() => {
    invokeMock.mockReset().mockImplementation(async () => undefined);
    listenHandlers.clear();
    listenUnsubs.clear();
    listenMock.mockClear();
    executeMcpToolMock.mockReset().mockImplementation(async () => "mcp-result");
    isMcpToolMock
      .mockReset()
      .mockImplementation((name: string) => name.startsWith("mcp_"));
    shouldAutoApproveMcpToolMock.mockReset().mockImplementation(() => true);
  });

  it("dispatches mcp_* tools through executeMcpTool and posts the result back", async () => {
    const client = buildClient();
    const promise = client.chat(sampleInput);
    const { turnId } = await awaitChatInvocation();

    dispatch(AGENT_TOOL_PENDING_CHANNEL, {
      turnId,
      toolUseId: "tu-mcp",
      name: "mcp_database_query",
      input: { sql: "select 1" },
    });

    await vi.waitFor(() => {
      expect(executeMcpToolMock).toHaveBeenCalledTimes(1);
    });

    expect(executeMcpToolMock).toHaveBeenCalledWith(
      "mcp_database_query",
      expect.objectContaining({ sql: "select 1" }),
    );

    await vi.waitFor(() => {
      expect(
        invokeMock.mock.calls.some((call) => call[0] === AGENT_POST_TOOL_RESULT_COMMAND),
      ).toBe(true);
    });

    const post = invokeMock.mock.calls.find(
      (call) => call[0] === AGENT_POST_TOOL_RESULT_COMMAND,
    );
    expect(post?.[1]).toEqual({
      turnId,
      toolUseId: "tu-mcp",
      content: "mcp-result",
      isError: false,
    });

    dispatch(AGENT_TURN_COMPLETE_CHANNEL, { turnId, stop_reason: "end_turn", iterations: 1 });
    await promise;
  });

  it("denies a non-MCP tool that falls through to the frontend bridge", async () => {
    const client = buildClient();
    const promise = client.chat(sampleInput);
    const { turnId } = await awaitChatInvocation();

    dispatch(AGENT_TOOL_PENDING_CHANNEL, {
      turnId,
      toolUseId: "tu-stray",
      name: "file_read",
      input: { path: "package.json" },
    });

    await vi.waitFor(() => {
      const post = invokeMock.mock.calls.find(
        (call) => call[0] === AGENT_POST_TOOL_RESULT_COMMAND,
      );
      expect(post).toBeDefined();
      const args = post?.[1] as { content: string; isError: boolean };
      expect(args.isError).toBe(true);
      expect(args.content).toContain("not registered in the Rust runtime");
    });

    expect(executeMcpToolMock).not.toHaveBeenCalled();

    dispatch(AGENT_TURN_COMPLETE_CHANNEL, { turnId, stop_reason: "end_turn", iterations: 1 });
    await promise;
  });

  it("denies an MCP call when the user rejects via onToolApprovalRequired", async () => {
    shouldAutoApproveMcpToolMock.mockReturnValueOnce(false);
    const onToolApprovalRequired = vi.fn(async () => false);

    const client = buildClient({ onToolApprovalRequired });
    const promise = client.chat(sampleInput);
    const { turnId } = await awaitChatInvocation();

    dispatch(AGENT_TOOL_PENDING_CHANNEL, {
      turnId,
      toolUseId: "tu-deny",
      name: "mcp_database_drop_table",
      input: { table: "users" },
    });

    await vi.waitFor(() => {
      expect(onToolApprovalRequired).toHaveBeenCalledTimes(1);
    });

    await vi.waitFor(() => {
      const post = invokeMock.mock.calls.find(
        (call) => call[0] === AGENT_POST_TOOL_RESULT_COMMAND,
      );
      expect(post).toBeDefined();
      const args = post?.[1] as { content: string; isError: boolean };
      expect(args.isError).toBe(true);
      expect(args.content).toContain("rejected by user");
    });

    expect(executeMcpToolMock).not.toHaveBeenCalled();

    dispatch(AGENT_TURN_COMPLETE_CHANNEL, { turnId, stop_reason: "end_turn", iterations: 1 });
    await promise;
  });

  it("converts a thrown executeMcpTool error into an is_error reply (no deadlock)", async () => {
    executeMcpToolMock.mockRejectedValueOnce(new Error("disk full"));

    const client = buildClient();
    const promise = client.chat(sampleInput);
    const { turnId } = await awaitChatInvocation();

    dispatch(AGENT_TOOL_PENDING_CHANNEL, {
      turnId,
      toolUseId: "tu-throw",
      name: "mcp_database_query",
      input: {},
    });

    await vi.waitFor(() => {
      const post = invokeMock.mock.calls.find(
        (call) => call[0] === AGENT_POST_TOOL_RESULT_COMMAND,
      );
      expect(post).toBeDefined();
      const args = post?.[1] as { content: string; isError: boolean };
      expect(args.isError).toBe(true);
      expect(args.content).toContain("disk full");
    });

    dispatch(AGENT_TURN_COMPLETE_CHANNEL, { turnId, stop_reason: "end_turn", iterations: 1 });
    await promise;
  });
});

describe("AgentRuntimeClient.chat — completion + cleanup", () => {
  beforeEach(() => {
    invokeMock.mockReset().mockImplementation(async () => undefined);
    listenHandlers.clear();
    listenUnsubs.clear();
    listenMock.mockClear();
    executeMcpToolMock.mockClear();
  });

  it("unsubscribes every listener on success", async () => {
    const client = buildClient();
    const promise = client.chat(sampleInput);
    const { turnId } = await awaitChatInvocation();

    const unsubsBefore = Array.from(listenUnsubs.values());
    expect(unsubsBefore).toHaveLength(5);

    dispatch(AGENT_TURN_COMPLETE_CHANNEL, { turnId, stop_reason: "end_turn", iterations: 1 });
    await promise;

    for (const unsub of unsubsBefore) {
      expect(unsub).toHaveBeenCalledTimes(1);
    }
  });

  it("rejects with the runtime error and unsubscribes on agent_turn_error", async () => {
    const onError = vi.fn();
    const client = buildClient({ onError });
    const promise = client.chat(sampleInput);
    const { turnId } = await awaitChatInvocation();

    const unsubsBefore = Array.from(listenUnsubs.values());

    dispatch(AGENT_TURN_ERROR_CHANNEL, { turnId, error: "boom" });

    await expect(promise).rejects.toThrow("boom");
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "boom" }));
    for (const unsub of unsubsBefore) {
      expect(unsub).toHaveBeenCalledTimes(1);
    }
  });

  it("rejects with AbortError when the runtime reports cancellation", async () => {
    const client = buildClient();
    const promise = client.chat(sampleInput);
    const { turnId } = await awaitChatInvocation();

    dispatch(AGENT_TURN_ERROR_CHANNEL, { turnId, error: "cancelled" });

    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
  });

  it("cancel() invokes agent_cancel with the active turn id", async () => {
    const client = buildClient();
    const promise = client.chat(sampleInput);
    const { turnId } = await awaitChatInvocation();

    await client.cancel();
    expect(invokeMock).toHaveBeenCalledWith(AGENT_CANCEL_COMMAND, { turnId });

    // Still need to settle the promise so cleanup runs.
    dispatch(AGENT_TURN_ERROR_CHANNEL, { turnId, error: "cancelled" });
    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
  });

  it("cancel() is a no-op when no turn is in flight", async () => {
    const client = buildClient();
    await expect(client.cancel()).resolves.toBeUndefined();
    expect(invokeMock).not.toHaveBeenCalledWith(
      AGENT_CANCEL_COMMAND,
      expect.anything(),
    );
  });
});
