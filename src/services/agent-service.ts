/**
 * Agent Service
 * Orchestrates AI interactions with tool calling and thinking
 * Uses Rust Context Engine for turn-based message management
 */
import { invoke } from '@tauri-apps/api/core';
import { parseToolArguments } from "../lib/tool-arguments";
import { getToolsForModel, toolRegistry } from "../tools";
import type { ToolDefinition as LegacyToolDefinition } from "../tools/types";
import { BASE_AGENT_SYSTEM_PROMPT, composeAgentSystemPrompt, type AgentPromptContext } from "./agent-prompt";
import { executeMcpTool, getMcpToolDefinitions, getMcpToolsSummary, isMcpTool, shouldAutoApproveMcpTool } from "./mcp-tools";
import { type IProvider, type ProviderConfig, createProvider } from "./providers";
import type { AssistantMessage, Message, StreamCallbacks as ProviderStreamCallbacks, ToolCallRequest, ToolDefinition } from "./providers/types";

export interface AgentCallbacks extends ProviderStreamCallbacks {
  onIterationComplete?: (iteration: number) => void;
  onToolApprovalRequired?: (toolCall: ToolCallRequest) => Promise<boolean>;
  onToolExecutionComplete?: (toolCall: ToolCallRequest, result: string) => void;
  onToolExecutionError?: (toolCall: ToolCallRequest, error: string) => void;
  onToolExecutionStart?: (toolCall: ToolCallRequest) => void;
  onToolRejected?: (toolCall: ToolCallRequest, reason: string) => void;
}

// ============================================
// AGENT TYPES
// ============================================
export interface AgentConfig {
  autoApproveTools?: boolean;
  getToolApproval?: (toolName: string) => 'auto' | 'always_ask' | 'deny';
  maxTokens?: number;
  maxToolIterations?: number;
  providerConfig?: ProviderConfig;
  systemPrompt?: string;
  temperature?: number;
  thinkingEnabled?: boolean;
  /** Thread ID for context engine */
  threadId?: string;
}

export interface AgentResponse {
  content: string;
  iterations: number;
  thinking?: string;
  toolCalls?: Array<{
    id: string;
    name: string;
    args: Record<string, any>;
    result: string;
    status: 'approved' | 'rejected' | 'executed' | 'failed';
  }>;
}

// ============================================
// RUST CONTEXT ENGINE TYPES
// ============================================
interface ApiMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: Array<{
    id: string;
    type: string;
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

interface ContextState {
  threadId: string;
  totalTurns: number;
  summarizedTurns: number;
  usedTokens: number;
  contextWindow: number;
  maxOutput: number;
  usagePercentage: number;
  needsSummarization: boolean;
  recentTurnsCount: number;
}

// ============================================
// AGENT SERVICE CLASS
// ============================================
export class AgentService {
  private config: AgentConfig;
  private isRunning = false;
  private provider: IProvider | null = null;

  constructor(config?: AgentConfig) {
    this.config = {
      systemPrompt: BASE_AGENT_SYSTEM_PROMPT,
      thinkingEnabled: true,
      autoApproveTools: false,
      maxToolIterations: 25,
      temperature: 1.0,
      maxTokens: 4096,
      ...config,
    };

    if (config?.providerConfig) {
      this.provider = createProvider(config.providerConfig);
    }
  }

  /**
   * Send a message and get a response with tool execution
   * Uses Rust Context Engine for message building
   */
  public async chat(
    userMessage: string,
    callbacks: AgentCallbacks,
    tools?: LegacyToolDefinition[],
    ideContext?: string | null,
    promptContext?: AgentPromptContext
  ): Promise<AgentResponse> {
    this.isRunning = true;
    const provider = this.getProvider();
    const threadId = this.config.threadId;

    if (!threadId) {
      throw new Error('Thread ID required for context engine');
    }

    // Get provider config for context window
    const providerConfig = this.config.providerConfig;
    const contextWindow = providerConfig?.contextWindow || 128000;
    const maxOutput = providerConfig?.maxOutputTokens || 8192;

    // Add user message to Rust context engine
    await invoke('context_add_user_message', {
      threadId,
      content: userMessage,
      ideContext: ideContext || null,
      contextWindow,
      maxOutput,
    });

    // Build layered system prompt with active skills and MCP tools summary
    const mcpSummary = getMcpToolsSummary();
    const composedPrompt = await composeAgentSystemPrompt({
      basePrompt: this.config.systemPrompt,
      mcpSummary,
      promptContext: promptContext ?? {
        userMessage,
      },
    });
    const enhancedSystemPrompt = composedPrompt.systemPrompt;

    if (composedPrompt.activeSkills.length > 0) {
      console.log(
        "[AgentService] Active skills:",
        composedPrompt.activeSkills.map((skill) => skill.id)
      );
    }

    // Build messages from Rust context engine
    const tokenBudget = contextWindow - maxOutput;
    const contextMessages = await invoke<ApiMessage[]>('context_build_messages', {
      threadId,
      systemPrompt: enhancedSystemPrompt,
      tokenBudget,
    });

    // Convert to provider message format
    const messages: Message[] = contextMessages.map(msg => {
      if (msg.role === 'tool') {
        return {
          role: 'tool' as const,
          tool_call_id: msg.tool_call_id!,
          content: msg.content,
        };
      }
      if (msg.role === 'assistant' && msg.tool_calls) {
        return {
          role: 'assistant' as const,
          content: msg.content,
          tool_calls: msg.tool_calls,
        };
      }
      return {
        role: msg.role as 'system' | 'user' | 'assistant',
        content: msg.content,
      };
    });

    // Get available tools
    const builtInTools: ToolDefinition[] = (tools || getToolsForModel()).map(t => ({
      type: 'function' as const,
      function: {
        name: t.function.name,
        description: t.function.description,
        parameters: t.function.parameters,
      },
    }));

    const mcpTools = getMcpToolDefinitions();
    const availableTools: ToolDefinition[] = [...builtInTools, ...mcpTools];

    let iteration = 0;
    let finalContent = '';
    let finalThinking = '';
    const executedToolCalls: AgentResponse['toolCalls'] = [];

    try {
      while (this.isRunning && iteration < this.config.maxToolIterations!) {
        iteration++;

        // Stream the response
        const response = await provider.streamChat(
          {
            messages,
            tools: availableTools,
            stream: true,
            temperature: this.config.temperature,
            maxTokens: this.config.maxTokens,
            thinkingEnabled: this.config.thinkingEnabled,
          },
          {
            onStart: callbacks.onStart,
            onToken: (token) => {
              finalContent += token;
              callbacks.onToken?.(token);
            },
            onThinking: (thinking) => {
              finalThinking += thinking;
              callbacks.onThinking?.(thinking);
            },
            onToolCall: callbacks.onToolCall,
            onUsage: callbacks.onUsage,
            onError: callbacks.onError,
          }
        );

        // Add assistant response to context engine
        const responseContent = Array.isArray(response.content)
          ? response.content.map(block => block.type === 'text' ? block.text : '').join('')
          : response.content;

        await invoke('context_add_assistant_response', {
          threadId,
          content: responseContent || '',
          thinking: response.reasoning_content || null,
        });

        // Add to local messages for continuation
        messages.push(response);

        if (response.content) {
          finalContent = responseContent || '';
        }

        if (response.reasoning_content) {
          finalThinking += response.reasoning_content;
        }

        // Handle tool calls
        if (response.tool_calls && response.tool_calls.length > 0) {
          console.log(`[AgentService] Executing ${response.tool_calls.length} tool calls...`);

          // Add tool calls to context engine
          for (const toolCall of response.tool_calls) {
            await invoke('context_add_tool_call', {
              threadId,
              toolCallId: toolCall.id,
              name: toolCall.function.name,
              arguments: toolCall.function.arguments,
            });
          }

          // Execute tools in parallel
          const toolPromises = response.tool_calls.map(async (toolCall) => {
            if (!this.isRunning) {
              callbacks.onToolRejected?.(toolCall, 'Agent stopped');
              return null;
            }

            const toolName = toolCall.function.name;
            const toolSetting = this.config.getToolApproval?.(toolName) ?? 'always_ask';

            const isMcp = isMcpTool(toolName);
            const mcpAutoApprove = isMcp && shouldAutoApproveMcpTool(toolName);
            const riskRequiresApproval = isMcp ? !mcpAutoApprove : toolRegistry.requiresApproval(toolName);
            const shouldAutoDeny = toolSetting === 'deny';
            const requiresUserApproval =
              !shouldAutoDeny &&
              !mcpAutoApprove &&
              (toolSetting === 'always_ask' ||
                (!this.config.autoApproveTools && riskRequiresApproval));

            let approved = !shouldAutoDeny;
            if (approved && requiresUserApproval) {
              if (callbacks.onToolApprovalRequired) {
                approved = await callbacks.onToolApprovalRequired(toolCall);
              } else {
                approved = false;
              }
            }

            if (shouldAutoDeny) {
              callbacks.onToolRejected?.(toolCall, 'Tool is set to deny');
            }

            const parsedArgsResult = parseToolArguments(toolCall.function.arguments);
            if (parsedArgsResult.status === 'invalid') {
              console.error(`[AgentService] Failed to parse tool arguments:`, parsedArgsResult.error);

              const errorResult = `Error: Invalid JSON in tool arguments (malformed or incomplete).`;

              callbacks.onToolExecutionError?.(toolCall, errorResult);

              await invoke('context_add_tool_result', {
                threadId,
                toolCallId: toolCall.id,
                content: errorResult,
                isError: true,
              });

              return {
                toolResult: {
                  id: toolCall.id,
                  name: toolName,
                  args: { raw: toolCall.function.arguments },
                  result: errorResult,
                  status: 'failed' as const,
                },
                message: {
                  role: 'tool' as const,
                  tool_call_id: toolCall.id,
                  content: errorResult,
                } as Message
              };
            }

            if (parsedArgsResult.status === 'repaired') {
              console.warn(
                `[AgentService] Repaired malformed tool arguments for ${toolName}`
              );
            }
            const parsedArgs = parsedArgsResult.args;

            const toolResult: NonNullable<AgentResponse['toolCalls']>[0] = {
              id: toolCall.id,
              name: toolName,
              args: parsedArgs,
              result: '',
              status: approved ? 'approved' : 'rejected',
            };

            if (approved) {
              callbacks.onToolExecutionStart?.(toolCall);

              try {
                let resultContent: string;

                const TOOL_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
                const toolExecution = isMcpTool(toolName)
                  ? executeMcpTool(toolName, parsedArgs)
                  : toolRegistry.executeToolCall(toolCall, parsedArgs).then(r => r.content);

                const timeoutPromise = new Promise<never>((_, reject) =>
                  setTimeout(() => reject(new Error(`Tool "${toolName}" timed out after 5 minutes`)), TOOL_TIMEOUT_MS)
                );

                resultContent = await Promise.race([toolExecution, timeoutPromise]);

                toolResult.result = resultContent;
                toolResult.status = 'executed';

                await invoke('context_add_tool_result', {
                  threadId,
                  toolCallId: toolCall.id,
                  content: resultContent,
                  isError: false,
                });

                callbacks.onToolExecutionComplete?.(toolCall, resultContent);

                return {
                  toolResult,
                  message: {
                    role: 'tool' as const,
                    tool_call_id: toolCall.id,
                    content: resultContent,
                  } as Message
                };
              } catch (error) {
                const errorMsg = error instanceof Error ? error.message : String(error);
                toolResult.result = errorMsg;
                toolResult.status = 'failed';

                await invoke('context_add_tool_result', {
                  threadId,
                  toolCallId: toolCall.id,
                  content: JSON.stringify({ error: errorMsg }),
                  isError: true,
                });

                callbacks.onToolExecutionError?.(toolCall, errorMsg);

                return {
                  toolResult,
                  message: {
                    role: 'tool' as const,
                    tool_call_id: toolCall.id,
                    content: JSON.stringify({ error: errorMsg }),
                  } as Message
                };
              }
            } else {
              const reason = shouldAutoDeny ? 'Tool denied by settings' : 'Tool execution rejected by user';
              const rejectMsg = JSON.stringify({ error: reason, tool: toolName });

              if (!shouldAutoDeny) {
                callbacks.onToolRejected?.(toolCall, reason);
              }
              
              await invoke('context_add_tool_result', {
                threadId,
                toolCallId: toolCall.id,
                content: rejectMsg,
                isError: true,
              });

              return {
                toolResult,
                message: {
                  role: 'tool' as const,
                  tool_call_id: toolCall.id,
                  content: rejectMsg,
                } as Message
              };
            }
          });

          const toolResults = await Promise.all(toolPromises);

          for (const result of toolResults) {
            if (result) {
              messages.push(result.message);
              executedToolCalls.push(result.toolResult);
            }
          }

          callbacks.onIterationComplete?.(iteration);
        } else {
          break;
        }
      }

      // Finalize the turn in context engine
      await invoke('context_finalize_turn', { threadId });

      // Check if summarization is needed
      const needsSummarization = await invoke<boolean>('context_needs_summarization', { threadId });
      if (needsSummarization) {
        console.log('[AgentService] Context at 80%+ - summarization recommended');
        // Summarization will be triggered separately
      }

      callbacks.onComplete?.({
        role: 'assistant',
        content: finalContent,
        reasoning_content: finalThinking || undefined,
      } as AssistantMessage);

      return {
        content: finalContent,
        thinking: finalThinking || undefined,
        toolCalls: executedToolCalls.length > 0 ? executedToolCalls : undefined,
        iterations: iteration,
      };

    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Get context state from Rust engine
   */
  public async getContextState(): Promise<ContextState | null> {
    const threadId = this.config.threadId;
    if (!threadId) return null;

    const providerConfig = this.config.providerConfig;
    const contextWindow = providerConfig?.contextWindow || 128000;
    const maxOutput = providerConfig?.maxOutputTokens || 8192;

    return invoke<ContextState>('context_get_state', {
      threadId,
      contextWindow,
      maxOutput,
    });
  }

  /**
   * Clear context for current thread
   */
  public async clearContext(): Promise<void> {
    const threadId = this.config.threadId;
    if (!threadId) return;

    await invoke('context_clear_thread', { threadId });
  }

  /**
   * Check if agent is currently running
   */
  public isActive(): boolean {
    return this.isRunning;
  }

  /**
   * Set thread ID for context engine
   */
  public setThreadId(threadId: string): void {
    this.config.threadId = threadId;
  }

  /**
   * Set provider configuration
   */
  public setProvider(config: ProviderConfig): void {
    this.provider = createProvider(config);
    this.config.providerConfig = config;
  }

  /**
   * Stop the current agent run
   */
  public stop(): void {
    this.isRunning = false;
    this.provider?.cancelRequest();
  }

  /**
   * Update agent configuration
   */
  public updateConfig(config: Partial<AgentConfig>): void {
    this.config = { ...this.config, ...config };
  }

  private getProvider(): IProvider {
    if (!this.provider) {
      throw new Error('Provider not initialized. Call setProvider first.');
    }
    return this.provider;
  }
}

/**
 * Get the agent service instance
 */
export const getAgentService = (): AgentService => {
  if (!agentInstance) {
    agentInstance = new AgentService();
  }
  return agentInstance;
};

/**
 * Initialize agent service with config
 */
export const initAgentService = (config?: AgentConfig): AgentService => {
  agentInstance = new AgentService(config);
  return agentInstance;
};

// Singleton instance
let agentInstance: AgentService | null = null;

export default AgentService;
