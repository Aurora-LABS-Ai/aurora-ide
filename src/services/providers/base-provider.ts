/**
 * Base Provider - Shared config and token helpers for provider clients
 */

import { tokenService } from "../token-service";
import type { AssistantMessage, ChatRequest, ChatResponse, ContentBlock, IProvider, Message, ProviderConfig, ProviderType, StreamCallbacks, ToolDefinition } from "./types";

export abstract class BaseProvider implements IProvider {
  protected _config: ProviderConfig;

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
    // Implemented by subclasses that need cancellation.
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
}
