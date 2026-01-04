/**
 * Agent Service
 * Orchestrates AI interactions with tool calling and thinking
 * Manages the conversation loop with tool execution
 * 
 * Uses enterprise-grade provider system
 */
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
  providerConfig?: ProviderConfig; // Enterprise provider config
  systemPrompt?: string;
  temperature?: number;
  thinkingEnabled?: boolean;
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

// AGENT SERVICE CLASS
// ============================================
export class AgentService {
  private config: AgentConfig;
  private conversationHistory: Message[] = [];
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

    // Initialize enterprise provider if config provided
    if (config?.providerConfig) {
      this.provider = createProvider(config.providerConfig);
    }
  }

  /**
   * Send a message and get a response with tool execution
   */
  public async chat(
    userMessage: string,
    callbacks: AgentCallbacks,
    tools?: LegacyToolDefinition[]
  ): Promise<AgentResponse> {
    this.isRunning = true;
    const provider = this.getProvider();

    // Get MCP tools summary for system prompt enhancement
    const mcpSummary = getMcpToolsSummary();
    const enhancedSystemPrompt = mcpSummary 
      ? `${this.config.systemPrompt!}\n${mcpSummary}`
      : this.config.systemPrompt!;

    // Build messages with system prompt
    const messages: Message[] = [
      { role: 'system', content: enhancedSystemPrompt },
      ...this.conversationHistory,
      { role: 'user', content: userMessage },
    ];

    // Add user message to history
    this.conversationHistory.push({ role: 'user', content: userMessage });

    // Get available tools - convert legacy format to enterprise format
    const builtInTools: ToolDefinition[] = (tools || getToolsForModel()).map(t => ({
      type: 'function' as const,
      function: {
        name: t.function.name,
        description: t.function.description,
        parameters: t.function.parameters,
      },
    }));

    // Get MCP tools from connected servers
    const mcpTools = getMcpToolDefinitions();
    
    // Combine built-in tools with MCP tools
    const availableTools: ToolDefinition[] = [...builtInTools, ...mcpTools];

    let iteration = 0;
    let finalContent = '';
    let finalThinking = '';
    const executedToolCalls: AgentResponse['toolCalls'] = [];

    try {
      while (this.isRunning && iteration < this.config.maxToolIterations!) {
        iteration++;

        // Stream the response using enterprise provider
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
            onToken: callbacks.onToken,
            onThinking: (thinking) => {
              finalThinking += thinking;
              callbacks.onThinking?.(thinking);
            },
            onToolCall: callbacks.onToolCall,
            onUsage: callbacks.onUsage,
            onError: callbacks.onError,
          }
        );

        // Add assistant message to history
        messages.push(response);
        this.conversationHistory.push(response);

        // Update final content if we got any
        if (response.content) {
          finalContent = Array.isArray(response.content) ? response.content.map(block => block.type === 'text' ? block.text : '').join('') : response.content;
        }

        // Update thinking from reasoning_content
        if (response.reasoning_content) {
          finalThinking += response.reasoning_content;
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
          console.log(`[AgentService] Executing ${response.tool_calls.length} tool calls in parallel...`);

          // Execute all tool calls in parallel for speed (Cursor-style)
          const toolPromises = response.tool_calls.map(async (toolCall) => {
            if (!this.isRunning) return null;

            const toolName = toolCall.function.name;
            const toolSetting =
              this.config.getToolApproval?.(toolName) ?? 'always_ask';
            
            // Check if this is an MCP tool with auto-approve enabled
            const isMcp = isMcpTool(toolName);
            const mcpAutoApprove = isMcp && shouldAutoApproveMcpTool(toolName);
            
            // MCP tools with auto-approve skip user confirmation
            // Otherwise, check risk level
            const riskRequiresApproval = isMcp ? !mcpAutoApprove : toolRegistry.requiresApproval(toolName);
            const shouldAutoDeny = toolSetting === 'deny';
            const requiresUserApproval =
              !shouldAutoDeny &&
              !mcpAutoApprove && // Skip approval if MCP server has auto-approve enabled
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

            // Parse tool arguments with error handling (LLMs sometimes produce malformed JSON)
            let parsedArgs: Record<string, unknown> = {};
            try {
              parsedArgs = JSON.parse(toolCall.function.arguments || '{}');
            } catch (parseError) {
              console.error(`[AgentService] Failed to parse tool arguments for ${toolName}:`, toolCall.function.arguments);
              console.error('[AgentService] Parse error:', parseError);
              
              // Try to fix common JSON issues produced by LLMs
              let fixedArgs = toolCall.function.arguments || '{}';
              
              // Fix 1: Missing comma between properties (e.g., "value""key" -> "value","key")
              // This is a common GLM issue where it drops commas
              fixedArgs = fixedArgs.replace(/"([^"]*)"(\s*)"(\w+)":/g, '"$1",$2"$3":');
              
              // Fix 2: Remove trailing commas before } or ]
              fixedArgs = fixedArgs.replace(/,\s*([}\]])/g, '$1');
              
              // Fix 3: Add missing quotes around unquoted keys
              fixedArgs = fixedArgs.replace(/([{,]\s*)(\w+)(\s*:)/g, '$1"$2"$3');
              
              // Fix 4: Handle escaped backslashes in paths (common in Windows paths)
              // Sometimes LLMs produce \\\ instead of \\
              fixedArgs = fixedArgs.replace(/\\\\\\\\/g, '\\\\');
              
              try {
                parsedArgs = JSON.parse(fixedArgs);
                console.log('[AgentService] Fixed JSON successfully');
              } catch {
                // If still can't parse, return error to LLM so it can retry
                const errorResult: NonNullable<AgentResponse['toolCalls']>[0] = {
                  id: toolCall.id,
                  name: toolName,
                  args: { raw: toolCall.function.arguments },
                  result: `Error: Invalid JSON in tool arguments. The JSON could not be parsed. Please ensure your tool call arguments are valid JSON with proper commas between properties. Error: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
                  status: 'failed',
                };
                
                return {
                  toolResult: errorResult,
                  message: {
                    role: 'tool' as const,
                    tool_call_id: toolCall.id,
                    content: errorResult.result,
                  } as Message
                };
              }
            }

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
                
                // Check if this is an MCP tool
                if (isMcpTool(toolName)) {
                  // Execute MCP tool
                  resultContent = await executeMcpTool(toolName, parsedArgs);
                } else {
                  // Execute built-in tool with the PARSED args (not the potentially malformed original)
                  // Create a modified toolCall with properly stringified arguments
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
                toolResult.result = error instanceof Error ? error.message : String(error);
                toolResult.status = 'failed';

                return {
                  toolResult,
                  message: {
                    role: 'tool' as const,
                    tool_call_id: toolCall.id,
                    content: JSON.stringify({ error: toolResult.result }),
                  } as Message
                };
              }
            } else {
              // Tool was rejected
              return {
                toolResult,
                message: {
                  role: 'tool' as const,
                  tool_call_id: toolCall.id,
                  content: JSON.stringify({
                    error: 'Tool execution rejected by user',
                    tool: toolName,
                  }),
                } as Message
              };
            }
          });

          // Wait for all tools to complete in parallel
          const toolResults = await Promise.all(toolPromises);

          // Add all results to messages and tracking
          for (const result of toolResults) {
            if (result) {
              messages.push(result.message);
              this.conversationHistory.push(result.message);
              executedToolCalls.push(result.toolResult);
            }
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
   * Clear conversation history
   */
  public clearHistory(): void {
    this.conversationHistory = [];
  }

  /**
   * Get conversation history
   */
  public getHistory(): Message[] {
    return [...this.conversationHistory];
  }

  /**
   * Check if agent is currently running
   */
  public isActive(): boolean {
    return this.isRunning;
  }

  /**
   * Set conversation history from external source (e.g., thread store)
   * This enables context continuity when resuming a thread
   */
  public setHistory(messages: Message[]): void {
    this.conversationHistory = [...messages];
    console.log(`[AgentService] History set with ${messages.length} messages`);
  }

  /**
   * Set provider configuration (enterprise system)
   */
  public setProvider(config: ProviderConfig): void {
    this.provider = createProvider(config);
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

  /**
   * Get the current provider
   */
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
export const initAgentService = (
  config?: AgentConfig
): AgentService => {
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

**search_replace** - Find and replace exact text. PREFERRED for targeted edits. Use when:
- Editing specific functions or code blocks
- Fixing bugs in specific locations
- Adding/modifying/removing imports
- Changing variable names or values
- Any targeted edit to existing code

HOW search_replace WORKS:
1. Provide the EXACT text to find (old_string) - must match perfectly including whitespace
2. Provide the replacement text (new_string)
3. old_string must be UNIQUE in the file (appears only once)
4. Include enough context (3-5 lines) to make old_string unique

EXAMPLE:
old_string: "function hello() {\\n  return 'Hello';\\n}"
new_string: "function hello() {\\n  return 'Hello World';\\n}"

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
- MCP tool names follow the format: "ServerName: tool_name" in the UI.

## Task Management Guidelines

Use todo_write for complex tasks (3+ steps).

**Rules:**
1. Use proactively when starting multi-step tasks
2. Each task needs 'content' (imperative) and 'activeForm' (present continuous)
3. Mark ONE task as 'in_progress' at a time
4. Mark 'completed' IMMEDIATELY after finishing each task

## Behavioral Guidelines

1. **Understand First** - On new projects: use workspace_tree then aurora_search.
2. **Be Direct** - Complete tasks without unnecessary explanation.
3. **Parallel Tool Calls** - Call multiple tools at once when possible (10-100x faster).
4. **Don't Reinvent** - Terminal, file explorer already exist. Use editor_open_file for files.
5. **Stay Focused** - Complete the task, then stop. Don't add unrequested features.
6. **Actions Over Words** - Use tools, don't just describe what you would do.
7. **Read Before Edit** - Always read file contents before modifying.
8. **Fix Mistakes** - If edit introduces errors, fix them. Max 3 loops.
9. **Correct Paths** - Workspace root is current directory. Use full paths for editor_open_file.`; // ============================================

// Singleton instance
let agentInstance: AgentService | null = null;

export default AgentService;
