/**
 * LLM Service Types
 * Based on GLM-4.7 / OpenAI API specification
 */

import type { ToolDefinition, ToolCallRequest } from "../tools/types";

// ============================================
// MESSAGE TYPES
// ============================================

export type MessageRole = "system" | "user" | "assistant" | "tool";

export interface BaseMessage {
  role: MessageRole;
  content: string;
}

export interface SystemMessage extends BaseMessage {
  role: "system";
}

export interface UserMessage extends BaseMessage {
  role: "user";
}

export interface AssistantMessage extends BaseMessage {
  role: "assistant";
  reasoning_content?: string; // Thinking content from model
  tool_calls?: ToolCallRequest[];
}

export interface ToolMessage extends BaseMessage {
  role: "tool";
  tool_call_id: string;
}

export type ChatMessage =
  | SystemMessage
  | UserMessage
  | AssistantMessage
  | ToolMessage;

// ============================================
// REQUEST TYPES
// ============================================

export interface ThinkingConfig {
  type: "enabled" | "disabled";
  clear_thinking?: boolean; // For preserved thinking
}

export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  stream?: boolean;
  thinking?: ThinkingConfig;
  tools?: ToolDefinition[];
  tool_choice?: "auto" | "none";
  tool_stream?: boolean; // GLM-4.6 specific
  stop?: string[];
  response_format?: { type: "text" | "json_object" };
}

// ============================================
// RESPONSE TYPES
// ============================================

export interface ChatCompletionChoice {
  index: number;
  message: AssistantMessage;
  finish_reason:
    | "stop"
    | "tool_calls"
    | "length"
    | "sensitive"
    | "network_error"
    | null;
}

export interface UsageInfo {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface ChatCompletionResponse {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: ChatCompletionChoice[];
  usage?: UsageInfo;
}

// ============================================
// STREAMING TYPES
// ============================================

export interface StreamDelta {
  role?: MessageRole;
  content?: string;
  reasoning_content?: string;
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

export interface StreamChoice {
  index: number;
  delta: StreamDelta;
  finish_reason:
    | "stop"
    | "tool_calls"
    | "length"
    | "sensitive"
    | "network_error"
    | null;
}

export interface ChatCompletionChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: StreamChoice[];
  usage?: UsageInfo; // Some APIs include usage in final chunk
}

// ============================================
// PROVIDER CONFIG
// ============================================

export type ProviderType =
  | "openai"
  | "deepseek"
  | "glm"
  | "anthropic"
  | "custom";

export interface LLMProviderConfig {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  defaultTemperature?: number;
  defaultMaxTokens?: number;
  maxOutputTokens?: number; // Provider's max output limit
  contextWindow?: number; // Provider's context window
  supportsThinking?: boolean;
  supportsToolStream?: boolean;
  // Extended configuration
  providerType?: ProviderType; // Explicit provider type for correct handling
  customHeaders?: Record<string, string>; // Extra headers to send with requests
  customParams?: Record<string, unknown>; // Extra params to include in request body
}

// ============================================
// STREAMING CALLBACK TYPES
// ============================================

export interface StreamCallbacks {
  onStart?: () => void;
  onToken?: (token: string) => void;
  onThinking?: (thinking: string) => void;
  onToolCall?: (toolCall: ToolCallRequest) => void;
  onUsage?: (usage: UsageInfo) => void;
  onComplete?: (response: AssistantMessage) => void;
  onError?: (error: Error) => void;
}
