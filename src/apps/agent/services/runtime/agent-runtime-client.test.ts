import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Hoisted mocks for the IPC primitives ────────────────────────────
type InvokeFn = (command: string, args?: unknown) => Promise<unknown>;
const invokeMock = vi.hoisted(() => vi.fn<InvokeFn>().mockResolvedValue(undefined));
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

vi.mock("@/kernel/lib/ipc/runtime", () => ({
  auroraInvoke: invokeMock,
  auroraListen: listenMock,
}));

// ── Hoisted mocks for the MCP bridge ────────────────────────────────
//
// After the Rust migration, only `mcp_*` tools round-trip through the
// frontend bridge. Native Rust tools are dispatched server-side and
// never reach `dispatchToolPending`. The tests below mock the MCP
// helpers so we can exercise the bridge without booting an MCP server.
type ExecuteMcpToolFn = (name: string, input: Record<string, unknown>) => Promise<string>;
const executeMcpToolMock = vi.hoisted(() =>
  vi.fn<ExecuteMcpToolFn>().mockResolvedValue("mcp-result"),
);
const isMcpToolMock = vi.hoisted(() =>
  vi.fn((name: string) => name.startsWith("mcp_")),
);
const shouldAutoApproveMcpToolMock = vi.hoisted(() => vi.fn(() => true));
vi.mock("@/apps/agent/services/tools/mcp-tools", () => ({
  executeMcpTool: executeMcpToolMock,
  isMcpTool: isMcpToolMock,
  shouldAutoApproveMcpTool: shouldAutoApproveMcpToolMock,
}));

import {
  AGENT_CANCEL_COMMAND,
  AGENT_CHAT_COMMAND,
  AGENT_COMPACT_THREAD_COMMAND,
  AGENT_EVENT_CHANNEL,
  AGENT_POST_TOOL_RESULT_COMMAND,
  AGENT_TOOL_PENDING_CHANNEL,
  AGENT_TURN_COMPLETE_CHANNEL,
  AGENT_TURN_ERROR_CHANNEL,
  AgentRuntimeClient,
  type AgentRuntimeCallbacks,
  type AgentRuntimeChatInput,
  type AgentRuntimeClientOptions,
} from "@/apps/agent/services/runtime/agent-runtime-client";
import type { ProviderConfig } from "@/kernel/services/providers/types";

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

describe("AgentRuntimeClient.buildProviderConfigSnapshot", () => {
  it("forwards the selected API type for a user-added provider", () => {
    // A user-added provider's row id is a UUID. Rust dispatches on the
    // provider TYPE; if the snapshot drops it, dispatch falls back to the
    // UUID, matches nothing, and silently runs Chat Completions instead of
    // the API type the user picked.
    const snapshot = AgentRuntimeClient.buildProviderConfigSnapshot({
      ...sampleProviderConfig,
      id: "b1846984-2777-4815-8a29-90e29392a8e6",
      providerType: "openai-responses",
    });

    expect(snapshot.providerId).toBe("b1846984-2777-4815-8a29-90e29392a8e6");
    expect(snapshot.providerType).toBe("openai-responses");
  });

  it("forwards the canonical reasoning contract intact", () => {
    const reasoning = {
      enabled: true,
      control: "effort" as const,
      effort: "high",
      requestMode: "openai-effort" as const,
      replay: "reasoning_content" as const,
    };

    const snapshot = AgentRuntimeClient.buildProviderConfigSnapshot({
      ...sampleProviderConfig,
      reasoning,
    });

    expect(snapshot.reasoning).toEqual(reasoning);
  });
});

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
      executionMode: "agent",
    });

    expect(request.providerConfig).toEqual({
      providerId: "fireworks",
      // Must be forwarded: Rust picks the wire shape from this, and falling
      // back to `providerId` sends every custom (UUID-id) provider to Chat
      // Completions no matter which API type the user selected.
      providerType: "fireworks",
      baseUrl: "https://api.fireworks.ai",
      apiKey: "fw-test-key",
      model: "accounts/fireworks/models/glm-4p7",
      customHeaders: { "X-Foo": "bar" },
      customParams: { reasoning_effort: "medium" },
      defaultTemperature: 0.5,
      defaultMaxTokens: 4096,
      supportsThinking: true,
      supportsVision: false,
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
    expect(request.thinkingBudgetTokens).toBeNull();
    // Provider's window still flows through even with a minimal config.
    expect(request.contextWindow).toBe(128000);
  });

  it("keeps Cursor's stable selection separate from its wire model", () => {
    const request = AgentRuntimeClient.buildRequest({
      turnId: "cursor-turn",
      threadId: "cursor-thread",
      input: {
        ...sampleInput,
        modelSelection: "cursor:cursor-grok-4.6",
      },
      providerConfig: {
        ...sampleProviderConfig,
        id: "cursor",
        providerType: "cursor",
        model: "cursor-grok-4.6-xhigh-fast",
      },
      config: {},
    });

    expect(request.model).toBe("cursor-grok-4.6-xhigh-fast");
    expect(request.modelSelection).toBe("cursor:cursor-grok-4.6");
    expect(request.providerConfig.model).toBe("cursor-grok-4.6-xhigh-fast");
  });

  it("forwards an explicit thinking budget and nulls a non-positive one", () => {
    const build = (thinkingBudgetTokens?: number) =>
      AgentRuntimeClient.buildRequest({
        turnId: "t",
        threadId: "thread-1",
        input: sampleInput,
        providerConfig: sampleProviderConfig,
        config: { thinkingEnabled: true, thinkingBudgetTokens },
      });

    expect(build(16000).thinkingBudgetTokens).toBe(16000);
    // Rounded — the slider is log-scaled and can land on a fraction.
    expect(build(16000.4).thinkingBudgetTokens).toBe(16000);
    // 0 / undefined both mean "no explicit budget": the Rust adapter then
    // derives one from the effort tier instead of sending a bogus 0.
    expect(build(0).thinkingBudgetTokens).toBeNull();
    expect(build().thinkingBudgetTokens).toBeNull();
  });

  it("derives legacy thinking mirrors from the canonical contract", () => {
    const request = AgentRuntimeClient.buildRequest({
      turnId: "t",
      threadId: "thread-1",
      input: sampleInput,
      providerConfig: {
        ...sampleProviderConfig,
        reasoning: {
          enabled: true,
          control: "budget",
          budgetTokens: 12_500.4,
          requestMode: "anthropic-budget",
          replay: "off",
        },
      },
      config: {
        reasoning: {
          enabled: true,
          control: "budget",
          budgetTokens: 12_500.4,
          requestMode: "anthropic-budget",
          replay: "off",
        },
        // Deliberately contradictory legacy values: canonical wins.
        thinkingEnabled: false,
        thinkingBudgetTokens: 2000,
      },
    });

    expect(request.thinkingEnabled).toBe(true);
    expect(request.thinkingBudgetTokens).toBe(12_500);
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

  it("sends Plan mode as an explicit runtime boundary value", () => {
    const request = AgentRuntimeClient.buildRequest({
      turnId: "t-plan",
      threadId: "thread-1",
      input: sampleInput,
      providerConfig: sampleProviderConfig,
      config: { executionMode: "plan" },
    });

    expect(request.executionMode).toBe("plan");
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

  it("shows the wrapped target across streaming and execution events with one call id", async () => {
    const onToolCall = vi.fn();
    const onToolExecutionComplete = vi.fn();
    const client = buildClient({ onToolCall, onToolExecutionComplete });
    const promise = client.chat(sampleInput);
    const { turnId } = await awaitChatInvocation();
    const input = { name: "browser_navigate", arguments: { url: "https://example.test" } };
    dispatch(AGENT_EVENT_CHANNEL, { turnId, seq: 1, event: { type: "tool_use_delta", id: "wrapped-id", name: "call_tool", arguments: JSON.stringify(input) } });
    dispatch(AGENT_EVENT_CHANNEL, { turnId, seq: 2, event: { type: "tool_use", id: "wrapped-id", name: "call_tool", input } });
    dispatch(AGENT_EVENT_CHANNEL, { turnId, seq: 3, event: { type: "tool_execution_start", id: "wrapped-id", name: "browser_navigate", input: input.arguments } });
    dispatch(AGENT_EVENT_CHANNEL, { turnId, seq: 4, event: { type: "tool_execution_result", id: "wrapped-id", name: "browser_navigate", input: input.arguments, content: "opened", is_error: false } });
    const expected = { id: "wrapped-id", type: "function", function: { name: "browser_navigate", arguments: JSON.stringify(input.arguments) } };
    expect(onToolCall).toHaveBeenCalledTimes(3);
    for (const [call] of onToolCall.mock.calls) expect(call).toEqual(expected);
    expect(onToolExecutionComplete).toHaveBeenCalledWith(expected, "opened");
    dispatch(AGENT_TURN_COMPLETE_CHANNEL, { turnId, finalText: "done" });
    await promise;
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
    const onStreamAttemptStarted = vi.fn();
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
      onStreamAttemptStarted,
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
      seq: 0,
      event: { type: "stream_attempt_started" },
    });
    expect(onStreamAttemptStarted).toHaveBeenCalledTimes(1);

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
      // Cursor's adapter derives these two fields from its provider checkpoint.
      // Their sum must reach the context ring unchanged and unmarked as an
      // Aurora estimate.
      event: { type: "usage", input_tokens: 1_450, output_tokens: 84 },
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
    expect(onUsage).toHaveBeenCalledWith({
      promptTokens: 1_450,
      completionTokens: 84,
      totalTokens: 1_534,
      cacheReadTokens: undefined,
      cacheWriteTokens: undefined,
      estimated: undefined,
      costUsd: undefined,
    });
    expect(onMessageStop).toHaveBeenCalledWith("end_turn");
    expect(onError).not.toHaveBeenCalled();

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

describe("AgentRuntimeClient.compactThread", () => {
  beforeEach(() => {
    invokeMock.mockReset().mockImplementation(async (command, args) => {
      if (command !== AGENT_COMPACT_THREAD_COMMAND) return undefined;
      const { turnId } = (args as { request: { turnId: string } }).request;
      dispatch(AGENT_EVENT_CHANNEL, {
        turnId,
        seq: 1,
        event: { type: "compaction_started" },
      });
      dispatch(AGENT_EVENT_CHANNEL, {
        turnId,
        seq: 2,
        event: {
          type: "compaction_completed",
          before_tokens: 96_000,
          after_tokens: 24_000,
        },
      });
      return [96_000, 24_000];
    });
    listenHandlers.clear();
    listenUnsubs.clear();
    listenMock.mockClear();
  });

  it("routes compaction events and resolves from the command result without a turn-complete event", async () => {
    const onCompactionStarted = vi.fn();
    const onCompactionCompleted = vi.fn();
    const client = buildClient({ onCompactionStarted, onCompactionCompleted });

    const result = await client.compactThread({
      systemPrompt: sampleInput.systemPrompt,
      ideContext: sampleInput.ideContext,
      tools: [],
      workspacePath: sampleInput.workspacePath,
      attachedSelectedElements: null,
      attachedPromptChips: null,
    });

    expect(result).toEqual({ beforeTokens: 96_000, afterTokens: 24_000 });
    expect(onCompactionStarted).toHaveBeenCalledTimes(1);
    expect(onCompactionCompleted).toHaveBeenCalledWith(96_000, 24_000);
    expect(invokeMock).toHaveBeenCalledWith(
      AGENT_COMPACT_THREAD_COMMAND,
      expect.objectContaining({
        request: expect.objectContaining({
          threadId: "thread-1",
          userMessage: "",
        }),
      }),
    );
    expect(client.isRunning()).toBe(false);
    expect(Array.from(listenUnsubs.values())).toEqual([
      expect.any(Function),
    ]);
    expect(Array.from(listenUnsubs.values())[0]).toHaveBeenCalledTimes(1);
  });

  it("routes a failed compaction as failure and never as completion", async () => {
    invokeMock.mockImplementationOnce(async (command, args) => {
      if (command !== AGENT_COMPACT_THREAD_COMMAND) return undefined;
      const { turnId } = (args as { request: { turnId: string } }).request;
      dispatch(AGENT_EVENT_CHANNEL, {
        turnId,
        seq: 1,
        event: { type: "compaction_started" },
      });
      dispatch(AGENT_EVENT_CHANNEL, {
        turnId,
        seq: 2,
        event: {
          type: "compaction_failed",
          before_tokens: 269_000,
          reason: "empty_summary",
          cancelled: false,
        },
      });
      return null;
    });
    const onCompactionCompleted = vi.fn();
    const onCompactionFailed = vi.fn();
    const client = buildClient({ onCompactionCompleted, onCompactionFailed });

    const result = await client.compactThread({
      systemPrompt: sampleInput.systemPrompt,
      ideContext: sampleInput.ideContext,
      tools: [],
      workspacePath: sampleInput.workspacePath,
      attachedSelectedElements: null,
      attachedPromptChips: null,
    });

    expect(result).toBeNull();
    expect(onCompactionCompleted).not.toHaveBeenCalled();
    expect(onCompactionFailed).toHaveBeenCalledWith({
      beforeTokens: 269_000,
      reason: "empty_summary",
      cancelled: false,
    });
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
      expect(args.content).toContain("Rust runtime has no executor");
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

  it("includes exact prompt-chip metadata on the runtime request", () => {
    const attachedPromptChips = [
      {
        kind: "file" as const,
        title: "main.ts",
        value: "src/main.ts",
        path: "E:/work/src/main.ts",
      },
      { kind: "mcp" as const, title: "filesystem" },
    ];
    const request = AgentRuntimeClient.buildRequest({
      turnId: "t-chips",
      threadId: "thread-1",
      input: { ...sampleInput, attachedPromptChips },
      providerConfig: sampleProviderConfig,
      config: {},
    });

    expect(request.attachedPromptChips).toEqual(attachedPromptChips);
  });

  it("cleans up partial subscriptions when listener setup fails", async () => {
    const firstUnsub = vi.fn();
    listenMock
      .mockImplementationOnce(async (eventName: string, handler: ListenHandler) => {
        listenHandlers.set(eventName, handler);
        return firstUnsub;
      })
      .mockRejectedValueOnce(new Error("event bridge unavailable"));
    const onError = vi.fn();
    const client = buildClient({ onError });

    await expect(client.chat(sampleInput)).rejects.toThrow("event bridge unavailable");

    expect(firstUnsub).toHaveBeenCalledTimes(1);
    expect(client.isRunning()).toBe(false);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "event bridge unavailable" }),
    );
    expect(invokeMock).not.toHaveBeenCalledWith(AGENT_CHAT_COMMAND, expect.anything());
  });

  // The runtime's `error` event used to hit a bare `case "error": break;` — the
  // only event in the switch with no callback. That is how a turn cut off at the
  // output-token cap reached the user as a stream that simply stopped: Rust sent
  // the "this reply is cut off" warning and the client dropped it on the floor.
  it("surfaces a recoverable runtime error as a notice without failing the turn", async () => {
    const onRuntimeNotice = vi.fn();
    const onError = vi.fn();
    const client = buildClient({ onRuntimeNotice, onError });
    const promise = client.chat(sampleInput);
    const { turnId } = await awaitChatInvocation();

    dispatch(AGENT_EVENT_CHANNEL, {
      turnId,
      seq: 1,
      event: {
        type: "error",
        message: "This reply is cut off — the model reached its output limit.",
        recoverable: true,
      },
    });

    expect(onRuntimeNotice).toHaveBeenCalledWith({
      message: "This reply is cut off — the model reached its output limit.",
      recoverable: true,
    });
    // Recoverable: the turn is still alive, so this is NOT an error path.
    expect(onError).not.toHaveBeenCalled();

    dispatch(AGENT_TURN_COMPLETE_CHANNEL, {
      turnId,
      stop_reason: "length",
      iterations: 1,
    });
    await promise;
  });

  it("also routes a non-recoverable runtime error to onError", async () => {
    const onRuntimeNotice = vi.fn();
    const onError = vi.fn();
    const client = buildClient({ onRuntimeNotice, onError });
    const promise = client.chat(sampleInput);
    const { turnId } = await awaitChatInvocation();

    dispatch(AGENT_EVENT_CHANNEL, {
      turnId,
      seq: 1,
      event: { type: "error", message: "provider exploded", recoverable: false },
    });

    expect(onRuntimeNotice).toHaveBeenCalledWith({
      message: "provider exploded",
      recoverable: false,
    });
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "provider exploded" }),
    );

    dispatch(AGENT_TURN_ERROR_CHANNEL, { turnId, error: "provider exploded" });
    await expect(promise).rejects.toThrow("provider exploded");
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

  it("reports one error when a failed turn arrives through every terminal channel", async () => {
    let rejectInvoke!: (error: Error) => void;
    invokeMock.mockImplementation(
      async (command) =>
        command === AGENT_CHAT_COMMAND
          ? new Promise<void>((_resolve, reject) => {
              rejectInvoke = reject;
            })
          : undefined,
    );
    const onError = vi.fn();
    const client = buildClient({ onError });
    const promise = client.chat(sampleInput);
    const { turnId } = await awaitChatInvocation();
    const providerError = "provider returned HTTP 503 (request id: same-request)";

    dispatch(AGENT_EVENT_CHANNEL, {
      turnId,
      seq: 1,
      event: { type: "error", message: providerError, recoverable: true },
    });
    dispatch(AGENT_TURN_ERROR_CHANNEL, { turnId, error: providerError });
    rejectInvoke(new Error(providerError));

    await expect(promise).rejects.toThrow(providerError);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: providerError }),
    );
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
