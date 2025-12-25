/**
 * LLM Provider Service
 * Handles communication with OpenAI-compatible APIs
 * Supports streaming with SSE for real-time responses
 * 
 * NOTE: This class has NO hardcoded defaults. All config must come from settings.
 */

import type {
  ChatMessage,
  ChatCompletionResponse,
  ChatCompletionChunk,
  LLMProviderConfig,
  StreamCallbacks,
  AssistantMessage,
  ThinkingConfig,
} from './llm-types';
import type { ToolDefinition, ToolCallRequest } from '../tools/types';

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
  private isDeepSeek(): boolean {
    return this.config.baseUrl.includes('deepseek.com') || 
           this.config.model.includes('deepseek');
  }

  /**
   * Check if this is a GLM/Z.AI provider
   */
  private isGLM(): boolean {
    return this.config.baseUrl.includes('z.ai') || 
           this.config.model.includes('glm');
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
    let maxTokens = options?.maxTokens ?? this.config.defaultMaxTokens ?? 4096;
    
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
    }

    return request;
  }

  /**
   * Non-streaming chat completion
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
    const request = this.buildRequestBody(messages, false, options);

    const url = `${this.config.baseUrl}/chat/completions`;
    console.log('[LLMProvider] POST', url, 'request:', JSON.stringify(request, null, 2));

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.config.apiKey}`,
        'Accept-Language': 'en-US,en',
      },
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[LLMProvider] Error response:', errorText);
      let errorMessage = `HTTP ${response.status}`;
      try {
        const errorJson = JSON.parse(errorText);
        errorMessage = errorJson.error?.message || errorJson.message || errorMessage;
      } catch {
        // Use status code if can't parse error
      }
      throw new Error(errorMessage);
    }

    return response.json();
  }

  /**
   * Streaming chat completion with SSE
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

    const request = this.buildRequestBody(messages, true, options);

    const url = `${this.config.baseUrl}/chat/completions`;
    console.log('[LLMProvider] Streaming POST', url, 'model:', this.config.model);
    console.log('[LLMProvider] Request body:', JSON.stringify(request, null, 2));

    try {
      callbacks.onStart?.();

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.config.apiKey}`,
          'Accept-Language': 'en-US,en',
        },
        body: JSON.stringify(request),
        signal: this.abortController.signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error('[LLMProvider] Error response:', errorText);
        let errorMessage = `HTTP ${response.status}`;
        try {
          const errorJson = JSON.parse(errorText);
          errorMessage = errorJson.error?.message || errorJson.message || errorMessage;
        } catch {
          // Use status code if can't parse error
        }
        throw new Error(errorMessage);
      }

      // Process SSE stream
      const result = await this.processStream(response, callbacks);
      
      callbacks.onComplete?.(result);
      return result;

    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error('Request cancelled');
      }
      callbacks.onError?.(error instanceof Error ? error : new Error(String(error)));
      throw error;
    } finally {
      this.abortController = null;
    }
  }

  /**
   * Process SSE stream from the API
   */
  private async processStream(
    response: Response,
    callbacks: StreamCallbacks
  ): Promise<AssistantMessage> {
    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error('No response body');
    }

    const decoder = new TextDecoder();
    let buffer = '';
    
    // Accumulated message content
    let content = '';
    let reasoningContent = '';
    const toolCalls: Map<number, ToolCallRequest> = new Map();

    try {
      while (true) {
        const { done, value } = await reader.read();
        
        if (done) break;
        
        buffer += decoder.decode(value, { stream: true });
        
        // Process complete SSE events
        const lines = buffer.split('\n');
        buffer = lines.pop() || ''; // Keep incomplete line in buffer
        
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6).trim();
            
            // Check for stream end
            if (data === '[DONE]') {
              continue;
            }
            
            try {
              const chunk: ChatCompletionChunk = JSON.parse(data);
              
              for (const choice of chunk.choices) {
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
                      // New tool call
                      toolCalls.set(index, {
                        id: tc.id || `tool_${index}`,
                        type: 'function',
                        function: {
                          name: tc.function?.name || '',
                          arguments: tc.function?.arguments || '',
                        },
                      });
                    } else {
                      // Append to existing tool call
                      const existing = toolCalls.get(index)!;
                      if (tc.function?.name) {
                        existing.function.name = tc.function.name;
                      }
                      if (tc.function?.arguments) {
                        existing.function.arguments += tc.function.arguments;
                      }
                    }
                    
                    // Notify about tool call update
                    const currentToolCall = toolCalls.get(index)!;
                    callbacks.onToolCall?.(currentToolCall);
                  }
                }
              }
            } catch (e) {
              // Skip invalid JSON chunks
              console.warn('Invalid SSE chunk:', data);
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    // Build final message
    const result: AssistantMessage = {
      role: 'assistant',
      content,
      reasoning_content: reasoningContent || undefined,
      tool_calls: toolCalls.size > 0 ? Array.from(toolCalls.values()) : undefined,
    };

    return result;
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
export const initLLMProvider = (config: {
  baseUrl: string;
  apiKey: string;
  model: string;
  maxOutputTokens?: number;
  contextWindow?: number;
  supportsThinking?: boolean;
}): LLMProvider => {
  const fullConfig: LLMProviderConfig = {
    id: 'current',
    name: 'Current Provider',
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    model: config.model,
    defaultTemperature: 1.0,
    defaultMaxTokens: 8192,
    maxOutputTokens: config.maxOutputTokens, // Provider's max output limit
    contextWindow: config.contextWindow, // Provider's context window
    supportsThinking: config.supportsThinking ?? true,
    supportsToolStream: false,
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
