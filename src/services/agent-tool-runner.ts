import { parseToolArguments } from "../lib/tool-arguments";
import { auroraInvoke } from "../lib/runtime";
import { toolRegistry } from "../tools";
import { type Message, type ToolCallRequest } from "./providers/types";
import {
  executeMcpTool,
  isMcpTool,
  shouldAutoApproveMcpTool,
} from "./mcp-tools";
import type {
  AgentCallbacks,
  AgentConfig,
  ExecutedToolCall,
} from "./agent-service.types";
import {
  getPlanModeRejectionMessage,
  isToolAllowedForExecutionMode,
  normalizeAgentExecutionMode,
} from "./agent-execution-mode";
import { threadService } from "./thread-service";

interface AgentToolRunnerOptions {
  beforeToolExecution?: () => Promise<void>;
  callbacks: AgentCallbacks;
  config: AgentConfig;
  isRunning: () => boolean;
  threadId: string;
}

interface ToolExecutionOutcome {
  message: Message;
  toolCall: ExecutedToolCall;
}

export interface ToolExecutionBatch {
  messages: Message[];
  toolCalls: ExecutedToolCall[];
}

const DEFAULT_TOOL_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_TOOL_TIMEOUT_MS = 5 * 60 * 1000;
const MIN_TOOL_TIMEOUT_MS = 1_000;
const TOOL_TIMEOUT_GRACE_MS = 5_000;

const getNumericArg = (
  args: Record<string, unknown>,
  keys: string[],
): number | undefined => {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return undefined;
};

const resolveToolTimeoutMs = (
  toolName: string,
  args: Record<string, unknown>,
): number => {
  const requestedTimeout = getNumericArg(args, ["timeout", "timeoutMs", "timeout_ms"]);

  if (toolName === "shell_execute" || toolName === "grep") {
    const boundedRequestedTimeout = Math.min(
      Math.max(Math.trunc(requestedTimeout ?? 30_000), MIN_TOOL_TIMEOUT_MS),
      MAX_TOOL_TIMEOUT_MS,
    );
    return Math.min(boundedRequestedTimeout + TOOL_TIMEOUT_GRACE_MS, MAX_TOOL_TIMEOUT_MS);
  }

  return Math.min(
    Math.max(Math.trunc(requestedTimeout ?? DEFAULT_TOOL_TIMEOUT_MS), MIN_TOOL_TIMEOUT_MS),
    MAX_TOOL_TIMEOUT_MS,
  );
};

const toToolMessage = (toolCallId: string, content: string): Message => ({
  role: "tool",
  tool_call_id: toolCallId,
  content,
} as Message);

const toToolErrorPayload = (toolName: string, error: string): string =>
  JSON.stringify({
    error,
    tool: toolName,
  });

export class AgentToolRunner {
  private readonly beforeToolExecution?: () => Promise<void>;
  private readonly callbacks: AgentCallbacks;
  private readonly config: AgentConfig;
  private hasCompletedPreToolExecution = false;
  private readonly isRunning: () => boolean;
  private readonly threadId: string;

  constructor(options: AgentToolRunnerOptions) {
    this.beforeToolExecution = options.beforeToolExecution;
    this.callbacks = options.callbacks;
    this.config = options.config;
    this.isRunning = options.isRunning;
    this.threadId = options.threadId;
  }

  public async executeToolCalls(
    toolCalls: ToolCallRequest[]
  ): Promise<ToolExecutionBatch> {
    const messages: Message[] = [];
    const executedToolCalls: ExecutedToolCall[] = [];

    for (const toolCall of toolCalls) {
      await this.recordToolCall(toolCall);

      const outcome = await this.executeSingleTool(toolCall);
      messages.push(outcome.message);
      executedToolCalls.push(outcome.toolCall);
    }

    return {
      messages,
      toolCalls: executedToolCalls,
    };
  }

  private async executeSingleTool(
    toolCall: ToolCallRequest
  ): Promise<ToolExecutionOutcome> {
    if (!this.isRunning()) {
      return this.handleRejectedTool(toolCall, "Agent stopped");
    }

    const toolName = toolCall.function.name;
    const parsedArgsResult = parseToolArguments(toolCall.function.arguments);
    const parsedArgs =
      parsedArgsResult.status === "invalid"
        ? { raw: toolCall.function.arguments }
        : parsedArgsResult.args;

    if (parsedArgsResult.status === "invalid") {
      const errorMessage = "Invalid JSON in tool arguments.";
      this.callbacks.onToolExecutionError?.(toolCall, errorMessage);
      return this.recordToolFailure(
        toolCall,
        parsedArgs,
        toToolErrorPayload(toolName, errorMessage),
        errorMessage
      );
    }

    const executionMode = normalizeAgentExecutionMode(this.config.executionMode);
    if (
      !isToolAllowedForExecutionMode(executionMode, toolName, parsedArgs)
    ) {
      return this.handleRejectedTool(
        toolCall,
        getPlanModeRejectionMessage(toolName),
        parsedArgs,
      );
    }

    const approved = await this.resolveApproval(toolCall);
    if (!approved) {
      return this.handleRejectedTool(
        toolCall,
        "Tool execution rejected by user",
        parsedArgs
      );
    }

    await this.ensureReadyForToolExecution();

    this.callbacks.onToolExecutionStart?.(toolCall);

    try {
      const result = await this.executeToolWithTimeout(toolCall, parsedArgs);

      await this.recordToolResult(toolCall.id, result, false, toolName);
      this.callbacks.onToolExecutionComplete?.(toolCall, result);

      return {
        message: toToolMessage(toolCall.id, result),
        toolCall: {
          id: toolCall.id,
          name: toolName,
          args: parsedArgs,
          result,
          status: "executed",
        },
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      this.callbacks.onToolExecutionError?.(toolCall, errorMessage);
      return this.recordToolFailure(
        toolCall,
        parsedArgs,
        toToolErrorPayload(toolName, errorMessage),
        errorMessage
      );
    }
  }

  private async executeTool(
    toolCall: ToolCallRequest,
    parsedArgs: Record<string, unknown>
  ): Promise<string> {
    if (isMcpTool(toolCall.function.name)) {
      return executeMcpTool(toolCall.function.name, parsedArgs);
    }

    const result = await toolRegistry.executeToolCall(toolCall, parsedArgs);
    return result.content;
  }

  private async executeToolWithTimeout(
    toolCall: ToolCallRequest,
    parsedArgs: Record<string, unknown>
  ): Promise<string> {
    const toolName = toolCall.function.name;
    const timeoutMs = resolveToolTimeoutMs(toolName, parsedArgs);
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    try {
      return await Promise.race([
        this.executeTool(toolCall, parsedArgs),
        new Promise<never>((_, reject) => {
          timeoutId = setTimeout(() => {
            reject(
              new Error(`Tool "${toolName}" timed out after ${timeoutMs}ms`),
            );
          }, timeoutMs);
        }),
      ]);
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }
  }

  private async ensureReadyForToolExecution(): Promise<void> {
    if (this.hasCompletedPreToolExecution || !this.beforeToolExecution) {
      return;
    }

    await this.beforeToolExecution();
    this.hasCompletedPreToolExecution = true;
  }

  private async handleRejectedTool(
    toolCall: ToolCallRequest,
    reason: string,
    parsedArgs: Record<string, unknown> = { raw: toolCall.function.arguments }
  ): Promise<ToolExecutionOutcome> {
    const content = toToolErrorPayload(toolCall.function.name, reason);
    this.callbacks.onToolRejected?.(toolCall, reason);

    await this.recordToolResult(
      toolCall.id,
      content,
      true,
      toolCall.function.name,
    );

    return {
      message: toToolMessage(toolCall.id, content),
      toolCall: {
        id: toolCall.id,
        name: toolCall.function.name,
        args: parsedArgs,
        result: content,
        status: "rejected",
      },
    };
  }

  private async recordToolFailure(
    toolCall: ToolCallRequest,
    parsedArgs: Record<string, unknown>,
    content: string,
    result: string
  ): Promise<ToolExecutionOutcome> {
    await this.recordToolResult(
      toolCall.id,
      content,
      true,
      toolCall.function.name,
    );

    return {
      message: toToolMessage(toolCall.id, content),
      toolCall: {
        id: toolCall.id,
        name: toolCall.function.name,
        args: parsedArgs,
        result,
        status: "failed",
      },
    };
  }

  private async resolveApproval(toolCall: ToolCallRequest): Promise<boolean> {
    const toolName = toolCall.function.name;
    const toolSetting =
      this.config.getToolApproval?.(toolName) ?? "always_ask";

    if (toolSetting === "deny") {
      return false;
    }

    const autoApprovedBySetting = toolSetting === "auto";
    const autoApprovedByRegistry =
      this.config.autoApproveTools && !toolRegistry.requiresApproval(toolName);
    const autoApprovedByMcp =
      isMcpTool(toolName) && shouldAutoApproveMcpTool(toolName);

    if (autoApprovedBySetting || autoApprovedByRegistry || autoApprovedByMcp) {
      return true;
    }

    if (!this.callbacks.onToolApprovalRequired) {
      return false;
    }

    return this.callbacks.onToolApprovalRequired(toolCall);
  }

  private async recordToolCall(toolCall: ToolCallRequest): Promise<void> {
    // The tool_call itself is persisted to JSONL as part of the surrounding
    // AssistantMessage event (written by `agent-service.ts` after the model
    // finishes its turn). Here we only mirror it into the in-memory
    // ContextManager so live message builds see the call.
    await auroraInvoke("context_add_tool_call", {
      threadId: this.threadId,
      toolCallId: toolCall.id,
      name: toolCall.function.name,
      arguments: toolCall.function.arguments,
    });
  }

  private async recordToolResult(
    toolCallId: string,
    content: string,
    isError: boolean,
    toolName?: string,
  ): Promise<void> {
    // 1. Mirror into the in-memory ContextManager.
    await auroraInvoke("context_add_tool_result", {
      threadId: this.threadId,
      toolCallId,
      content,
      isError,
    });

    // 2. Persist to JSONL. We need a `tool_name` for replay/debug, so derive
    //    it from the caller when available; otherwise fall back to a sentinel
    //    so the event is still written (preferable to silently dropping it).
    try {
      await threadService.appendToolResult(
        this.threadId,
        toolCallId,
        toolName ?? "unknown",
        content,
        isError,
      );
    } catch (err) {
      console.warn(
        `[agent-tool-runner] thread_append_tool_result failed for ${toolCallId}:`,
        err,
      );
    }
  }
}
