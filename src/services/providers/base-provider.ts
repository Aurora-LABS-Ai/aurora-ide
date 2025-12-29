/**
 * Base Provider - Abstract base class for all LLM providers
 *
 * Implements common functionality:
 * - Request/response lifecycle
 * - Abort handling
 * - Token estimation
 * - Context tracking
 * - Tauri HTTP for CORS bypass
 */

import { invoke } from '@tauri-apps/api/core';
import type {
  IProvider,
  ProviderConfig,
  ProviderType,
  ChatRequest,
  ChatResponse,
  StreamCallbacks,
  AssistantMessage,
  Message,
  ContentBlock,
  ToolDefinition,
} from './types';
import { TokenCounter } from './token-counter';

// Tauri command types
interface LlmRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  stream: boolean;
}

interface LlmResponse {
  status: number;
  body: string;
  headers: Record<string, string>;
}

export abstract class BaseProvider implements IProvider {
  protected _config: ProviderConfig;
  protected abortController: AbortController | null = null;
  protected tokenCounter: TokenCounter;

  constructor(config: ProviderConfig) {
    this._config = config;
    this.tokenCounter = new TokenCounter();
  }

  get config(): ProviderConfig {
    return { ...this._config };
  }

  get providerType(): ProviderType {
    return this._config.providerType;
  }

  // ============================================================
  // ABSTRACT METHODS (must be implemented by subclasses)
  // ============================================================

  abstract chat(request: ChatRequest): Promise<ChatResponse>;
  abstract streamChat(request: ChatRequest, callbacks: StreamCallbacks): Promise<AssistantMessage>;

  // ============================================================
  // TOKEN COUNTING
  // ============================================================

  async countTokens(content: string | ContentBlock[]): Promise<number> {
    return this.tokenCounter.countTokens(content);
  }

  async estimateTokens(messages: Message[], tools?: ToolDefinition[]): Promise<number> {
    return this.tokenCounter.estimateRequest(messages, tools);
  }

  // ============================================================
  // CONTEXT INFO (from DB config)
  // ============================================================

  getContextWindow(): number {
    return this._config.contextWindow;
  }

  getMaxOutputTokens(): number {
    return this._config.maxOutputTokens;
  }

  // ============================================================
  // CAPABILITIES
  // ============================================================

  supportsThinking(): boolean {
    return this._config.supportsThinking;
  }

  supportsToolStream(): boolean {
    return this._config.supportsToolStream;
  }

  supportsVision(): boolean {
    return this._config.supportsVision ?? false;
  }

  // ============================================================
  // LIFECYCLE
  // ============================================================

  cancelRequest(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
  }

  updateConfig(config: Partial<ProviderConfig>): void {
    this._config = { ...this._config, ...config };
  }

  // ============================================================
  // PROTECTED HELPERS
  // ============================================================

  protected buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...this._config.customHeaders,
    };

    if (this._config.apiKey) {
      headers['Authorization'] = `Bearer ${this._config.apiKey}`;
    }

    return headers;
  }

  protected getTemperature(requestTemp?: number): number {
    return requestTemp ?? this._config.defaultTemperature ?? 1.0;
  }

  protected getMaxTokens(requestMax?: number): number {
    const defaultMax = this._config.defaultMaxTokens ?? 4096;
    const max = requestMax ?? defaultMax;

    // Cap at provider's max output tokens
    if (this._config.maxOutputTokens && max > this._config.maxOutputTokens) {
      return this._config.maxOutputTokens;
    }

    return max;
  }

  /**
   * Fetch using Tauri HTTP commands (bypasses CORS)
   * Non-streaming version
   */
  protected async fetchWithAbort(
    url: string,
    options: RequestInit
  ): Promise<Response> {
    const llmRequest: LlmRequest = {
      url,
      method: options.method || 'POST',
      headers: (options.headers as Record<string, string>) || {},
      body: options.body as string | undefined,
      stream: false,
    };

    const response = await invoke<LlmResponse>('llm_request', { request: llmRequest });

    if (response.status >= 400) {
      let errorMessage = `HTTP ${response.status}`;
      try {
        const errorJson = JSON.parse(response.body);
        errorMessage = errorJson.error?.message || errorJson.message || errorMessage;
      } catch {
        // Use status code if can't parse error
      }
      throw new Error(errorMessage);
    }

    // Convert Tauri response to web Response object for compatibility
    return {
      ok: response.status < 400,
      status: response.status,
      statusText: '',
      headers: new Headers(response.headers),
      json: async () => JSON.parse(response.body),
      text: async () => response.body,
    } as Response;
  }
}
