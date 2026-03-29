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
  ToolDefinition,
} from "./providers/types";

interface ApiMessage {
  role: "system" | "user" | "assistant" | "tool";
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
    ideContext?: string | null,
    promptContext?: AgentPromptContext,
  ): Promise<AgentResponse> {
    this.isRunning = true;
    const provider = this.getProvider();
    const preparedContext = await this.prepareAgentContext(
      userMessage,
      tools,
      ideContext,
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

        if (response.tool_calls && response.tool_calls.length > 0) {
          const toolBatch = await toolRunner.executeToolCalls(response.tool_calls);
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

      const needsSummarization = await invoke<boolean>(
        "context_needs_summarization",
        { threadId },
      );
      if (needsSummarization) {
        console.log(
          "[AgentService] Context at 80%+ - summarization recommended",
        );
      }

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
    ideContext: string | null | undefined,
    promptContext: AgentPromptContext | undefined,
  ): Promise<PreparedAgentContext> {
    const threadId = this.requireThreadId();
    const { contextWindow, maxOutput } = this.getProviderLimits();

    await invoke("context_add_user_message", {
      threadId,
      content: userMessage,
      ideContext: ideContext || null,
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

    const contextMessages = await invoke<ApiMessage[]>("context_build_messages", {
      threadId,
      systemPrompt: composedPrompt.systemPrompt,
      tokenBudget: contextWindow - maxOutput,
    });

    return {
      threadId,
      messages: contextMessages.map((message) =>
        this.mapContextMessageToProviderMessage(message),
      ),
      availableTools: this.buildAvailableTools(tools),
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

    if (message.role === "assistant" && message.tool_calls) {
      return {
        role: "assistant",
        content: message.content,
        tool_calls: message.tool_calls,
      } as Message;
    }

    return {
      role: message.role as "system" | "user" | "assistant",
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

export default AgentService;
