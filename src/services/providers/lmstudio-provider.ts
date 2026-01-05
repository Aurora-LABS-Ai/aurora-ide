/**
 * LM Studio Provider - Uses raw HTTP streaming for reliable local model support
 * 
 * This provider uses native Rust HTTP streaming to support extended fields
 * like reasoning_content that reasoning models return.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import { BaseProvider } from "./base-provider";
import { getProviderPreset, buildThinkingParams, type ProviderPreset } from "./provider-presets";
import type { AssistantMessage, ChatRequest, ChatResponse, ProviderConfig, StreamCallbacks, TokenUsage, ToolCallRequest } from "./types";

// Tauri event types from Rust
interface NativeStreamChunk {
  content: string | null;
  reasoning_content: string | null;
  tool_calls: StreamToolCall[] | null;
  finish_reason: string | null;
  done: boolean;
}

interface StreamToolCall {
  index: number;
  id: string | null;
  function_name: string | null;
  function_arguments: string | null;
}

interface UsageInfo {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

// Request format for Rust command
interface OpenAINativeRequest {
  base_url: string;
  api_key: string;
  model: string;
  messages: Array<{
    role: string;
    content?: string;
    tool_calls?: Array<{
      id: string;
      type?: string;
      function: {
        name: string;
        arguments: string;
      };
    }>;
    tool_call_id?: string;
  }>;
  tools?: Array<{
    type: string;
    function: {
      name: string;
      description: string;
      parameters: unknown;
    };
  }>;
  temperature?: number;
  max_tokens?: number;
  stream: boolean;
  /** Extra body parameters for thinking models (e.g., reasoning_effort) */
  extra_body?: Record<string, unknown>;
}

export class LMStudioProvider extends BaseProvider {
  private preset: ProviderPreset;

  constructor(config: ProviderConfig) {
    super(config);
    // Get the preset for this provider type (lmstudio)
    this.preset = getProviderPreset(config.providerType || 'lmstudio');
  }

  /**
   * Cancel ongoing streaming request
   */
  public override cancelRequest(): void {
    super.cancelRequest();
    // Note: Full Rust-side cancellation would need additional implementation
  }

  /**
   * Non-streaming chat completion
   */
  public async chat(request: ChatRequest): Promise<ChatResponse> {
    const nativeRequest = this.buildNativeRequest(request, false);

    const response = await invoke<Record<string, unknown>>('openai_native_chat', {
      request: nativeRequest,
    });

    // Parse the response
    const choices = response.choices as Array<{
      message: {
        content?: string;
        tool_calls?: Array<{
          id: string;
          function: { name: string; arguments: string };
        }>;
      };
    }>;

    const choice = choices?.[0];
    const message: AssistantMessage = {
      role: 'assistant',
      content: choice?.message?.content || '',
      tool_calls: choice?.message?.tool_calls?.map(tc => ({
        id: tc.id,
        type: 'function' as const,
        function: {
          name: tc.function.name,
          arguments: tc.function.arguments,
        },
      })),
    };

    const usage = response.usage as { prompt_tokens: number; completion_tokens: number; total_tokens: number } | undefined;
    const tokenUsage: TokenUsage | undefined = usage
      ? {
          promptTokens: usage.prompt_tokens,
          completionTokens: usage.completion_tokens,
          totalTokens: usage.total_tokens,
        }
      : undefined;

    return { message, usage: tokenUsage };
  }

  /**
   * Streaming chat completion using native Rust async-openai
   */
  public async streamChat(
    request: ChatRequest,
    callbacks: StreamCallbacks
  ): Promise<AssistantMessage> {
    const nativeRequest = this.buildNativeRequest(request, true);

    // Generate unique request ID for event handling
    const requestId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    // Accumulators
    let content = '';
    let reasoningContent = '';
    const toolCalls: Map<number, ToolCallRequest> = new Map();
    let streamError: Error | null = null;

    // Create a promise that resolves when streaming is complete
    // This is necessary because Tauri events are async and invoke may return
    // before all events are delivered
    const streamComplete = new Promise<void>((resolve, reject) => {
      let unlistenChunk: (() => void) | null = null;
      let unlistenUsage: (() => void) | null = null;
      let unlistenError: (() => void) | null = null;

      const cleanup = () => {
        unlistenChunk?.();
        unlistenUsage?.();
        unlistenError?.();
      };

      // Set up listeners asynchronously
      (async () => {
        callbacks.onStart?.();

        // Set up event listener for stream chunks
        let chunkCount = 0;
        const startTime = Date.now();
        
        unlistenChunk = await listen<NativeStreamChunk>(
          `openai-native-chunk-${requestId}`,
          (event) => {
            const chunk = event.payload;
            chunkCount++;
            
            // Log first few chunks to debug streaming
            if (chunkCount <= 5) {
              const elapsed = Date.now() - startTime;
              console.log(`[LMStudioProvider] Chunk ${chunkCount} at ${elapsed}ms:`, {
                hasContent: !!chunk.content,
                hasReasoning: !!chunk.reasoning_content,
                done: chunk.done,
              });
            }

            // Check for completion
            if (chunk.done) {
              console.log(`[LMStudioProvider] Stream done: ${chunkCount} chunks in ${Date.now() - startTime}ms`);
              cleanup();
              if (streamError) {
                reject(streamError);
              } else {
                resolve();
              }
              return;
            }

            // Handle content
            if (chunk.content) {
              content += chunk.content;
              callbacks.onToken?.(chunk.content);
            }

            // Handle reasoning content (if provider supports it)
            if (chunk.reasoning_content) {
              reasoningContent += chunk.reasoning_content;
              callbacks.onThinking?.(chunk.reasoning_content);
            }

            // Handle tool calls
            if (chunk.tool_calls) {
              for (const tc of chunk.tool_calls) {
                const index = tc.index;

                if (!toolCalls.has(index)) {
                  toolCalls.set(index, {
                    id: tc.id || `tool_${index}`,
                    type: 'function',
                    function: {
                      name: tc.function_name || '',
                      arguments: tc.function_arguments || '',
                    },
                  });
                } else {
                  const existing = toolCalls.get(index)!;
                  if (tc.function_name) {
                    existing.function.name = tc.function_name;
                  }
                  if (tc.function_arguments) {
                    existing.function.arguments += tc.function_arguments;
                  }
                }

                callbacks.onToolCall?.(toolCalls.get(index)!);
              }
            }
          }
        );

        // Set up usage listener
        unlistenUsage = await listen<UsageInfo>(
          `openai-native-usage-${requestId}`,
          (event) => {
            callbacks.onUsage?.({
              promptTokens: event.payload.prompt_tokens,
              completionTokens: event.payload.completion_tokens,
              totalTokens: event.payload.total_tokens,
            });
          }
        );

        // Set up error listener
        unlistenError = await listen<string>(
          `openai-native-error-${requestId}`,
          (event) => {
            streamError = new Error(event.payload);
            // Don't reject here - wait for done chunk or timeout
          }
        );

        // Start the streaming request via Rust async-openai
        try {
          await invoke('openai_native_stream', {
            requestId,
            request: nativeRequest,
          });
        } catch (invokeError) {
          cleanup();
          reject(invokeError);
        }
      })();
    });

    try {
      // Wait for stream to complete (via done chunk)
      await streamComplete;

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
      callbacks.onError?.(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  /**
   * Build the native request object for Rust
   */
  private buildNativeRequest(request: ChatRequest, stream: boolean): OpenAINativeRequest {
    // Convert messages to the format expected by Rust
    const messages = request.messages.map(msg => {
      const result: OpenAINativeRequest['messages'][0] = {
        role: msg.role,
      };

      // Handle content
      if (msg.content !== undefined && msg.content !== null) {
        result.content = typeof msg.content === 'string' 
          ? msg.content 
          : Array.isArray(msg.content) 
            ? msg.content.map(b => 'text' in b ? (b as { text: string }).text : '').join('')
            : '';
      }

      // Handle tool calls for assistant messages
      if (msg.role === 'assistant') {
        const assistantMsg = msg as AssistantMessage;
        if (assistantMsg.tool_calls && assistantMsg.tool_calls.length > 0) {
          result.tool_calls = assistantMsg.tool_calls.map(tc => ({
            id: tc.id,
            type: 'function',
            function: {
              name: tc.function.name,
              arguments: typeof tc.function.arguments === 'string'
                ? tc.function.arguments
                : JSON.stringify(tc.function.arguments),
            },
          }));
        }
      }

      // Handle tool_call_id for tool messages
      if (msg.role === 'tool') {
        const toolMsg = msg as { tool_call_id?: string };
        if (toolMsg.tool_call_id) {
          result.tool_call_id = toolMsg.tool_call_id;
        }
      }

      return result;
    });

    // Convert tools
    const tools = request.tools?.map(t => ({
      type: t.type,
      function: {
        name: t.function.name,
        description: t.function.description || '',
        parameters: t.function.parameters,
      },
    }));

    // Build extra_body with thinking params if enabled
    let extra_body: Record<string, unknown> | undefined = undefined;
    
    // Check if thinking should be enabled:
    // 1. Provider supports thinking (from settings checkbox)
    // 2. Request has thinkingEnabled (user toggle)
    // 3. Preset has thinkingConfig with requestParam
    if (this._config.supportsThinking && request.thinkingEnabled !== false) {
      const thinkingParams = buildThinkingParams(this.preset, true);
      if (Object.keys(thinkingParams).length > 0) {
        extra_body = thinkingParams;
        console.log('[LMStudioProvider] Thinking enabled, extra_body:', extra_body);
      }
    }

    return {
      base_url: this._config.baseUrl,
      api_key: this._config.apiKey || 'lm-studio', // LM Studio doesn't require a real API key
      model: this._config.model,
      messages,
      tools: tools && tools.length > 0 ? tools : undefined,
      temperature: this.getTemperature(request.temperature),
      max_tokens: this.getMaxTokens(request.maxTokens),
      stream,
      extra_body,
    };
  }
}

