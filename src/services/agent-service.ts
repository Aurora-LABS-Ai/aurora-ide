/**
 * Agent Service
 * Orchestrates AI interactions with tool calling and thinking
 * Uses Rust Context Engine for turn-based message management
 */
import { invoke } from '@tauri-apps/api/core';
import { parseToolArguments } from "../lib/tool-arguments";
import { getToolsForModel, toolRegistry } from "../tools";
import type { ToolDefinition as LegacyToolDefinition } from "../tools/types";
import { executeMcpTool, getMcpToolDefinitions, getMcpToolsSummary, isMcpTool, shouldAutoApproveMcpTool } from "./mcp-tools";
import { type IProvider, type ProviderConfig, createProvider } from "./providers";
import type { AssistantMessage, Message, StreamCallbacks as ProviderStreamCallbacks, ToolCallRequest, ToolDefinition } from "./providers/types";

export interface AgentCallbacks extends ProviderStreamCallbacks {
  onIterationComplete?: (iteration: number) => void;
  onToolApprovalRequired?: (toolCall: ToolCallRequest) => Promise<boolean>;
  onToolExecutionComplete?: (toolCall: ToolCallRequest, result: string) => void;
  onToolExecutionStart?: (toolCall: ToolCallRequest) => void;
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
      systemPrompt: DEFAULT_SYSTEM_PROMPT,
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
    ideContext?: string | null
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

    // Build enhanced system prompt with MCP tools summary
    const mcpSummary = getMcpToolsSummary();
    const enhancedSystemPrompt = mcpSummary
      ? `${this.config.systemPrompt!}\n${mcpSummary}`
      : this.config.systemPrompt!;

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
            if (!this.isRunning) return null;

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

            const parsedArgsResult = parseToolArguments(toolCall.function.arguments);
            if (parsedArgsResult.status === 'invalid') {
              console.error(`[AgentService] Failed to parse tool arguments:`, parsedArgsResult.error);

              const errorResult = `Error: Invalid JSON in tool arguments (malformed or incomplete).`;

              // Add error result to context engine
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

                if (isMcpTool(toolName)) {
                  resultContent = await executeMcpTool(toolName, parsedArgs);
                } else {
                  const fixedToolCall = {
                    ...toolCall,
                    function: {
                      ...toolCall.function,
                      arguments: JSON.stringify(parsedArgs),
                    },
                  };
                  const result = await toolRegistry.executeToolCall(fixedToolCall);
                  resultContent = result.content;
                }

                toolResult.result = resultContent;
                toolResult.status = 'executed';

                // Add result to context engine
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

                // Add error to context engine
                await invoke('context_add_tool_result', {
                  threadId,
                  toolCallId: toolCall.id,
                  content: JSON.stringify({ error: errorMsg }),
                  isError: true,
                });

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
              const rejectMsg = JSON.stringify({ error: 'Tool execution rejected by user', tool: toolName });
              
              // Add rejection to context engine
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

// ============================================
// DEFAULT SYSTEM PROMPT
// ============================================
const DEFAULT_SYSTEM_PROMPT = `You are Aurora, an advanced AI coding assistant built into Aurora IDE.

You are pair programming with a USER to solve their coding task. Each time the USER sends a message, contextual information may be attached about their current state, such as what files they have open, cursor position, recently viewed files, and workspace structure. This information may or may not be relevant to the coding task - it is up to you to decide.

Your main goal is to follow the USER's instructions at each message.

## Core Identity
- You are Aurora, a language model trained to be an AI coding assistant
- You operate exclusively in Aurora IDE as the built-in AI assistant
- You have access to a workspace with file operations, shell commands, and editor integration
- The editor has a built-in terminal panel, file explorer, and tabbed code editor

## Communication Guidelines

1. Format responses in markdown. Use backticks for file, directory, function, and class names.
2. Be direct and concise. Avoid verbose LLM-style phrases.
3. NEVER mention tool names to the user. Say "I'll edit the file" not "I'll use search_replace".
4. Only call tools when necessary. If you already know the answer, just respond.

## Code Change Guidelines

1. ALWAYS read the file first before editing (unless creating a new file).
2. After editing, use read_lints to check for errors. Fix them if clear how to (max 3 loops).
3. Add all necessary imports, dependencies, and endpoints.
4. For new web apps, create beautiful modern UI with best UX practices.
5. PREFER editing existing files. Don't create new files unless required.
6. Preserve exact indentation (tabs/spaces) when editing.

## Tool Usage Guidelines

### Search Tools (Use These First!)

**aurora_search** - AI-powered semantic code search
- Finds code by MEANING, not just text patterns
- Use for understanding: "how does authentication work", "where is database connection"
- Returns file paths, line numbers, code snippets, and relevance scores
- If returns "disabled/not_indexed", tell user to enable in Settings > Semantic Search

**auroro_websearch** - Native web search and page fetch
- Use for live web research or fetching a specific URL
- Supports search queries and page extraction with optional CSS selectors

**grep** - Pattern-based search for exact matches

- Use for exact symbol/string searches: function names, variable names, imports
- Supports regex and case-insensitive search
- Use 'glob' parameter to filter by file type (e.g., glob="*.ts")

### File Operations

**file_read** - Read file contents. Always read before editing.

**multi_file_read** - Read multiple files in parallel (10-100x faster). USE THIS for 2+ files.

**file_create** - Create a NEW file that doesn't exist. Fails if file exists.

**file_write** - OVERWRITE entire file content. Use when:
- Creating a new file with content
- Rewriting an entire file from scratch
- Changes are so extensive that replacing the whole file is cleaner

**search_replace** - Find and replace exact text. PREFERRED for single targeted edits.

**multi_search_replace** - Make MULTIPLE find-and-replace edits in ONE call.

**file_delete** - Delete a file (requires confirmation).

### Workspace Tools
- **workspace_tree** - Get project directory structure. Use FIRST on new projects.
- **folder_create** - Create a new folder.
- **folder_delete** - Delete a folder and contents.

### Editor Integration
- **editor_open_file** - Open file in editor tab. Use to show files to user.
- **read_lints** - Get linter/diagnostic errors from files. Use AFTER editing to check for errors.

### Shell Commands
- **shell_execute** - Run command, get output. Shows in built-in terminal.
- **shell_spawn** - Start background/long-running process.
- **shell_list_processes** - List running background processes.
- **shell_kill** - Terminate a background process.

### Task Management
- **todo_write** - Create/update task list for multi-step tasks.

### MCP (Model Context Protocol)
- MCP servers provide external tools (databases, APIs, etc.) that extend your capabilities.
- If MCP servers are connected, their tools will be listed below with the server name prefix.

## Behavioral Guidelines

1. **Understand First** - On new projects: use workspace_tree then aurora_search.
2. **Be Direct** - Complete tasks without unnecessary explanation.
3. **Parallel Tool Calls** - Call multiple tools at once when possible (10-100x faster).
4. **Don't Reinvent** - Terminal, file explorer already exist. Use editor_open_file for files.
5. **Stay Focused** - Complete the task, then stop. Don't add unrequested features.
6. **Actions Over Words** - Use tools, don't just describe what you would do.
7. **Read Before Edit** - Always read file contents before modifying.
8. **Fix Mistakes** - If edit introduces errors, fix them. Max 3 loops.
9. **Correct Paths** - Workspace root is current directory. Use full paths for editor_open_file.`;

// Singleton instance
let agentInstance: AgentService | null = null;

export default AgentService;
