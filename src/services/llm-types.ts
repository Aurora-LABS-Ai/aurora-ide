/**
 * LLM Service Types
 * Based on GLM-4.7 / OpenAI API specification
 */
import type { ToolCallRequest, ToolDefinition } from "../tools/types";

export interface AssistantMessage extends BaseMessage {
  reasoning_content?: string; // Thinking content from model
  role: "assistant";
  tool_calls?: ToolCallRequest[];
}

export interface BaseMessage {
  content: string;
  role: MessageRole;
}

// ============================================
// RESPONSE TYPES
// ============================================
export interface ChatCompletionChoice {
  finish_reason:
  | "stop"
  | "tool_calls"
  | "length"
  | "sensitive"
  | "network_error"
  | null;
  index: number;
  message: AssistantMessage;
}

export interface ChatCompletionChunk {
  choices: StreamChoice[];
  created: number;
id: string;
  model: string;
  object: "chat.completion.chunk";
  usage?: UsageInfo; // Some APIs include usage in final chunk
}

export interface ChatCompletionRequest {
  max_tokens?: number;
  messages: ChatMessage[];
  model: string;
  response_format?: { type: "text" | "json_object" };
  stop?: string[];
  stream?: boolean;
  temperature?: number;
  thinking?: ThinkingConfig;
  tool_choice?: "auto" | "none";
  tool_stream?: boolean; // GLM-4.6 specific
  tools?: ToolDefinition[];
  top_p?: number;
}

export interface ChatCompletionResponse {
  choices: ChatCompletionChoice[];
  created: number;
id: string;
  model: string;
  object: "chat.completion";
  usage?: UsageInfo;
}

export interface LLMProviderConfig {
  apiKey: string;
  baseUrl: string;
  contextWindow?: number; // Provider's context window
  customHeaders?: Record<string, string>; // Extra headers to send with requests
  customParams?: Record<string, unknown>; // Extra params to include in request body
  defaultMaxTokens?: number;
  defaultTemperature?: number;
id: string;
  maxOutputTokens?: number; // Provider's max output limit
  model: string;
  name: string;

  // Extended configuration
  providerType?: ProviderType; // Explicit provider type for correct handling
  supportsThinking?: boolean;
  supportsToolStream?: boolean;
}

// ============================================
// STREAMING CALLBACK TYPES
// ============================================
export interface StreamCallbacks {
  onComplete?: (response: AssistantMessage) => void;
  onError?: (error: Error) => void;
  onStart?: () => void;
  onThinking?: (thinking: string) => void;
  onToken?: (token: string) => void;
  onToolCall?: (toolCall: ToolCallRequest) => void;
  onUsage?: (usage: UsageInfo) => void;
}

export interface StreamChoice {
  delta: StreamDelta;
  finish_reason:
  | "stop"
  | "tool_calls"
  | "length"
  | "sensitive"
  | "network_error"
  | null;
  index: number;
}

// ============================================
// STREAMING TYPES
// ============================================
export interface StreamDelta {
content?: string;
  reasoning_content?: string;
  role?: MessageRole;
  tool_calls?: Array<{
    index: number;
    id?: string;
    type?: "function";
    function?: {
      name?: string;
      arguments?: string;
    };
  }>;
}

export interface SystemMessage extends BaseMessage {
  role: "system";
}

// ============================================
// REQUEST TYPES
// ============================================
export interface ThinkingConfig {
  clear_thinking?: boolean; // For preserved thinking
  type: "enabled" | "disabled";
}

export interface ToolMessage extends BaseMessage {
  role: "tool";
  tool_call_id: string;
}

export interface UsageInfo {
  completion_tokens: number;
  prompt_tokens: number;
  total_tokens: number;
}

export interface UserMessage extends BaseMessage {
  role: "user";
}

export type ChatMessage =
  | SystemMessage
  | UserMessage
  | AssistantMessage
  | ToolMessage;

// ============================================
// MESSAGE TYPES
// ============================================
export type MessageRole = "system" | "user" | "assistant" | "tool";

// ============================================
// PROVIDER CONFIG
// ============================================
export type ProviderType =
  | "openai"
  | "fireworks"
  | "deepseek"
  | "glm"
  | "anthropic"
  | "minimax"
  | "lmstudio"
  | "ollama"
  | "custom";
