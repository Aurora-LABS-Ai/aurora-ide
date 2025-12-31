/**
 * LLM Provider Service
 * Handles communication with OpenAI-compatible APIs
 * Supports streaming with SSE for real-time responses
 * Uses Tauri HTTP commands to bypass CORS restrictions
 *
 * NOTE: This class has NO hardcoded defaults. All config must come from settings.
 */

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type {
  ChatMessage,
  ChatCompletionResponse,
  ChatCompletionChunk,
  LLMProviderConfig,
  StreamCallbacks,
  AssistantMessage,
  ThinkingConfig,
  ProviderType,
} from './llm-types';
import type { ToolDefinition, ToolCallRequest } from '../tools/types';

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

interface StreamChunk {
  data: string;
  done: boolean;
}

export class LLMProvider {
  private config: LLMProviderConfig;
  private abortController: AbortController | null = null;

  constructor(config: LLMProviderConfig) {
    this.config = config;
    console.log('[LLMProvider] Initialized with config:', {
      baseUrl: config.baseUrl,
      model: config.model,
      hasApiKey: !!config.apiKey,
    });
  }

  /**
   * Update provider configuration (replaces entire config)
   */
  updateConfig(config: LLMProviderConfig): void {
    this.config = config;
    console.log('[LLMProvider] Config updated:', {
      baseUrl: config.baseUrl,
      model: config.model,
      hasApiKey: !!config.apiKey,
    });
  }

  /**
   * Get current configuration
   */
  getConfig(): LLMProviderConfig {
    return { ...this.config };
  }

  /**
   * Cancel ongoing request
   */
  cancelRequest(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
  }

  /**
   * Check if this is a DeepSeek provider
   */
  private matchesProviderType(type: ProviderType): boolean {
    return this.config.providerType === type;
  }

  private isDeepSeek(): boolean {
    if (this.config.providerType) {
      return this.matchesProviderType('deepseek');
    }
    return (
      this.config.baseUrl.includes('deepseek.com') ||
      this.config.model.includes('deepseek')
    );
  }

  /**
   * Check if this is a GLM/Z.AI provider
   */
  private isGLM(): boolean {
    if (this.config.providerType) {
      return this.matchesProviderType('glm');
    }
    return (
      this.config.baseUrl.includes('z.ai') ||
      this.config.model.includes('glm')
    );
  }

  /**
   * Build headers for requests, merging custom headers
   */
  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept-Language': 'en-US,en',
      ...this.config.customHeaders,
    };

    if (this.config.apiKey && !headers.Authorization) {
      headers.Authorization = `Bearer ${this.config.apiKey}`;
    }

    return headers;
  }

  /**
   * Build request body based on provider type
   */
  private buildRequestBody(
    messages: ChatMessage[],
    stream: boolean,
    options?: {
      tools?: ToolDefinition[];
      thinking?: ThinkingConfig;
      temperature?: number;
      maxTokens?: number;
    }
  ): Record<string, unknown> {
    const isDeepSeek = this.isDeepSeek();
    const isReasonerModel = this.config.model.includes('reasoner');

    // Base request
    const request: Record<string, unknown> = {
      model: this.config.model,
      messages,
      stream,
    };

    // Add max_tokens - use provider's maxOutputTokens limit if set
    const defaultMaxTokens =
      this.config.defaultMaxTokens ??
      this.config.maxOutputTokens ??
      4096;
    let maxTokens = options?.maxTokens ?? defaultMaxTokens;

    // Cap at provider's max output tokens limit if configured
    if (this.config.maxOutputTokens && maxTokens > this.config.maxOutputTokens) {
      maxTokens = this.config.maxOutputTokens;
    }

    request.max_tokens = maxTokens;

    // Handle thinking mode based on provider
    // Only add thinking param if provider supports it
    const supportsThinking = this.config.supportsThinking === true;

    if (isDeepSeek) {
      // DeepSeek: Don't send temperature/top_p for reasoner model
      // Thinking is enabled by using "deepseek-reasoner" model
      // Or by setting thinking parameter (but NOT temperature)
      if (supportsThinking && !isReasonerModel && options?.thinking?.type === 'enabled') {
        // For deepseek-chat with thinking enabled
        request.thinking = { type: 'enabled' };
      }
      // DeepSeek reasoner doesn't support temperature
      if (!isReasonerModel) {
        request.temperature = options?.temperature ?? this.config.defaultTemperature ?? 1.0;
      }
    } else if (this.isGLM()) {
      // GLM/Z.AI: Full thinking support (only if enabled)
      request.temperature = options?.temperature ?? this.config.defaultTemperature ?? 1.0;
      if (supportsThinking && options?.thinking?.type !== 'disabled') {
        request.thinking = options?.thinking ?? { type: 'enabled' };
      }
    } else {
      // Generic OpenAI-compatible: Standard params, NO thinking param
      request.temperature = options?.temperature ?? this.config.defaultTemperature ?? 1.0;
      // Don't add thinking for generic providers - they don't support it
    }

    // Add tools if provided
    if (options?.tools?.length) {
      request.tools = options.tools;
      request.tool_choice = 'auto';

      if (this.config.supportsToolStream) {
        request.tool_stream = true;
      }
    }

    // Request usage in streaming responses (OpenAI-compatible)
    if (stream) {
      request.stream_options = { include_usage: true };
    }

    // Merge in any custom params
    if (this.config.customParams) {
      Object.assign(request, this.config.customParams);
    }

    return request;
  }

  /**
   * Non-streaming chat completion (uses Tauri HTTP to bypass CORS)
   */
  async chatCompletion(
    messages: ChatMessage[],
    options?: {
      tools?: ToolDefinition[];
      thinking?: ThinkingConfig;
      temperature?: number;
      maxTokens?: number;
    }
  ): Promise<ChatCompletionResponse> {
    const requestBody = this.buildRequestBody(messages, false, options);

    const url = `${this.config.baseUrl}/chat/completions`;
    console.log('[LLMProvider] POST', url, 'request:', JSON.stringify(requestBody, null, 2));

    const llmRequest: LlmRequest = {
      url,
      method: 'POST',
      headers: this.buildHeaders(),
      body: JSON.stringify(requestBody),
      stream: false,
    };

    const response = await invoke<LlmResponse>('llm_request', { request: llmRequest });

    if (response.status >= 400) {
      console.error('[LLMProvider] Error response:', response.body);
      let errorMessage = `HTTP ${response.status}`;
      try {
        const errorJson = JSON.parse(response.body);
        errorMessage = errorJson.error?.message || errorJson.message || errorMessage;
      } catch {
        // Use status code if can't parse error
      }
      throw new Error(errorMessage);
    }

    return JSON.parse(response.body);
  }

  /**
   * Streaming chat completion with SSE (uses Tauri HTTP to bypass CORS)
   */
  async streamChatCompletion(
    messages: ChatMessage[],
    callbacks: StreamCallbacks,
    options?: {
      tools?: ToolDefinition[];
      thinking?: ThinkingConfig;
      temperature?: number;
      maxTokens?: number;
    }
  ): Promise<AssistantMessage> {
    this.abortController = new AbortController();

    const requestBody = this.buildRequestBody(messages, true, options);

    const url = `${this.config.baseUrl}/chat/completions`;
    console.log('[LLMProvider] Streaming POST', url, 'model:', this.config.model);
    console.log('[LLMProvider] Request body:', JSON.stringify(requestBody, null, 2));

    // Generate unique request ID for event handling
    const requestId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    // Accumulated message content
    let content = '';
    let reasoningContent = '';
    const toolCalls: Map<number, ToolCallRequest> = new Map();
    let streamBuffer = '';

    try {
      callbacks.onStart?.();

      // Set up event listeners for stream chunks
      const unlistenChunk = await listen<StreamChunk>(`llm-stream-${requestId}`, (event) => {
        const chunk = event.payload;

        if (chunk.done) {
          return; // Stream completed
        }

        // Append to buffer and process SSE data
        streamBuffer += chunk.data;

        // Process complete SSE events
        const lines = streamBuffer.split('\n');
        streamBuffer = lines.pop() || ''; // Keep incomplete line in buffer

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6).trim();

            if (data === '[DONE]') {
              continue;
            }

            try {
              const parsed: ChatCompletionChunk = JSON.parse(data);

              // Capture usage from chunk
              if (parsed.usage) {
                callbacks.onUsage?.(parsed.usage);
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
            } catch (e) {
              console.warn('Invalid SSE chunk:', data);
            }
          }
        }
      });

      // Set up error listener
      let streamError: Error | null = null;
      const unlistenError = await listen<string>(`llm-stream-error-${requestId}`, (event) => {
        streamError = new Error(event.payload);
      });

      // Start the streaming request
      const llmRequest: LlmRequest = {
        url,
        method: 'POST',
        headers: this.buildHeaders(),
        body: JSON.stringify(requestBody),
        stream: true,
      };

      await invoke('llm_stream_request', {
        app: undefined, // Tauri handles this
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
      // Handle various cancellation error formats
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error('Request cancelled');
      }
      
      // Handle Tauri cancellation error: {type: 'cancelation', msg: 'operation is manually canceled'}
      if (typeof error === 'object' && error !== null && 'type' in error) {
        const tauriError = error as { type: string; msg?: string };
        if (tauriError.type === 'cancelation') {
          throw new Error('Request cancelled');
        }
      }
      
      callbacks.onError?.(error instanceof Error ? error : new Error(String(error)));
      throw error;
    } finally {
      this.abortController = null;
    }
  }

}

// Singleton instance - starts as null, MUST be initialized before use
let providerInstance: LLMProvider | null = null;

/**
 * Get the LLM provider instance
 * Throws if not initialized
 */
export const getLLMProvider = (): LLMProvider => {
  if (!providerInstance) {
    throw new Error('LLM Provider not initialized. Call initLLMProvider first.');
  }
  return providerInstance;
};

/**
 * Check if provider is initialized
 */
export const isProviderInitialized = (): boolean => {
  return providerInstance !== null;
};

/**
 * Initialize LLM provider with config from settings
 * This MUST be called before using getLLMProvider
 */
type InitProviderConfig = Partial<Omit<LLMProviderConfig, 'baseUrl' | 'apiKey' | 'model'>> &
  Pick<LLMProviderConfig, 'baseUrl' | 'apiKey' | 'model'>;

export const initLLMProvider = (config: InitProviderConfig): LLMProvider => {
  const fullConfig: LLMProviderConfig = {
    id: config.id ?? 'current',
    name: config.name ?? 'Current Provider',
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    model: config.model,
    defaultTemperature: config.defaultTemperature ?? 1.0,
    defaultMaxTokens: config.defaultMaxTokens ?? 8192,
    maxOutputTokens: config.maxOutputTokens, // Provider's max output limit
    contextWindow: config.contextWindow, // Provider's context window
    supportsThinking: config.supportsThinking ?? true,
    supportsToolStream: config.supportsToolStream ?? false,
    providerType: config.providerType,
    customHeaders: config.customHeaders,
    customParams: config.customParams,
  };

  if (providerInstance) {
    // Update existing instance
    providerInstance.updateConfig(fullConfig);
  } else {
    // Create new instance
    providerInstance = new LLMProvider(fullConfig);
  }

  return providerInstance;
};

export default LLMProvider;
