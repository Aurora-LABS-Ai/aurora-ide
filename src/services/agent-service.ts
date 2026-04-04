/**
 * Agent Service
 * Orchestrates AI interactions with tool calling and thinking
 * Uses Rust Context Engine for turn-based message management
 */
import { invoke } from "@tauri-apps/api/core";
import { getToolsForModel } from "../tools";
import type { ToolDefinition as LegacyToolDefinition } from "../tools/types";
import {
  BASE_AGENT_SYSTEM_PROMPT,
  composeAgentSystemPrompt,
  type AgentPromptContext,
} from "./agent-prompt";
import type {
  AgentCallbacks,
  AgentConfig,
  AgentResponse,
} from "./agent-service.types";
import { AgentToolRunner } from "./agent-tool-runner";
import { getMcpToolDefinitions, getMcpToolsSummary } from "./mcp-tools";
import {
  type IProvider,
  type ProviderConfig,
  createProvider,
} from "./providers";
import type {
  AssistantMessage,
  Message,
  ToolCallRequest,
  ToolDefinition,
} from "./providers/types";

interface ApiMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  reasoning_content?: string;
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

interface PreparedAgentContext {
  availableTools: ToolDefinition[];
  messages: Message[];
  threadId: string;
}

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

  public async chat(
    userMessage: string,
    callbacks: AgentCallbacks,
    tools?: LegacyToolDefinition[],
    _ideContext?: string | null,
    promptContext?: AgentPromptContext,
  ): Promise<AgentResponse> {
    this.isRunning = true;
    const provider = this.getProvider();
    const preparedContext = await this.prepareAgentContext(
      userMessage,
      tools,
      null,
      promptContext,
    );

    let iteration = 0;
    let finalContent = "";
    let finalThinking = "";
    let stoppedByIterationLimit = false;
    const executedToolCalls: NonNullable<AgentResponse["toolCalls"]> = [];
    const { availableTools, messages, threadId } = preparedContext;
    const toolRunner = new AgentToolRunner({
      callbacks,
      config: this.config,
      isRunning: () => this.isRunning,
      threadId,
    });

    try {
      while (this.isRunning && iteration < this.config.maxToolIterations!) {
        iteration++;

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
            onThinking: callbacks.onThinking,
            onToolCall: callbacks.onToolCall,
            onUsage: callbacks.onUsage,
            onError: callbacks.onError,
          },
        );

        const responseContent = this.normalizeAssistantContent(response);
        await this.recordAssistantResponse(threadId, responseContent, response);
        messages.push(response);

        if (responseContent) {
          finalContent = responseContent;
        }

        if (response.reasoning_content) {
          finalThinking = `${finalThinking}${response.reasoning_content}`;
        }

        // Check structured tool_calls first, then fallback to text extraction
        let effectiveToolCalls = response.tool_calls;
        if ((!effectiveToolCalls || effectiveToolCalls.length === 0) && responseContent) {
          const extracted = extractToolCallsFromContent(responseContent);
          if (extracted) {
            console.log(`[AgentService] Extracted ${extracted.length} tool call(s) from content text`);
            effectiveToolCalls = extracted;
            // Patch the response so the message history contains proper tool_calls
            response.tool_calls = extracted;
            // Strip the raw tool call text from content so it doesn't echo to the user
            response.content = responseContent
              .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, '')
              .replace(/```(?:json)?\s*\n?\s*\{[\s\S]*?"name"[\s\S]*?\}\s*\n?\s*```/gi, '')
              .trim();
          }
        }

        if (effectiveToolCalls && effectiveToolCalls.length > 0) {
          const toolBatch = await toolRunner.executeToolCalls(effectiveToolCalls);
          messages.push(...toolBatch.messages);
          executedToolCalls.push(...toolBatch.toolCalls);
          callbacks.onIterationComplete?.(iteration);
          continue;
        }

        break;
      }

      if (iteration >= this.config.maxToolIterations! && this.isRunning) {
        stoppedByIterationLimit = true;
      }

      await invoke("context_finalize_turn", { threadId });

      await this.runSummarizationIfNeeded(threadId);

      if (stoppedByIterationLimit && !finalContent) {
        finalContent = `Stopped after ${this.config.maxToolIterations} tool iterations.`;
      }

      callbacks.onComplete?.({
        role: "assistant",
        content: finalContent,
        reasoning_content: finalThinking || undefined,
      } as AssistantMessage);

      return {
        content: finalContent,
        thinking: finalThinking || undefined,
        toolCalls: executedToolCalls.length > 0 ? executedToolCalls : undefined,
        iterations: iteration,
      };
    } catch (error) {
      const isCancelled =
        error instanceof Error &&
        (error.message === "Request cancelled" ||
          error.name === "AbortError" ||
          error.message.includes("cancelled"));

      if (isCancelled) {
        await invoke("context_discard_current_turn", { threadId }).catch(() => {
          // Best-effort cleanup only.
        });
      }

      throw error;
    } finally {
      this.isRunning = false;
    }
  }

  public async getContextState(): Promise<ContextState | null> {
    const threadId = this.config.threadId;
    if (!threadId) return null;

    const providerConfig = this.config.providerConfig;
    const contextWindow = providerConfig?.contextWindow || 128000;
    const maxOutput = providerConfig?.maxOutputTokens || 8192;

    return invoke<ContextState>("context_get_state", {
      threadId,
      contextWindow,
      maxOutput,
    });
  }

  public async clearContext(): Promise<void> {
    const threadId = this.config.threadId;
    if (!threadId) return;

    await invoke("context_clear_thread", { threadId });
  }

  public isActive(): boolean {
    return this.isRunning;
  }

  public setThreadId(threadId: string): void {
    this.config.threadId = threadId;
  }

  public setProvider(config: ProviderConfig): void {
    this.provider = createProvider(config);
    this.config.providerConfig = config;
  }

  public stop(): void {
    this.isRunning = false;
    this.provider?.cancelRequest();
  }

  public updateConfig(config: Partial<AgentConfig>): void {
    this.config = { ...this.config, ...config };
  }

  private async prepareAgentContext(
    userMessage: string,
    tools: LegacyToolDefinition[] | undefined,
    _ideContext: string | null | undefined,
    promptContext: AgentPromptContext | undefined,
  ): Promise<PreparedAgentContext> {
    const threadId = this.requireThreadId();
    const { contextWindow, maxOutput } = this.getProviderLimits();

    await invoke("context_add_user_message", {
      threadId,
      content: userMessage,
      ideContext: null,
      contextWindow,
      maxOutput,
    });

    const composedPrompt = await composeAgentSystemPrompt({
      basePrompt: this.config.systemPrompt,
      mcpSummary: getMcpToolsSummary(),
      promptContext: promptContext ?? {
        userMessage,
      },
    });

    if (composedPrompt.explicitSkills.length > 0) {
      console.log(
        "[AgentService] Required skills:",
        composedPrompt.explicitSkills.map((skill) => skill.id),
      );
    }
    if (composedPrompt.activeSkills.length > 0) {
      console.log(
        "[AgentService] Active skills:",
        composedPrompt.activeSkills.map((skill) => skill.id),
      );
    }

    const availableTools = this.buildAvailableTools(tools);

    // Estimate tokens consumed by tool definitions (~20 tokens per tool on average)
    // Tool schemas are sent as a separate API field but still count against context window
    const estimatedToolTokens = availableTools.length * 80;
    const tokenBudget = contextWindow - maxOutput - estimatedToolTokens;

    console.log(
      `[AgentService] Token budget: ${contextWindow} context - ${maxOutput} output - ${estimatedToolTokens} tools = ${tokenBudget} available`,
    );

    const contextMessages = await invoke<ApiMessage[]>("context_build_messages", {
      threadId,
      systemPrompt: composedPrompt.systemPrompt,
      tokenBudget,
    });

    return {
      threadId,
      messages: contextMessages.map((message) =>
        this.mapContextMessageToProviderMessage(message),
      ),
      availableTools,
    };
  }

  private buildAvailableTools(
    tools: LegacyToolDefinition[] | undefined,
  ): ToolDefinition[] {
    const builtInTools: ToolDefinition[] = (tools || getToolsForModel()).map(
      (tool) => ({
        type: "function",
        function: {
          name: tool.function.name,
          description: tool.function.description,
          parameters: tool.function.parameters,
        },
      }),
    );

    return [...builtInTools, ...getMcpToolDefinitions()];
  }

  private getProvider(): IProvider {
    if (!this.provider) {
      throw new Error("Provider not initialized. Call setProvider first.");
    }

    return this.provider;
  }

  private getProviderLimits(): { contextWindow: number; maxOutput: number } {
    const providerConfig = this.config.providerConfig;

    return {
      contextWindow: providerConfig?.contextWindow || 128000,
      maxOutput: providerConfig?.maxOutputTokens || 8192,
    };
  }

  private mapContextMessageToProviderMessage(message: ApiMessage): Message {
    if (message.role === "tool") {
      return {
        role: "tool",
        tool_call_id: message.tool_call_id!,
        content: message.content,
      } as Message;
    }

    if (message.role === "assistant") {
      const mapped = {
        role: "assistant" as const,
        content: message.content,
        tool_calls: message.tool_calls,
        reasoning_content: message.reasoning_content,
      };
      return mapped as unknown as Message;
    }

    return {
      role: message.role as "system" | "user",
      content: message.content,
    };
  }

  private normalizeAssistantContent(message: AssistantMessage): string {
    if (Array.isArray(message.content)) {
      return message.content
        .map((block) => (block.type === "text" ? block.text : ""))
        .join("");
    }

    return message.content || "";
  }

  private async recordAssistantResponse(
    threadId: string,
    content: string,
    response: AssistantMessage,
  ): Promise<void> {
    await invoke("context_add_assistant_response", {
      threadId,
      content,
      thinking: response.reasoning_content || null,
    });
  }

  private requireThreadId(): string {
    const threadId = this.config.threadId;
    if (!threadId) {
      throw new Error("Thread ID required for context engine");
    }

    return threadId;
  }

  /**
   * Run summarization on oldest unsummarized turn if context usage is at 80%+.
   * Uses the same provider to generate a concise summary, then stores it in the
   * Rust context engine so future message builds use the summary instead of full content.
   */
  private async runSummarizationIfNeeded(threadId: string): Promise<void> {
    try {
      const needsSummarization = await invoke<boolean>(
        "context_needs_summarization",
        { threadId },
      );

      if (!needsSummarization) return;

      const request = await invoke<{
        turn_id: string;
        turn_content: string;
      } | null>("context_get_turn_to_summarize", { threadId });

      if (!request) return;

      const summarizationPrompt = await invoke<string>(
        "context_get_summarization_prompt",
      );

      const provider = this.getProvider();

      console.log(
        `[AgentService] Summarizing turn ${request.turn_id} (context at 80%+)`,
      );

      const response = await provider.chat({
        messages: [
          { role: "system", content: summarizationPrompt } as Message,
          { role: "user", content: request.turn_content } as Message,
        ],
        tools: [],
        stream: false,
        temperature: 0.3,
        maxTokens: 300,
        thinkingEnabled: false,
      });

      const summary = this.normalizeAssistantContent(response.message);

      if (summary) {
        await invoke("context_set_turn_summary", {
          threadId,
          turnId: request.turn_id,
          summary,
        });
        console.log(
          `[AgentService] Turn summarized: "${summary.substring(0, 80)}..."`,
        );
      }
    } catch (error) {
      console.warn("[AgentService] Summarization failed (non-fatal):", error);
    }
  }
}

export const getAgentService = (): AgentService => {
  if (!agentInstance) {
    agentInstance = new AgentService();
  }
  return agentInstance;
};

export const initAgentService = (config?: AgentConfig): AgentService => {
  agentInstance = new AgentService(config);
  return agentInstance;
};

let agentInstance: AgentService | null = null;

/**
 * Extract tool calls that local models emit as plain text instead of structured
 * `tool_calls`. Supports `<tool_call>...</tool_call>` and fenced JSON blocks
 * with a recognisable `"name"` + `"arguments"` shape.
 */
function extractToolCallsFromContent(content: string): ToolCallRequest[] | null {
  const calls: ToolCallRequest[] = [];
  let idCounter = 0;

  // Pattern 1: <tool_call>{ "name": "...", "arguments": {...} }</tool_call>
  const tagRe = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gi;
  let match: RegExpExecArray | null;
  while ((match = tagRe.exec(content)) !== null) {
    try {
      const parsed = JSON.parse(match[1]);
      if (parsed.name) {
        calls.push({
          id: `text_tc_${Date.now()}_${idCounter++}`,
          type: 'function',
          function: {
            name: parsed.name,
            arguments: typeof parsed.arguments === 'string'
              ? parsed.arguments
              : JSON.stringify(parsed.arguments ?? {}),
          },
        });
      }
    } catch { /* malformed JSON, skip */ }
  }

  // Pattern 2: ```json { "name": "...", "arguments": {...} } ``` (fenced blocks)
  if (calls.length === 0) {
    const fenceRe = /```(?:json)?\s*\n?\s*(\{[\s\S]*?\})\s*\n?\s*```/gi;
    while ((match = fenceRe.exec(content)) !== null) {
      try {
        const parsed = JSON.parse(match[1]);
        if (parsed.name && parsed.arguments !== undefined) {
          calls.push({
            id: `text_tc_${Date.now()}_${idCounter++}`,
            type: 'function',
            function: {
              name: parsed.name,
              arguments: typeof parsed.arguments === 'string'
                ? parsed.arguments
                : JSON.stringify(parsed.arguments ?? {}),
            },
          });
        }
      } catch { /* skip */ }
    }
  }

  return calls.length > 0 ? calls : null;
}

export default AgentService;
