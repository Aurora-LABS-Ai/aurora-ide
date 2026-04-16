import { invoke } from "@tauri-apps/api/core";
import { parseToolArguments } from "../lib/tool-arguments";
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

const TOOL_TIMEOUT_MS = 5 * 60 * 1000;

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
      const result = await Promise.race([
        this.executeTool(toolCall, parsedArgs),
        new Promise<never>((_, reject) => {
          setTimeout(() => {
            reject(new Error(`Tool "${toolName}" timed out after 5 minutes`));
          }, TOOL_TIMEOUT_MS);
        }),
      ]);

      await this.recordToolResult(toolCall.id, result, false);
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

    await this.recordToolResult(toolCall.id, content, true);

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
    await this.recordToolResult(toolCall.id, content, true);

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
    await invoke("context_add_tool_call", {
      threadId: this.threadId,
      toolCallId: toolCall.id,
      name: toolCall.function.name,
      arguments: toolCall.function.arguments,
    });
  }

  private async recordToolResult(
    toolCallId: string,
    content: string,
    isError: boolean
  ): Promise<void> {
    await invoke("context_add_tool_result", {
      threadId: this.threadId,
      toolCallId,
      content,
      isError,
    });
  }
}
