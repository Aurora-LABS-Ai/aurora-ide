import type { TokenUsage, ToolCallRequest } from "./types";

export interface RustProviderMessage {
  content?: unknown;
  reasoningContent?: string;
  role: string;
  toolCallId?: string;
  toolCalls?: Array<{
    function: {
      arguments: string;
      name: string;
    };
    id: string;
    type: string;
  }>;
}

export interface RustProviderRequest {
  maxTokens?: number;
  messages: RustProviderMessage[];
  provider: {
    apiKey: string;
    baseUrl: string;
    customHeaders?: Record<string, string>;
    customParams?: Record<string, unknown>;
    defaultMaxTokens?: number;
    defaultTemperature?: number;
    model: string;
    providerType: string;
    supportsThinking: boolean;
  };
  stream: boolean;
  temperature?: number;
  thinkingEnabled?: boolean;
  tools?: Array<{
    function: {
      description: string;
      name: string;
      parameters: unknown;
    };
    type: string;
  }>;
}

export interface RustProviderResponse {
  message: {
    content: string;
    reasoningContent?: string;
    role: "assistant";
    toolCalls?: ToolCallRequest[];
  };
  stopReason?: "end_turn" | "tool_use" | "max_tokens" | "stop_sequence";
  usage?: TokenUsage;
}

export interface RustStreamChunk {
  content?: string | null;
  done: boolean;
  finishReason?: string | null;
  reasoningContent?: string | null;
  toolCalls?: Array<{
    functionArguments?: string | null;
    functionName?: string | null;
    id?: string | null;
    index: number;
  }> | null;
}
