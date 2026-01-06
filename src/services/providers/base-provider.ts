/**
 * Base Provider - Abstract base class for all LLM providers
 * 
 * Implements common functionality:
 * - Request/response lifecycle
 * - Abort handling
 * - Token estimation (via Rust tiktoken)
 * - Context tracking
 * - Tauri HTTP for CORS bypass
 */
import { invoke } from "@tauri-apps/api/core";

import { tokenService } from "../token-service";
import type { AssistantMessage, ChatRequest, ChatResponse, ContentBlock, IProvider, Message, ProviderConfig, ProviderType, StreamCallbacks, ToolDefinition } from "./types";

// Tauri command types
interface LlmRequest {
  body?: string;
  headers: Record<string, string>;
  method: string;
  stream: boolean;
  url: string;
}

interface LlmResponse {
  body: string;
  headers: Record<string, string>;
  status: number;
}

export abstract class BaseProvider implements IProvider {
  protected _config: ProviderConfig;
  protected abortController: AbortController | null = null;

  constructor(config: ProviderConfig) {
    this._config = config;
  }

  public get config(): ProviderConfig {
    return { ...this._config };
  }

  public get providerType(): ProviderType {
    return this._config.providerType;
  }

  // ============================================================
  // LIFECYCLE
  // ============================================================
  public cancelRequest(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
  }

  // ============================================================
  // ABSTRACT METHODS (must be implemented by subclasses)
  // ============================================================
  public abstract chat(request: ChatRequest): Promise<ChatResponse>;

  // ============================================================
  // TOKEN COUNTING (via Rust tiktoken)
  // ============================================================
  public async countTokens(content: string | ContentBlock[]): Promise<number> {
    // Convert content blocks to string if needed
    const text = typeof content === 'string' 
      ? content 
      : content.map(block => {
          if (block.type === 'text') return block.text || '';
          if (block.type === 'thinking') return block.thinking || '';
          return '';
        }).join('');
    
    const result = await tokenService.countTokens(text, this._config.model);
    return result.tokens;
  }

  public async estimateTokens(messages: Message[], tools?: ToolDefinition[]): Promise<number> {
    // Convert to format expected by token service
    const chatMessages = messages.map(m => ({
      role: m.role,
      content: typeof m.content === 'string' ? m.content : '',
    }));
    
    let total = (await tokenService.countMessagesTokens(chatMessages, this._config.model)).tokens;
    
    // Add tool definitions if present
    if (tools?.length) {
      const toolsJson = JSON.stringify(tools);
      total += (await tokenService.countTokens(toolsJson, this._config.model)).tokens;
    }
    
    return total;
  }

  // ============================================================
  // CONTEXT INFO (from DB config)
  // ============================================================
  public getContextWindow(): number {
    return this._config.contextWindow;
  }

  public getMaxOutputTokens(): number {
    return this._config.maxOutputTokens;
  }

  public abstract streamChat(request: ChatRequest, callbacks: StreamCallbacks): Promise<AssistantMessage>;

  // ============================================================
  // CAPABILITIES
  // ============================================================
  public supportsThinking(): boolean {
    return this._config.supportsThinking;
  }

  public supportsToolStream(): boolean {
    return this._config.supportsToolStream;
  }

  public supportsVision(): boolean {
    return this._config.supportsVision ?? false;
  }

  public updateConfig(config: Partial<ProviderConfig>): void {
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

  protected getMaxTokens(requestMax?: number): number {
    const defaultMax = this._config.defaultMaxTokens ?? 4096;
    const max = requestMax ?? defaultMax;

    // Cap at provider's max output tokens
    if (this._config.maxOutputTokens && max > this._config.maxOutputTokens) {
      return this._config.maxOutputTokens;
    }

    return max;
  }

  protected getTemperature(requestTemp?: number): number {
    return requestTemp ?? this._config.defaultTemperature ?? 1.0;
  }
}
