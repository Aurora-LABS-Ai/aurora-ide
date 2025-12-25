/**
 * Agent Service
 * Orchestrates AI interactions with tool calling and thinking
 * Manages the conversation loop with tool execution
 */

import { LLMProvider, getLLMProvider } from './llm-provider';
import type { 
  ChatMessage, 
  ThinkingConfig,
  StreamCallbacks 
} from './llm-types';
import { toolRegistry, getToolsForModel } from '../tools';
import type { ToolCallRequest, ToolDefinition } from '../tools/types';

// ============================================
// AGENT TYPES
// ============================================

export interface AgentConfig {
  systemPrompt?: string;
  thinkingEnabled?: boolean;
  autoApproveTools?: boolean;
  maxToolIterations?: number;
  temperature?: number;
  maxTokens?: number;
}

export interface AgentCallbacks extends StreamCallbacks {
  onToolApprovalRequired?: (toolCall: ToolCallRequest) => Promise<boolean>;
  onToolExecutionStart?: (toolCall: ToolCallRequest) => void;
  onToolExecutionComplete?: (toolCall: ToolCallRequest, result: string) => void;
  onIterationComplete?: (iteration: number) => void;
}

export interface AgentResponse {
  content: string;
  thinking?: string;
  toolCalls?: Array<{
    id: string;
    name: string;
    args: Record<string, any>;
    result: string;
    status: 'approved' | 'rejected' | 'executed' | 'failed';
  }>;
  iterations: number;
}

// ============================================
// DEFAULT SYSTEM PROMPT
// ============================================

const DEFAULT_SYSTEM_PROMPT = `You are Aurora, an advanced AI coding assistant with deep expertise in software development.

You have access to a workspace and can:
- Read and write files
- Navigate the directory structure  
- Execute shell commands
- Search code

When helping users:
1. Think through problems step by step
2. Use tools to gather information before making changes
3. Explain your reasoning and actions
4. Write clean, well-documented code
5. Follow best practices for the language/framework being used

Always be helpful, accurate, and professional.`;

// ============================================
// AGENT SERVICE CLASS
// ============================================

export class AgentService {
  private config: AgentConfig;
  private conversationHistory: ChatMessage[] = [];
  private isRunning = false;

  constructor(config?: AgentConfig) {
    this.config = {
      systemPrompt: DEFAULT_SYSTEM_PROMPT,
      thinkingEnabled: true,
      autoApproveTools: false,
      maxToolIterations: 25, // Increased to allow more complex tool chains
      temperature: 1.0,
      maxTokens: 4096,
      ...config,
    };
  }

  /**
   * Get the current LLM provider (always fresh from singleton)
   */
  private get provider(): LLMProvider {
    return getLLMProvider();
  }

  /**
   * Update agent configuration
   */
  updateConfig(config: Partial<AgentConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Get conversation history
   */
  getHistory(): ChatMessage[] {
    return [...this.conversationHistory];
  }

  /**
   * Clear conversation history
   */
  clearHistory(): void {
    this.conversationHistory = [];
  }

  /**
   * Stop the current agent run
   */
  stop(): void {
    this.isRunning = false;
    this.provider.cancelRequest();
  }

  /**
   * Check if agent is currently running
   */
  isActive(): boolean {
    return this.isRunning;
  }

  /**
   * Send a message and get a response with tool execution
   */
  async chat(
    userMessage: string,
    callbacks: AgentCallbacks,
    tools?: ToolDefinition[]
  ): Promise<AgentResponse> {
    this.isRunning = true;
    
    // Build messages with system prompt
    const messages: ChatMessage[] = [
      { role: 'system', content: this.config.systemPrompt! },
      ...this.conversationHistory,
      { role: 'user', content: userMessage },
    ];
    
    // Add user message to history
    this.conversationHistory.push({ role: 'user', content: userMessage });

    // Get available tools
    const availableTools = tools || getToolsForModel();
    
    // Thinking config
    const thinkingConfig: ThinkingConfig = {
      type: this.config.thinkingEnabled ? 'enabled' : 'disabled',
      clear_thinking: false, // Preserve thinking for context
    };

    let iteration = 0;
    let finalContent = '';
    let finalThinking = '';
    const executedToolCalls: AgentResponse['toolCalls'] = [];

    try {
      while (this.isRunning && iteration < this.config.maxToolIterations!) {
        iteration++;

        // Stream the response
        const response = await this.provider.streamChatCompletion(
          messages,
          {
            onStart: callbacks.onStart,
            onToken: callbacks.onToken,
            onThinking: (thinking) => {
              finalThinking += thinking;
              callbacks.onThinking?.(thinking);
            },
            onToolCall: callbacks.onToolCall,
            onError: callbacks.onError,
          },
          {
            tools: availableTools,
            thinking: thinkingConfig,
            temperature: this.config.temperature,
            maxTokens: this.config.maxTokens,
          }
        );

        // Add assistant message to history (includes reasoning_content for DeepSeek)
        messages.push(response);
        this.conversationHistory.push(response);
        
        // Update final content if we got any
        if (response.content) {
          finalContent = response.content;
        }
        
        console.log('[AgentService] Response:', {
          hasContent: !!response.content,
          contentLength: response.content?.length || 0,
          hasReasoning: !!response.reasoning_content,
          reasoningLength: response.reasoning_content?.length || 0,
          hasToolCalls: !!response.tool_calls?.length,
          toolCallCount: response.tool_calls?.length || 0,
        });

        // Check if we have tool calls to execute
        if (response.tool_calls && response.tool_calls.length > 0) {
          // Execute each tool call
          for (const toolCall of response.tool_calls) {
            if (!this.isRunning) break;

            // Check if tool requires approval
            const needsApproval = !this.config.autoApproveTools && 
              toolRegistry.requiresApproval(toolCall.function.name);

            let approved = true;
            if (needsApproval && callbacks.onToolApprovalRequired) {
              approved = await callbacks.onToolApprovalRequired(toolCall);
            }

            const toolResult: NonNullable<AgentResponse['toolCalls']>[0] = {
              id: toolCall.id,
              name: toolCall.function.name,
              args: JSON.parse(toolCall.function.arguments || '{}'),
              result: '',
              status: approved ? 'approved' : 'rejected',
            };

            if (approved) {
              callbacks.onToolExecutionStart?.(toolCall);

              try {
                // Execute the tool
                const result = await toolRegistry.executeToolCall(toolCall);
                toolResult.result = result.content;
                toolResult.status = 'executed';

                // Add tool result to messages
                messages.push({
                  role: 'tool',
                  tool_call_id: toolCall.id,
                  content: result.content,
                });
                this.conversationHistory.push({
                  role: 'tool',
                  tool_call_id: toolCall.id,
                  content: result.content,
                });

                callbacks.onToolExecutionComplete?.(toolCall, result.content);
              } catch (error) {
                toolResult.result = error instanceof Error ? error.message : String(error);
                toolResult.status = 'failed';

                // Add error to messages
                messages.push({
                  role: 'tool',
                  tool_call_id: toolCall.id,
                  content: JSON.stringify({ error: toolResult.result }),
                });
              }
            } else {
              // Tool was rejected
              messages.push({
                role: 'tool',
                tool_call_id: toolCall.id,
                content: JSON.stringify({ error: 'Tool execution rejected by user' }),
              });
            }

            executedToolCalls.push(toolResult);
          }

          callbacks.onIterationComplete?.(iteration);
          // Continue loop to get next response after tool execution
        } else {
          // No tool calls, we're done
          break;
        }
      }

      callbacks.onComplete?.({
        role: 'assistant',
        content: finalContent,
        reasoning_content: finalThinking || undefined,
      });

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
}

// Singleton instance
let agentInstance: AgentService | null = null;

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
export const initAgentService = (
  config?: AgentConfig
): AgentService => {
  agentInstance = new AgentService(config);
  return agentInstance;
};

export default AgentService;

