/**
 * Enterprise Provider System - Type Definitions
 *
 * Modular, extensible provider architecture supporting:
 * - OpenAI-compatible APIs
 * - Anthropic Claude API
 * - MiniMax M2.1 (Anthropic-compatible)
 * - Custom providers
 */

// ============================================================
// PROVIDER TYPES
// ============================================================

export type ProviderType =
  | 'openai'      // OpenAI and compatible APIs
  | 'anthropic'   // Native Anthropic Claude API
  | 'deepseek'    // DeepSeek (OpenAI-compatible with extensions)
  | 'glm'         // GLM/Z.AI (OpenAI-compatible with thinking)
  | 'minimax'     // MiniMax M2.1 (supports both OpenAI and Anthropic formats)
  | 'custom';     // Custom OpenAI-compatible

// ============================================================
// MESSAGE TYPES
// ============================================================

export interface TextContent {
  type: 'text';
  text: string;
}

export interface ImageContent {
  type: 'image';
  source: {
    type: 'base64';
    media_type: string;
    data: string;
  };
}

export interface ThinkingContent {
  type: 'thinking';
  thinking: string;
  signature?: string;
}

export interface ToolUseContent {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultContent {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

export type ContentBlock =
  | TextContent
  | ImageContent
  | ThinkingContent
  | ToolUseContent
  | ToolResultContent;

export interface Message {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string | ContentBlock[];
}

export interface UserMessage extends Message {
  role: 'user';
}

export interface AssistantMessage extends Message {
  role: 'assistant';
  reasoning_content?: string;
  tool_calls?: ToolCallRequest[];
}

export interface SystemMessage extends Message {
  role: 'system';
  content: string;
}

export interface ToolMessage extends Message {
  role: 'tool';
  tool_call_id: string;
  content: string;
}

// ============================================================
// TOOL TYPES
// ============================================================

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, unknown>;
      required?: string[];
    };
  };
}

export interface ToolCallRequest {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

// ============================================================
// PROVIDER CONFIG
// ============================================================

export interface ProviderConfig {
  id: string;
  name: string;
  providerType: ProviderType;
  baseUrl: string;
  apiKey: string;
  model: string;

  // Context management (read from DB)
  contextWindow: number;
  maxOutputTokens: number;

  // Capabilities
  supportsThinking: boolean;
  supportsToolStream: boolean;
  supportsVision: boolean;

  // Optional settings
  defaultTemperature?: number;
  defaultMaxTokens?: number;
  customHeaders?: Record<string, string>;
  customParams?: Record<string, unknown>;
}

// ============================================================
// REQUEST/RESPONSE TYPES
// ============================================================

export interface ChatRequest {
  messages: Message[];
  tools?: ToolDefinition[];
  stream?: boolean;
  temperature?: number;
  maxTokens?: number;
  thinkingEnabled?: boolean;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export interface ChatResponse {
  message: AssistantMessage;
  usage?: TokenUsage;
  stopReason?: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence';
}

// ============================================================
// STREAMING TYPES
// ============================================================

export interface StreamCallbacks {
  onStart?: () => void;
  onToken?: (token: string) => void;
  onThinking?: (thinking: string) => void;
  onToolCall?: (toolCall: ToolCallRequest) => void;
  onUsage?: (usage: TokenUsage) => void;
  onComplete?: (response: AssistantMessage) => void;
  onError?: (error: Error) => void;
}

// ============================================================
// CONTEXT MANAGEMENT TYPES (Enterprise)
// ============================================================

export interface ContextState {
  usedTokens: number;
  contextWindow: number;
  maxOutputTokens: number;
  percentage: number;
  isNearLimit: boolean;   // > 80%
  isOverLimit: boolean;   // > 100%
}

export interface CondenseResult {
  messages: Message[];
  summary: string;
  cost: number;
  newContextTokens: number;
  prevContextTokens: number;
  condenseId?: string;
}

export interface TruncationResult {
  messages: Message[];
  truncationId: string;
  messagesRemoved: number;
}

// ============================================================
// PROVIDER INTERFACE
// ============================================================

export interface IProvider {
  readonly config: ProviderConfig;
  readonly providerType: ProviderType;

  // Core methods
  chat(request: ChatRequest): Promise<ChatResponse>;
  streamChat(request: ChatRequest, callbacks: StreamCallbacks): Promise<AssistantMessage>;

  // Token counting
  countTokens(content: string | ContentBlock[]): Promise<number>;
  estimateTokens(messages: Message[], tools?: ToolDefinition[]): Promise<number>;

  // Context info (from DB)
  getContextWindow(): number;
  getMaxOutputTokens(): number;

  // Capabilities
  supportsThinking(): boolean;
  supportsToolStream(): boolean;
  supportsVision(): boolean;

  // Lifecycle
  cancelRequest(): void;
  updateConfig(config: Partial<ProviderConfig>): void;
}

// ============================================================
// API MESSAGE TYPES (for history/persistence)
// ============================================================

export interface ApiMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string | ContentBlock[];
  ts: number;

  // Context management (KiloCode-style)
  isSummary?: boolean;
  condenseId?: string;
  condenseParent?: string;
  truncationParent?: string;
  isTruncationMarker?: boolean;
  truncationId?: string;
}
