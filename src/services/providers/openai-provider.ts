/**
 * OpenAI Provider - Handles OpenAI and compatible APIs
 *
 * Supports:
 * - OpenAI GPT models
 * - DeepSeek (with reasoning support)
 * - GLM/Z.AI (with thinking support)
 * - Any OpenAI-compatible API
 * - Tauri HTTP for CORS bypass
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
  ToolCallRequest,
  TokenUsage,
} from './types';

// Tauri command types
interface LlmRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  stream: boolean;
}

interface TauriStreamChunk {
  data: string;
  done: boolean;
}

interface OpenAIStreamChunk {
  id: string;
  choices: Array<{
    index: number;
    delta: {
      role?: string;
      content?: string;
      reasoning_content?: string;
      tool_calls?: Array<{
        index: number;
        id?: string;
        type?: string;
        function?: {
          name?: string;
          arguments?: string;
        };
      }>;
    };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export class OpenAIProvider extends BaseProvider {
  constructor(config: ProviderConfig) {
    super(config);
  }

  /**
   * Check if this is a DeepSeek provider
   */
  private isDeepSeek(): boolean {
    if (this._config.providerType === 'deepseek') return true;
    return (
      this._config.baseUrl.includes('deepseek.com') ||
      this._config.model.includes('deepseek')
    );
  }
  /**
   * Build request body based on provider type
   */
  private buildRequestBody(request: ChatRequest): Record<string, unknown> {
    const isDeepSeek = this.isDeepSeek();
    const isReasonerModel = this._config.model.includes('reasoner');

    // Convert messages to OpenAI format (preserving necessary fields)
    const messages = request.messages.map(msg => {
      const apiMsg: any = {
        role: msg.role,
      };

      // Handle content - only include if not empty
      // Some APIs (like GLM) have issues with empty string content in assistant messages with tool_calls
      if (msg.content !== undefined && msg.content !== null && msg.content !== '') {
        apiMsg.content = msg.content;
      }

      // Preserve tool_calls for assistant messages (Critical for tool use chains)
      if (msg.role === 'assistant') {
        const assistantMsg = msg as AssistantMessage;
        if (assistantMsg.tool_calls && assistantMsg.tool_calls.length > 0) {
          // Transform internal tool use format to OpenAI API format
          apiMsg.tool_calls = assistantMsg.tool_calls.map(tc => ({
            id: tc.id,
            type: 'function',
            function: {
              name: tc.function.name,
              arguments: typeof tc.function.arguments === 'string'
                ? tc.function.arguments
                : JSON.stringify(tc.function.arguments),
            }
          }));

          // For assistant messages with tool_calls, content can be null/omitted
          // GLM and some OpenAI-compatible APIs prefer this
          if (!apiMsg.content) {
            apiMsg.content = null;
          }
        }

        // Preserve reasoning_content for DeepSeek/GLM thinking mode
        if (assistantMsg.reasoning_content) {
          // For DeepSeek - send reasoning_content directly
          if (isDeepSeek || isReasonerModel || this._config.providerType === 'deepseek') {
            apiMsg.reasoning_content = assistantMsg.reasoning_content;
          }
          // Note: GLM returns thinking in response but doesn't require it to be sent back
        }
      }

      // Preserve tool_call_id for tool results
      if (msg.role === 'tool') {
        const toolMsg = msg as any;
        if (toolMsg.tool_call_id) {
          apiMsg.tool_call_id = toolMsg.tool_call_id;
        }
        // Ensure content is always a string for tool messages
        if (typeof apiMsg.content !== 'string') {
          apiMsg.content = JSON.stringify(apiMsg.content || '');
        }
      }

      return apiMsg;
    });

    const body: Record<string, unknown> = {
      model: this._config.model,
      messages,
      stream: request.stream ?? false,
      max_tokens: this.getMaxTokens(request.maxTokens),
    };

    // Temperature handling
    // DeepSeek reasoner doesn't support temperature
    if (!(isDeepSeek && isReasonerModel)) {
      body.temperature = this.getTemperature(request.temperature);
    }

    // Thinking mode based on provider
    // IMPORTANT: Only send thinking param to providers that support it
    // Custom/generic OpenAI providers should NOT receive this param
    if (this._config.supportsThinking && request.thinkingEnabled !== false) {
      const providerType = this._config.providerType;
      
      // Only send thinking param to known providers that support it
      if (providerType === 'deepseek' && !isReasonerModel) {
        // DeepSeek chat with thinking
        body.thinking = { type: 'enabled' };
      } else if (providerType === 'glm') {
        // GLM/Z.AI thinking
        body.thinking = { type: 'enabled' };
      }
      // Note: 'openai' and 'custom' providers do NOT get thinking param
      // as standard OpenAI API doesn't support it
    }

    // Tools
    if (request.tools?.length) {
      body.tools = request.tools;
      body.tool_choice = 'auto';

      // tool_stream is GLM-specific, only send to GLM providers
      if (this._config.supportsToolStream && this._config.providerType === 'glm') {
        body.tool_stream = true;
      }
    }

    // Stream options for usage tracking
    // Only add stream_options for providers that support it (OpenAI, GLM, DeepSeek)
    // Custom providers may not support this extension
    if (request.stream) {
      const providerType = this._config.providerType;
      if (providerType === 'openai' || providerType === 'glm' || providerType === 'deepseek') {
        body.stream_options = { include_usage: true };
      }
    }

    // Merge custom params
    if (this._config.customParams) {
      Object.assign(body, this._config.customParams);
    }

    return body;
  }

  /**
   * Non-streaming chat completion
   */
  async chat(request: ChatRequest): Promise<ChatResponse> {
    const body = this.buildRequestBody({ ...request, stream: false });
    const url = `${this._config.baseUrl}/chat/completions`;

    const response = await this.fetchWithAbort(url, {
      method: 'POST',
      headers: this.buildHeaders(),
      body: JSON.stringify(body),
    });

    const data = await response.json();

    const choice = data.choices?.[0];
    const message: AssistantMessage = {
      role: 'assistant',
      content: choice?.message?.content || '',
      reasoning_content: choice?.message?.reasoning_content,
      tool_calls: choice?.message?.tool_calls?.map((tc: any) => ({
        id: tc.id,
        type: 'function',
        function: {
          name: tc.function.name,
          arguments: tc.function.arguments,
        },
      })),
    };

    const usage: TokenUsage | undefined = data.usage
      ? {
        promptTokens: data.usage.prompt_tokens,
        completionTokens: data.usage.completion_tokens,
        totalTokens: data.usage.total_tokens,
      }
      : undefined;

    return { message, usage };
  }

  /**
   * Streaming chat completion (uses Tauri for CORS bypass)
   */
  async streamChat(
    request: ChatRequest,
    callbacks: StreamCallbacks
  ): Promise<AssistantMessage> {
    const body = this.buildRequestBody({ ...request, stream: true });
    const url = `${this._config.baseUrl}/chat/completions`;

    // Generate unique request ID for event handling
    const requestId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    // Accumulators
    let content = '';
    let reasoningContent = '';
    const toolCalls: Map<number, ToolCallRequest> = new Map();

    try {
      callbacks.onStart?.();

      // Set up event listeners for stream chunks
      const unlistenChunk = await listen<TauriStreamChunk>(`llm-stream-${requestId}`, (event) => {
        const chunk = event.payload;
        if (chunk.done) return;

        // Process SSE data
        const lines = chunk.data.split('\n');
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6).trim();
            if (data === '[DONE]') return;

            try {
              const parsed: OpenAIStreamChunk = JSON.parse(data);

              // Capture usage
              if (parsed.usage) {
                callbacks.onUsage?.({
                  promptTokens: parsed.usage.prompt_tokens,
                  completionTokens: parsed.usage.completion_tokens,
                  totalTokens: parsed.usage.total_tokens,
                });
              }

              for (const choice of parsed.choices) {
                const delta = choice.delta;

                // Handle reasoning/thinking content
                if (delta.reasoning_content) {
                  reasoningContent += delta.reasoning_content;
                  callbacks.onThinking?.(delta.reasoning_content);
                }

                // Handle regular content
                if (delta.content) {
                  content += delta.content;
                  callbacks.onToken?.(delta.content);
                }

                // Handle tool calls
                if (delta.tool_calls) {
                  for (const tc of delta.tool_calls) {
                    const index = tc.index;

                    if (!toolCalls.has(index)) {
                      toolCalls.set(index, {
                        id: tc.id || `tool_${index}`,
                        type: 'function',
                        function: {
                          name: tc.function?.name || '',
                          arguments: tc.function?.arguments || '',
                        },
                      });
                    } else {
                      const existing = toolCalls.get(index)!;
                      if (tc.function?.name) {
                        existing.function.name = tc.function.name;
                      }
                      if (tc.function?.arguments) {
                        existing.function.arguments += tc.function.arguments;
                      }
                    }

                    callbacks.onToolCall?.(toolCalls.get(index)!);
                  }
                }
              }
            } catch {
              // Skip invalid JSON
            }
          }
        }
      });

      // Set up error listener
      let streamError: Error | null = null;
      const unlistenError = await listen<string>(`llm-stream-error-${requestId}`, (event) => {
        streamError = new Error(event.payload);
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
        throw streamError;
      }

      // Build final message
      const result: AssistantMessage = {
        role: 'assistant',
        content,
        reasoning_content: reasoningContent || undefined,
        tool_calls: toolCalls.size > 0 ? Array.from(toolCalls.values()) : undefined,
      };

      callbacks.onComplete?.(result);
      return result;

    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error('Request cancelled');
      }
      callbacks.onError?.(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }
}
