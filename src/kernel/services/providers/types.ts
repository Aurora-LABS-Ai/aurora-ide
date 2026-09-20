/**
 * Enterprise Provider System - Type Definitions
 * 
 * Modular, extensible provider architecture supporting:
 * - OpenAI-compatible APIs
 * - Anthropic Claude API
 * - MiniMax M2 family (Anthropic-compatible by default)
 * - Custom providers
 */

import type {
  ReasoningReplayMode,
  ReasoningRequestMode,
} from "@/kernel/types/database";

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
  /**
   * API-key POOL. When it holds more than one key the Rust runtime rotates
   * round-robin per turn and fails over to the next on a 401/429/5xx.
   * Empty/undefined → only `apiKey` is used.
   */
  apiKeys?: string[];
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

  /**
   * Fully resolved reasoning request for this exact provider + model pair.
   * This is the one semantic contract sent to Rust. Provider adapters encode
   * it as `reasoning_effort`, `thinking`, `output_config`, or the Responses
   * `reasoning` object without asking TypeScript to know each wire shape.
   */
  reasoning?: ReasoningRequestConfig;

  // Capabilities
  supportsThinking: boolean;
  supportsToolStream: boolean;
  supportsVision: boolean;
}

export type ReasoningControl = 'none' | 'toggle' | 'effort' | 'budget';

/**
 * Provider-neutral reasoning intent for one model invocation.
 *
 * `enabled` describes the user's/model's intent. It never means "emit a
 * `thinking` field"; that decision belongs to the selected adapter. Keeping
 * those two meanings separate prevents effort models from disabling the very
 * adapter logic that needs to translate their effort.
 */
export interface ReasoningRequestConfig {
  enabled: boolean;
  control: ReasoningControl;
  effort?: string;
  budgetTokens?: number;
  requestMode: ReasoningRequestMode;
  replay: ReasoningReplayMode;
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
  /**
   * `true` when these counts are Aurora's own tiktoken estimate rather than
   * provider-reported usage. Load-bearing: these numbers drive a cost figure,
   * and an estimate shown as a measurement is worse than showing nothing.
   */
  estimated?: boolean;
  /**
   * USD the PROVIDER reported for this request, when it reports one.
   * Outranks anything computed from a catalog rate: it is the account's
   * actual charge, including gateway markup, BYOK rates and promos.
   */
  costUsd?: number;
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
  | 'openai'           // OpenAI and compatible APIs (Chat Completions)
  | 'openai-responses' // OpenAI Responses API (/responses, typed streaming events)
  | 'codex'            // Codex via ChatGPT backend (subscription OAuth, Responses dialect)
  | 'claude-code'      // Claude via the claude.ai subscription (OAuth bearer, Anthropic Messages wire)
  | 'cursor'           // Cursor subscription via its native agent protocol
  | 'fireworks'        // Fireworks AI (OpenAI-compatible with reasoning_content)
  | 'anthropic'        // Native Anthropic Claude API
  // DeepSeek — one `sk-` key, three wires, all three live. Like Ark's three
  // and unlike kenari's, these are not suffixes of one base URL: Messages is
  // served at `/anthropic`, so the picker rewrites the row's URL
  // (`deepseekBaseUrlForWire`) and switching only the type would 404.
  //
  // Chat is the default and stays it: it is the only wire with DeepSeek's
  // strict-tool beta branch. Messages is the one that returns SIGNED thinking,
  // so reasoning survives a tool loop; Responses returns it as plain text.
  | 'deepseek'           // DeepSeek over OpenAI Chat Completions (the default)
  | 'deepseek-messages'  // DeepSeek over the Anthropic Messages shape
  | 'deepseek-responses' // DeepSeek over the Responses shape
  | 'glm'              // GLM/Z.AI (OpenAI-compatible with thinking)
  | 'minimax'          // MiniMax M2 family (Anthropic-compatible by default)
  | 'lmstudio'         // LM Studio (local server, uses async-openai Rust crate)
  | 'ollama'           // Ollama (local server, uses async-openai Rust crate)
  // kenari — one gateway account reachable over three different wires. These
  // are three types rather than one type plus a wire field so that everything
  // downstream (URL builder, streaming client, reasoning replay) is decided by
  // a single value that cannot contradict itself.
  | 'kenari'           // kenari over OpenAI Chat Completions (the default)
  | 'kenari-messages'  // kenari over the Anthropic Messages shape
  | 'kenari-responses' // kenari over the Responses shape (Codex wire)
  // Volcano Ark's Coding Plan — three wires on one key, all driven live.
  //
  // Unlike kenari's, Modal's and Meta's threes, these are NOT three suffixes
  // of one base URL: messages is `/api/coding/v1`, chat and responses are
  // `/api/coding/v3`. So changing the wire has to rewrite the row's base URL
  // (`arkBaseUrlForWire`), and switching only the type would 404.
  //
  // The path also has to stay under `/api/coding`: the same key on Ark's
  // general `/api/v3` succeeds and silently spends pay-as-you-go credit
  // instead of the subscription.
  //
  // Messages is the default because it is the only one that signs its thinking
  // blocks (reasoning replays across a tool loop) and the only one that splits
  // cache writes from cache reads.
  | 'ark-messages'    // Ark over the Anthropic Messages shape (the default)
  | 'ark'             // Ark over OpenAI Chat Completions
  | 'ark-responses'   // Ark over the Responses shape
  // Modal — one workspace proxy token, one regional gateway, three wires. The
  // models are the workspace's live endpoints, addressed by hostname.
  | 'modal'            // Modal over OpenAI Chat Completions (the default)
  | 'modal-messages'   // Modal over the Anthropic Messages shape (Bearer auth)
  | 'modal-responses'  // Modal over the Responses shape
  // Meta Model API (Muse) — one key, one base URL, three wires, like kenari's
  // and interchangeable in the same way: every Muse Spark model answers all
  // three. Responses is the default because it is the only one that carries
  // reasoning across a tool call; Meta's own docs warn that the Chat wire
  // drops it and makes multi-step runs erratic. The Messages wire accepts
  // Aurora's `x-api-key` header as well as a bearer token, which is why it
  // needs no adapter of its own.
  | 'meta'             // Meta over OpenAI Chat Completions
  | 'meta-messages'    // Meta over the Anthropic Messages shape
  | 'meta-responses'   // Meta over the Responses shape (the default)
  // OpenCode Go — three wires on one account and one base URL, but unlike
  // kenari's three these are NOT interchangeable: each model accepts exactly
  // one and fails hard on the others (500, or a 401 that reads as a bad key).
  // So the choice is made per MODEL (`LLMModel.providerType`, resolved by
  // `applyOpenCodeWire`), and these names only say which adapter each wire
  // means. The bare row id stays the Responses shape so it remains a prefix of
  // its own variants, which is what lets a stored choice survive a relaunch.
  | 'opencode-go'          // OpenCode Go over the Responses shape
  | 'opencode-go-chat'     // OpenCode Go over OpenAI Chat Completions
  | 'opencode-go-messages' // OpenCode Go over the Anthropic Messages shape
  | 'custom';          // Custom OpenAI-compatible
