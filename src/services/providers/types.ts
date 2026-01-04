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
// ============================================================
// API MESSAGE TYPES (for history/persistence)
// ============================================================
export interface ApiMessage {
  condenseId?: string;
  condenseParent?: string;
  content: string | ContentBlock[];

  // Context management (KiloCode-style)
  isSummary?: boolean;
  isTruncationMarker?: boolean;
  role: 'user' | 'assistant' | 'system' | 'tool';
  truncationId?: string;
  truncationParent?: string;
  ts: number;
}

export interface AssistantMessage extends Message {
  reasoning_content?: string;
  role: 'assistant';
  tool_calls?: ToolCallRequest[];
}

// ============================================================
// REQUEST/RESPONSE TYPES
// ============================================================
export interface ChatRequest {
  maxTokens?: number;
  messages: Message[];
  stream?: boolean;
  temperature?: number;
  thinkingEnabled?: boolean;
  tools?: ToolDefinition[];
}

export interface ChatResponse {
  message: AssistantMessage;
  stopReason?: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence';
  usage?: TokenUsage;
}

export interface CondenseResult {
  condenseId?: string;
  cost: number;
  messages: Message[];
  newContextTokens: number;
  prevContextTokens: number;
  summary: string;
}

// ============================================================
// CONTEXT MANAGEMENT TYPES (Enterprise)
// ============================================================
export interface ContextState {
  contextWindow: number;
  isNearLimit: boolean; // > 80%
  isOverLimit: boolean; // > 100%
  maxOutputTokens: number;
  percentage: number;
  usedTokens: number;
}

// ============================================================
// PROVIDER INTERFACE
// ============================================================
export interface IProvider {
  readonly config: ProviderConfig;
  readonly providerType: ProviderType;

  // Lifecycle
  cancelRequest(): void;

  // Core methods
  chat(request: ChatRequest): Promise<ChatResponse>;

  // Token counting
  countTokens(content: string | ContentBlock[]): Promise<number>;
  estimateTokens(messages: Message[], tools?: ToolDefinition[]): Promise<number>;

  // Context info (from DB)
  getContextWindow(): number;
  getMaxOutputTokens(): number;
  streamChat(request: ChatRequest, callbacks: StreamCallbacks): Promise<AssistantMessage>;

  // Capabilities
  supportsThinking(): boolean;
  supportsToolStream(): boolean;
  supportsVision(): boolean;
  updateConfig(config: Partial<ProviderConfig>): void;
}

export interface ImageContent {
  source: {
    type: 'base64';
    media_type: string;
    data: string;
  };
  type: 'image';
}

export interface Message {
  content: string | ContentBlock[];
  role: 'user' | 'assistant' | 'system' | 'tool';
}

// ============================================================
// PROVIDER CONFIG
// ============================================================
export interface ProviderConfig {
  apiKey: string;
  baseUrl: string;

  // Context management (read from DB)
  contextWindow: number;
  customHeaders?: Record<string, string>;
  customParams?: Record<string, unknown>;
  defaultMaxTokens?: number;

  // Optional settings
  defaultTemperature?: number;
  id: string;
  maxOutputTokens: number;
  model: string;
  name: string;
  providerType: ProviderType;

  // Capabilities
  supportsThinking: boolean;
  supportsToolStream: boolean;
  supportsVision: boolean;
}

// ============================================================
// STREAMING TYPES
// ============================================================
export interface StreamCallbacks {
  onComplete?: (response: AssistantMessage) => void;
  onError?: (error: Error) => void;
  onStart?: () => void;
  onThinking?: (thinking: string) => void;
  onToken?: (token: string) => void;
  onToolCall?: (toolCall: ToolCallRequest) => void;
  onUsage?: (usage: TokenUsage) => void;
}

export interface SystemMessage extends Message {
  content: string;
  role: 'system';
}

// ============================================================
// MESSAGE TYPES
// ============================================================
export interface TextContent {
  text: string;
  type: 'text';
}

export interface ThinkingContent {
  signature?: string;
  thinking: string;
  type: 'thinking';
}

export interface TokenUsage {
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  completionTokens: number;
  promptTokens: number;
  totalTokens: number;
}

export interface ToolCallRequest {
  function: {
    name: string;
    arguments: string;
  };
  id: string;
  type: 'function';
}

// ============================================================
// TOOL TYPES
// ============================================================
export interface ToolDefinition {
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, unknown>;
      required?: string[];
    };
  };
  type: 'function';
}

export interface ToolMessage extends Message {
  content: string;
  role: 'tool';
  tool_call_id: string;
}

export interface ToolResultContent {
  content: string;
  is_error?: boolean;
  tool_use_id: string;
  type: 'tool_result';
}

export interface ToolUseContent {
  id: string;
  input: Record<string, unknown>;
  name: string;
  type: 'tool_use';
}

export interface TruncationResult {
  messages: Message[];
  messagesRemoved: number;
  truncationId: string;
}

export interface UserMessage extends Message {
  role: 'user';
}

export type ContentBlock =
  | TextContent
  | ImageContent
  | ThinkingContent
  | ToolUseContent
  | ToolResultContent;

export type ProviderType =
  | 'openai'      // OpenAI and compatible APIs
  | 'anthropic'   // Native Anthropic Claude API
  | 'deepseek'    // DeepSeek (OpenAI-compatible with extensions)
  | 'glm'         // GLM/Z.AI (OpenAI-compatible with thinking)
  | 'minimax'     // MiniMax M2.1 (supports both OpenAI and Anthropic formats)
  | 'custom'; // Custom OpenAI-compatible
