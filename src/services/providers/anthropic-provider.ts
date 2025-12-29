/**
 * Anthropic Provider - Native Claude API support
 *
 * Supports:
 * - Anthropic Claude models (Opus, Sonnet, Haiku)
 * - Extended thinking blocks
 * - Tool use with native format
 * - Streaming with usage tracking
 * - Tauri HTTP for CORS bypass
 *
 * Also works with MiniMax M2.1 via Anthropic-compatible API
 */

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { BaseProvider } from './base-provider';
import type {
  ProviderConfig,
  ChatRequest,
  ChatResponse,
  StreamCallbacks,
  AssistantMessage,
  Message,
  ContentBlock,
  ToolCallRequest,
  TokenUsage,
  ToolDefinition,
} from './types';

// Tauri command types
interface LlmRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  stream: boolean;
}

interface StreamChunk {
  data: string;
  done: boolean;
}

// Anthropic-specific types
interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicContentBlock[];
}

interface AnthropicContentBlock {
  type: 'text' | 'image' | 'thinking' | 'tool_use' | 'tool_result';
  text?: string;
  thinking?: string;
  signature?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string;
  source?: {
    type: 'base64';
    media_type: string;
    data: string;
  };
}

interface AnthropicTool {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

interface AnthropicStreamEvent {
  type: string;
  index?: number;
  content_block?: AnthropicContentBlock;
  delta?: {
    type: string;
    text?: string;
    thinking?: string;
    partial_json?: string;
  };
  message?: {
    usage?: {
      input_tokens: number;
      output_tokens: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
  };
  usage?: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

export class AnthropicProvider extends BaseProvider {
  constructor(config: ProviderConfig) {
    super(config);
  }

  /**
   * Check if this is MiniMax (Anthropic-compatible)
   */
  private isMiniMax(): boolean {
    if (this._config.providerType === 'minimax') return true;
    return (
      this._config.baseUrl.includes('minimax.io') ||
      this._config.baseUrl.includes('minimaxi.com') ||
      this._config.model.includes('MiniMax')
    );
  }

  /**
   * Build Anthropic-style headers
   */
  protected buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
      ...this._config.customHeaders,
    };

    if (this._config.apiKey) {
      headers['x-api-key'] = this._config.apiKey;
    }

    return headers;
  }

  /**
   * Convert internal messages to Anthropic format
   */
  private convertMessages(messages: Message[]): {
    system?: string;
    messages: AnthropicMessage[];
  } {
    let systemPrompt: string | undefined;
    const anthropicMessages: AnthropicMessage[] = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        // Extract system prompt
        systemPrompt = typeof msg.content === 'string'
          ? msg.content
          : msg.content.map(b => b.type === 'text' ? b.text : '').join('');
        continue;
      }

      if (msg.role === 'tool') {
        // Tool results go to the user role in Anthropic format
        // Ensure content is always a string for better compatibility (especially with MiniMax)
        let resultContent: string;
        if (typeof msg.content === 'string') {
          resultContent = msg.content;
        } else if (Array.isArray(msg.content)) {
          resultContent = JSON.stringify(msg.content);
        } else {
          resultContent = JSON.stringify(msg.content);
        }

        anthropicMessages.push({
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: (msg as any).tool_call_id,
            content: resultContent,
          }],
        });
        continue;
      }

      // Convert content blocks
      let content = this.convertContent(msg.content);

      // For assistant messages with tool_calls, we need to include tool_use blocks
      // Anthropic format requires tool_use to be in the content array
      if (msg.role === 'assistant' && (msg as any).tool_calls?.length > 0) {
        const toolCalls = (msg as any).tool_calls;

        // Ensure content is an array
        let contentBlocks: AnthropicContentBlock[] = [];

        // Add existing content
        if (typeof content === 'string' && content.trim()) {
          contentBlocks.push({ type: 'text', text: content });
        } else if (Array.isArray(content)) {
          contentBlocks = [...content];
        }

        // Add tool_use blocks from tool_calls
        for (const tc of toolCalls) {
          contentBlocks.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.function.name,
            input: JSON.parse(tc.function.arguments || '{}'),
          });
        }

        content = contentBlocks;
      }

      anthropicMessages.push({
        role: msg.role as 'user' | 'assistant',
        content,
      });
    }

    return { system: systemPrompt, messages: anthropicMessages };
  }

  /**
   * Convert content to Anthropic format
   */
  private convertContent(content: string | ContentBlock[]): string | AnthropicContentBlock[] {
    if (typeof content === 'string') {
      return content;
    }

    return content.map(block => {
      switch (block.type) {
        case 'text':
          return { type: 'text', text: block.text };
        case 'thinking':
          return { type: 'thinking', thinking: block.thinking, signature: block.signature };
        case 'image':
          return {
            type: 'image',
            source: block.source,
          };
        case 'tool_use':
          return {
            type: 'tool_use',
            id: block.id,
            name: block.name,
            input: block.input,
          };
        case 'tool_result':
          return {
            type: 'tool_result',
            tool_use_id: block.tool_use_id,
            content: block.content,
          };
        default:
          return { type: 'text', text: '' };
      }
    }) as AnthropicContentBlock[];
  }

  /**
   * Convert tools to Anthropic format
   */
  private convertTools(tools: ToolDefinition[]): AnthropicTool[] {
    return tools.map(tool => ({
      name: tool.function.name,
      description: tool.function.description,
      input_schema: {
        type: 'object',
        properties: tool.function.parameters.properties,
        required: tool.function.parameters.required,
      },
    }));
  }

  /**
   * Build request body
   */
  private buildRequestBody(request: ChatRequest): Record<string, unknown> {
    const { system, messages } = this.convertMessages(request.messages);

    const body: Record<string, unknown> = {
      model: this._config.model,
      messages,
      max_tokens: this.getMaxTokens(request.maxTokens),
      stream: request.stream ?? false,
    };

    if (system) {
      body.system = system;
    }

    // Temperature
    body.temperature = this.getTemperature(request.temperature);

    // Tools
    if (request.tools?.length) {
      body.tools = this.convertTools(request.tools);
    }

    // Thinking mode (Anthropic extended thinking)
    if (this._config.supportsThinking && request.thinkingEnabled !== false) {
      // Anthropic uses thinking blocks natively
      // MiniMax returns thinking in content blocks
    }

    // Custom params
    if (this._config.customParams) {
      Object.assign(body, this._config.customParams);
    }

    return body;
  }

  /**
   * Non-streaming chat
   */
  async chat(request: ChatRequest): Promise<ChatResponse> {
    const body = this.buildRequestBody({ ...request, stream: false });
    const url = `${this._config.baseUrl}/messages`;

    const response = await this.fetchWithAbort(url, {
      method: 'POST',
      headers: this.buildHeaders(),
      body: JSON.stringify(body),
    });

    const data = await response.json();

    const message = this.parseResponse(data);
    const usage = this.parseUsage(data.usage);

    return { message, usage };
  }

  /**
   * Streaming chat
   */
  async streamChat(
    request: ChatRequest,
    callbacks: StreamCallbacks
  ): Promise<AssistantMessage> {
    const body = this.buildRequestBody({ ...request, stream: true });
    const url = `${this._config.baseUrl}/messages`;

    // Generate unique request ID for event handling
    const requestId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    try {
      callbacks.onStart?.();

      // Set up event listeners for stream chunks
      const unlistenChunk = await listen<StreamChunk>(`llm-stream-${requestId}`, async (event) => {
        const chunk = event.payload;
        if (chunk.done) return;

        // Process SSE data
        const lines = chunk.data.split('\n');
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6).trim();
            if (!data) continue;

            try {
              const parsed = JSON.parse(data);
              await this.processStreamEvent(parsed, callbacks);
            } catch {
              // Skip invalid JSON
            }
          }
        }
      });

      // Set up error listener
      let streamError: Error | null = null;
      let errorBody: string | null = null;
      const unlistenError = await listen<string>(`llm-stream-error-${requestId}`, (event) => {
        errorBody = event.payload;
        streamError = new Error(event.payload);
        console.error('[AnthropicProvider] Stream error from Rust:', {
          errorBody: event.payload,
          url,
          model: this._config.model,
        });
      });

      // Start the streaming request via Tauri
      const llmRequest: LlmRequest = {
        url,
        method: 'POST',
        headers: this.buildHeaders(),
        body: JSON.stringify(body),
        stream: true,
      };

      await invoke('llm_stream_request', {
        requestId,
        request: llmRequest,
      });

      // Clean up listeners
      unlistenChunk();
      unlistenError();

      // Check for errors
      if (streamError) {
        // Enhanced error logging for debugging
        console.error('[AnthropicProvider] Stream error details:', {
          error: streamError,
          errorBody,
          message: (streamError as Error).message,
          url,
          model: this._config.model,
          baseUrl: this._config.baseUrl,
          isMiniMax: this.isMiniMax(),
        });
        throw streamError;
      }

      // Build result from accumulated data (stored in callback handlers)
      // This will be built as events come in
      const result: AssistantMessage = {
        role: 'assistant',
        content: this.accumulatedContent,
        reasoning_content: this.accumulatedThinking || undefined,
        tool_calls: this.accumulatedToolCalls.size > 0 ? Array.from(this.accumulatedToolCalls.values()) : undefined,
      };

      // Reset accumulators
      this.accumulatedContent = '';
      this.accumulatedThinking = '';
      this.accumulatedToolCalls.clear();

      callbacks.onComplete?.(result);
      return result;

    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error('Request cancelled');
      }

      // Enhanced error logging for MiniMax debugging
      console.error('[AnthropicProvider] Stream request failed:', {
        error,
        message: error instanceof Error ? error.message : String(error),
        url,
        model: this._config.model,
        baseUrl: this._config.baseUrl,
        isMiniMax: this.isMiniMax(),
        headers: this.buildHeaders(),
        bodyPreview: JSON.stringify(body).substring(0, 200),
      });

      callbacks.onError?.(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  // Stream accumulators
  private accumulatedContent = '';
  private accumulatedThinking = '';
  private accumulatedToolCalls: Map<number, ToolCallRequest> = new Map();
  private currentBlockIndex = -1;
  private currentBlockType = '';

  /**
   * Process a single Anthropic stream event
   */
  private async processStreamEvent(event: AnthropicStreamEvent, callbacks: StreamCallbacks): Promise<void> {
    switch (event.type) {
      case 'message_start':
        if (event.message?.usage) {
          callbacks.onUsage?.(this.parseUsage(event.message.usage)!);
        }
        break;

      case 'content_block_start':
        this.currentBlockIndex = event.index ?? -1;
        this.currentBlockType = event.content_block?.type || '';

        if (this.currentBlockType === 'tool_use' && event.content_block) {
          this.accumulatedToolCalls.set(this.currentBlockIndex, {
            id: event.content_block.id || `tool_${this.currentBlockIndex}`,
            type: 'function',
            function: {
              name: event.content_block.name || '',
              arguments: '',
            },
          });
        }
        break;

      case 'content_block_delta':
        if (event.delta) {
          if (event.delta.type === 'text_delta' && event.delta.text) {
            this.accumulatedContent += event.delta.text;
            callbacks.onToken?.(event.delta.text);
          } else if (event.delta.type === 'thinking_delta' && event.delta.thinking) {
            this.accumulatedThinking += event.delta.thinking;
            callbacks.onThinking?.(event.delta.thinking);
          } else if (event.delta.type === 'input_json_delta' && event.delta.partial_json) {
            const tc = this.accumulatedToolCalls.get(this.currentBlockIndex);
            if (tc) {
              tc.function.arguments += event.delta.partial_json;
              callbacks.onToolCall?.(tc);
            }
          }
        }
        break;

      case 'message_delta':
        if (event.usage) {
          callbacks.onUsage?.(this.parseUsage(event.usage)!);
        }
        break;
    }
  }

  /**
   * Parse Anthropic response to internal format
   */
  private parseResponse(data: any): AssistantMessage {
    let content = '';
    let reasoningContent = '';
    const toolCalls: ToolCallRequest[] = [];

    for (const block of data.content || []) {
      switch (block.type) {
        case 'text':
          content += block.text;
          break;
        case 'thinking':
          reasoningContent += block.thinking;
          break;
        case 'tool_use':
          toolCalls.push({
            id: block.id,
            type: 'function',
            function: {
              name: block.name,
              arguments: JSON.stringify(block.input),
            },
          });
          break;
      }
    }

    return {
      role: 'assistant',
      content,
      reasoning_content: reasoningContent || undefined,
      tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
    };
  }

  /**
   * Parse usage from Anthropic response
   */
  private parseUsage(usage: any): TokenUsage | undefined {
    if (!usage) return undefined;

    return {
      promptTokens: usage.input_tokens || 0,
      completionTokens: usage.output_tokens || 0,
      totalTokens: (usage.input_tokens || 0) + (usage.output_tokens || 0),
      cacheReadTokens: usage.cache_read_input_tokens,
      cacheWriteTokens: usage.cache_creation_input_tokens,
    };
  }
}
