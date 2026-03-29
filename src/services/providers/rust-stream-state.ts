import type { AssistantMessage, ToolCallRequest } from "./types";
import type { RustStreamChunk } from "./rust-contract";

export class RustStreamState {
  private content = "";
  private reasoningContent = "";
  private readonly toolCalls = new Map<number, ToolCallRequest>();

  public applyChunk(
    chunk: RustStreamChunk,
    callbacks: {
      onThinking?: (thinking: string) => void;
      onToken?: (token: string) => void;
      onToolCall?: (toolCall: ToolCallRequest) => void;
    },
  ): void {
    if (chunk.done) {
      return;
    }

    if (chunk.content) {
      this.content += chunk.content;
      callbacks.onToken?.(chunk.content);
    }

    if (chunk.reasoningContent) {
      this.reasoningContent += chunk.reasoningContent;
      callbacks.onThinking?.(chunk.reasoningContent);
    }

    if (!chunk.toolCalls) {
      return;
    }

    for (const toolCall of chunk.toolCalls) {
      const existing = this.toolCalls.get(toolCall.index) ?? {
        id: toolCall.id || `tool_${toolCall.index}`,
        type: "function" as const,
        function: {
          name: toolCall.functionName || "",
          arguments: "",
        },
      };

      if (toolCall.id) {
        existing.id = toolCall.id;
      }
      if (toolCall.functionName) {
        existing.function.name = toolCall.functionName;
      }
      if (toolCall.functionArguments) {
        existing.function.arguments += toolCall.functionArguments;
      }

      this.toolCalls.set(toolCall.index, existing);
      callbacks.onToolCall?.(existing);
    }
  }

  public getContent(): string {
    return this.content;
  }

  public getReasoningContent(): string {
    return this.reasoningContent;
  }

  public getToolCalls(): AssistantMessage["tool_calls"] {
    return this.toolCalls.size > 0 ? Array.from(this.toolCalls.values()) : undefined;
  }
}
