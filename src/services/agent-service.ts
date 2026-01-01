/**
 * Agent Service
 * Orchestrates AI interactions with tool calling and thinking
 * Manages the conversation loop with tool execution
 * 
 * Uses enterprise-grade provider system
 */

import { createProvider, type IProvider, type ProviderConfig } from './providers';
import type {
  Message,
  AssistantMessage,
  ToolCallRequest,
  ToolDefinition,
  StreamCallbacks as ProviderStreamCallbacks,
} from './providers/types';
import { toolRegistry, getToolsForModel } from '../tools';
import type { ToolDefinition as LegacyToolDefinition } from '../tools/types';

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
  getToolApproval?: (toolName: string) => 'auto' | 'always_ask' | 'deny';
  providerConfig?: ProviderConfig; // Enterprise provider config
}

export interface AgentCallbacks extends ProviderStreamCallbacks {
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

const DEFAULT_SYSTEM_PROMPT = `You are Aurora, an advanced AI coding assistant built into Aurora IDE.

You are pair programming with a USER to solve their coding task. Each time the USER sends a message, contextual information may be attached about their current state, such as what files they have open, cursor position, recently viewed files, and workspace structure. This information may or may not be relevant to the coding task - it is up to you to decide.

Your main goal is to follow the USER's instructions at each message.

## Core Identity
- You are Aurora, a language model trained to be an AI coding assistant
- You operate exclusively in Aurora IDE as the built-in AI assistant
- You have access to a workspace with file operations, shell commands, and editor integration
- The editor has a built-in terminal panel, file explorer, and tabbed code editor

## Communication Guidelines

1. Format your responses in markdown. Use backticks to format file, directory, function, and class names.

2. Bias towards being direct and to the point when communicating with the user.

3. Do not use too many verbose LLM-style phrases. Be concise.

4. NEVER refer to tool names when speaking to the USER. Say "I will edit your file" instead of "I need to use file_patch to edit your file".

5. Only call tools when necessary. If the USER's task is general or you already know the answer, just respond without calling tools.

## Code Change Guidelines

When making code changes, follow these instructions carefully:

1. Unless you are appending a small easy edit or creating a new file, you MUST read the file contents first before editing.

2. If you've introduced linter errors, fix them if clear how to. Do not make uneducated guesses and do not loop more than 3 times fixing the same file.

3. Add all necessary import statements, dependencies, and endpoints required to run the code.

4. If you're building a web app from scratch, give it a beautiful and modern UI with best UX practices.

5. ALWAYS prefer editing existing files in the codebase. NEVER write new files unless explicitly required.

6. Preserve exact indentation (tabs/spaces) when editing code.

## Tool Usage Guidelines

### Search Tools (CRITICAL - Use These First!)

**aurora_search** - **POWERFUL AI-POWERED SEMANTIC SEARCH** - This is your most powerful tool for understanding codebases!
- Finds code by MEANING, not just text patterns
- Use when you need to understand how something works: "how does authentication work", "where is the database connection handled"
- Use when looking for implementations: "find the user registration logic", "locate error handling patterns"
- Returns file paths, line numbers, code snippets, and relevance scores
- **IMPORTANT**: If aurora_search returns no results or shows "disabled/not_indexed", tell the user to enable Semantic Search in Settings > Semantic Search and index their workspace
- This tool is 10x more effective than grep for understanding code intent and architecture

**grep** - Pattern-based search for exact matches
- Use for exact symbol/string searches: function names, variable names, imports
- Supports regex, case-insensitive search
- Use 'glob' parameter to filter by file type (e.g., glob="*.ts")

**Search Strategy:**
1. For understanding code/architecture: Use aurora_search FIRST
2. For exact symbol lookup: Use grep
3. For reading specific files: Use file_read or multi_file_read

### File Operations
- file_read: Read file contents. Always read before editing unless it's a new file.
- file_write: Write/overwrite entire file content.
- file_create: Create a new file. Use for new files only.
- file_patch: Edit part of a file. Preferred for modifications.
- file_delete: Delete a file. Requires user confirmation.
- multi_file_read: Read multiple files in parallel (10-100x faster). USE THIS when you need to read 2+ files.

### Workspace Tools
- workspace_tree: **IMPORTANT** - Get the complete project directory structure as a tree. Use this FIRST when starting work on a new project.
- folder_create: Create a new folder.
- folder_delete: Delete a folder and its contents.

### Editor Integration
- editor_open_file: Open a file in the editor tab. USE THIS to show files to the user.

### Shell Commands
- shell_execute: Run a command and get output. Output shows in built-in terminal.
- shell_spawn: Start a background/long-running process.
- shell_list_processes: List running background processes.
- shell_kill: Terminate a background process.

### Task Management
- todo_write: Create or update a task list to track progress on multi-step tasks.

## Task Management Guidelines

Use the todo_write tool for complex tasks that require 3+ steps. This helps track progress and gives the user visibility into what you're doing.

**CRITICAL RULES:**
1. Use todo_write proactively when starting a multi-step task
2. Each task must have BOTH 'content' (imperative) and 'activeForm' (present continuous):
   - content: "Fix the bug" / activeForm: "Fixing the bug"
   - content: "Run tests" / activeForm: "Running tests"
3. Mark exactly ONE task as 'in_progress' at a time
4. Mark tasks as 'in_progress' BEFORE starting work on them
5. Mark tasks as 'completed' IMMEDIATELY after finishing each task
6. If you create tasks but never update their status, they will appear stuck forever in the UI

**Example workflow:**
1. Create todo list with all tasks as 'pending'
2. Mark first task as 'in_progress', then do the work
3. When done, mark it 'completed' and mark next task 'in_progress'
4. Repeat until all tasks are completed

## Behavioral Guidelines

1. **Understand the Codebase First** - When starting work on a new or unfamiliar project:
   - Use workspace_tree to see the project structure
   - Use aurora_search to understand how key features work
   - This is MANDATORY, not optional

2. **Be Direct** - Complete tasks without unnecessary explanation. If user says "create a file", just create it.

3. **Parallel Tool Calls** - Call multiple tools at once when possible. This is 10-100x faster than sequential calls.

4. **Don't Reinvent Built-in Features**:
   - Terminal already exists in the editor (don't try to "open" one with shell commands)
   - File explorer shows the workspace (don't list files unless asked)
   - Use editor_open_file to show files in tabs
   - Use workspace_tree for directory structure (don't use shell 'tree' command)

5. **Stay Focused** - Complete the requested task, then stop. Don't add unrequested features.

6. **Minimal Output** - Actions speak louder than words. Use tools, don't just describe what you would do.

7. **Read Before Edit** - Always read file contents before modifying, unless creating new files.

8. **Fix Your Mistakes** - If an edit introduces errors, fix them. But don't loop more than 3 times.

9. **Use Correct Paths** - Workspace root is the current directory for relative paths. Use full paths for editor_open_file.

## Search and Reading Strategy

When you need to understand or find code:

1. **For understanding architecture/flow**: Use aurora_search with natural language queries
   - "how does user authentication work"
   - "where is the API routing handled"
   - "find the database connection logic"

2. **For exact symbol lookup**: Use grep
   - grep(pattern="functionName", path="src/")
   - grep(pattern="import.*something", is_regex=true)

3. **For reading files**: Use multi_file_read for multiple files, file_read for single files

4. **For project structure**: Use workspace_tree

If aurora_search is unavailable (disabled or workspace not indexed), inform the user:
"Semantic search is not available. Please enable it in Settings > Semantic Search and index your workspace for better code understanding."

When making changes to code, first understand the context using search tools, then make focused edits.`;// ============================================
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
   * Set provider configuration (enterprise system)
   */
  setProvider(config: ProviderConfig): void {
    this.provider = createProvider(config);
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

  /**
   * Update agent configuration
   */
  updateConfig(config: Partial<AgentConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Get conversation history
   */
  getHistory(): Message[] {
    return [...this.conversationHistory];
  }

  /**
   * Clear conversation history
   */
  clearHistory(): void {
    this.conversationHistory = [];
  }

  /**
   * Set conversation history from external source (e.g., thread store)
   * This enables context continuity when resuming a thread
   */
  setHistory(messages: Message[]): void {
    this.conversationHistory = [...messages];
    console.log(`[AgentService] History set with ${messages.length} messages`);
  }

  /**
   * Stop the current agent run
   */
  stop(): void {
    this.isRunning = false;
    this.provider?.cancelRequest();
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
    tools?: LegacyToolDefinition[]
  ): Promise<AgentResponse> {
    this.isRunning = true;
    const provider = this.getProvider();

    // Build messages with system prompt
    const messages: Message[] = [
      { role: 'system', content: this.config.systemPrompt! },
      ...this.conversationHistory,
      { role: 'user', content: userMessage },
    ];

    // Add user message to history
    this.conversationHistory.push({ role: 'user', content: userMessage });

    // Get available tools - convert legacy format to enterprise format
    const availableTools: ToolDefinition[] = (tools || getToolsForModel()).map(t => ({
      type: 'function' as const,
      function: {
        name: t.function.name,
        description: t.function.description,
        parameters: t.function.parameters,
      },
    }));

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
            const riskRequiresApproval = toolRegistry.requiresApproval(toolName);
            const shouldAutoDeny = toolSetting === 'deny';
            const requiresUserApproval =
              !shouldAutoDeny &&
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
                // Execute the tool with the PARSED args (not the potentially malformed original)
                // Create a modified toolCall with properly stringified arguments
                const fixedToolCall = {
                  ...toolCall,
                  function: {
                    ...toolCall.function,
                    arguments: JSON.stringify(parsedArgs),
                  },
                };
                const result = await toolRegistry.executeToolCall(fixedToolCall);
                toolResult.result = result.content;
                toolResult.status = 'executed';

                callbacks.onToolExecutionComplete?.(toolCall, result.content);

                return {
                  toolResult,
                  message: {
                    role: 'tool' as const,
                    tool_call_id: toolCall.id,
                    content: result.content,
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

