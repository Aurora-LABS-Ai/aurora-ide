/**
 * Agent Service (Phase 2.3 — façade)
 * ==================================
 *
 * The legacy in-process loop (provider streaming, context engine sync,
 * summarization, JSONL bookkeeping per round) has moved to the Rust
 * `agent_chat_v2` runtime under `src-tauri/src/agent_runtime/`. This
 * module is now a THIN façade that:
 *
 *   1. Preserves the public surface that `ChatPanel` / `AgentModeLayout`
 *      already speak (`setProvider`, `setThreadId`, `updateConfig`,
 *      `chat`, `stop`).
 *   2. Composes the system prompt, IDE context, and tool catalogue on
 *      the frontend (those still belong here for now — Sub-A consumes
 *      them as opaque strings/arrays inside `AgentChatRequest`).
 *   3. Delegates the actual turn to a per-call `AgentRuntimeClient`,
 *      which subscribes to the four event channels and bridges
 *      `agent_tool_pending` back through the existing
 *      `AgentToolRunner` so user-facing tool approval keeps working
 *      exactly as before.
 *   4. Mirrors the legacy onComplete shape and persists final usage to
 *      JSONL, so the existing UI keeps working without touching a
 *      single callback.
 *
 * Deleted from the previous implementation:
 *   - `prepareAgentContext` (the runtime persists itself)
 *   - The provider iteration loop and `provider.streamChat` call
 *   - `recordAssistantResponse`
 *   - `runSummarizationIfNeeded` (Phase 4 reintroduces summarization)
 *
 * `getContextState` and `clearContext` are kept as thin pass-throughs
 * to the existing `context_*` Rust commands — they remain valid (used
 * indirectly by `useContextStore` and a handful of callers) and
 * deleting them would needlessly widen the blast radius.
 */
import { auroraInvoke } from "../lib/runtime";
import { useTaskStore } from "../store/useTaskStore";
import { useWorkspaceStore } from "../store/useWorkspaceStore";
import { getToolsForModel } from "../tools";
import type { ToolDefinition as LegacyToolDefinition } from "../tools/types";
import { threadService } from "./thread-service";
import {
  filterToolsForExecutionMode,
  formatAgentExecutionModeRuntimeContext,
  normalizeAgentExecutionMode,
} from "./agent-execution-mode";
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
import {
  AgentRuntimeClient,
  type AgentRuntimeCallbacks,
  type RuntimeToolDefinitionLike,
} from "./agent-runtime-client";
import { getMcpToolDefinitions, getMcpToolsSummary } from "./mcp-tools";
import type { ProviderConfig } from "./providers";
import type {
  AssistantMessage,
  TokenUsage,
  ToolDefinition,
} from "./providers/types";

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

const SENSIBLE_DEFAULTS: AgentConfig = {
  systemPrompt: BASE_AGENT_SYSTEM_PROMPT,
  executionMode: "agent",
  thinkingEnabled: true,
  autoApproveTools: false,
  // No artificial cap on tool iterations — the Rust runtime decides
  // when the model has stopped requesting tool calls. Honour a
  // positive `maxToolIterations` for callers that explicitly opt in,
  // but the default is "uncapped" to match the legacy IDE behaviour.
  maxToolIterations: undefined,
  temperature: 1.0,
  maxTokens: 4096,
};

export class AgentService {
  private config: AgentConfig;
  private isRunning = false;
  private currentClient: AgentRuntimeClient | null = null;

  constructor(config?: AgentConfig) {
    this.config = { ...SENSIBLE_DEFAULTS, ...config };
  }

  /**
   * Run an agent turn against the Rust `agent_chat_v2` runtime.
   *
   * `userMessage` is the clean user-typed text (persisted verbatim to
   * JSONL by the runtime). `ideContext` is the IDE/runtime enrichment
   * block built by `context-builder.ts`; the execution-mode marker is
   * prepended here so the LLM still sees authoritative mode state.
   */
  public async chat(
    userMessage: string,
    callbacks: AgentCallbacks,
    tools?: LegacyToolDefinition[],
    ideContext?: string | null,
    promptContext?: AgentPromptContext,
  ): Promise<AgentResponse> {
    this.isRunning = true;
    let taskFinalOutcome: "completed" | "cancelled" = "cancelled";

    try {
      const threadId = this.requireThreadId();
      const providerConfig = this.requireProviderConfig();
      const executionMode = normalizeAgentExecutionMode(this.config.executionMode);

      const composedPrompt = await composeAgentSystemPrompt({
        basePrompt: this.config.systemPrompt,
        executionMode,
        mcpSummary: getMcpToolsSummary(),
        promptContext: promptContext ?? { userMessage },
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

      // Execution-mode block always rides at the head of `ideContext`
      // so the LLM treats it as authoritative IDE state, not user
      // input. The legacy `prepareAgentContext` did the same thing —
      // we keep that contract because the system prompt only describes
      // *general* behaviour, not what mode this specific turn is in.
      const executionModeBlock = formatAgentExecutionModeRuntimeContext(executionMode);
      const composedIdeContext: string | null =
        ideContext && ideContext.trim().length > 0
          ? `${executionModeBlock}\n\n${ideContext}`
          : executionModeBlock;

      const availableTools = this.buildAvailableTools(tools);
      const workspacePath = useWorkspaceStore.getState().rootPath || null;

      // Wrap the caller's callbacks so the façade can synthesise a
      // legacy-shaped `onComplete` payload (the UI uses it as a
      // fallback when nothing streamed) and persist final usage to
      // the JSONL log.
      let finalContent = "";
      let finalThinking = "";
      let latestUsage: TokenUsage | undefined;
      const wrappedCallbacks: AgentRuntimeCallbacks = {
        ...callbacks,
        onToken: (token) => {
          finalContent += token;
          callbacks.onToken?.(token);
        },
        onThinking: (text) => {
          finalThinking += text;
          callbacks.onThinking?.(text);
        },
        onUsage: (usage) => {
          latestUsage = usage;
          callbacks.onUsage?.(usage);
        },
      };

      console.log("[AgentService] dispatching to AgentRuntimeClient", {
        threadId,
        provider: providerConfig.providerType,
        model: providerConfig.model,
        tools: availableTools.length,
        workspace: workspacePath ?? "(none)",
      });

      const client = new AgentRuntimeClient({
        callbacks: wrappedCallbacks,
        config: this.config,
        threadId,
        providerConfig,
        beforeToolExecution: this.config.beforeToolExecution,
      });
      this.currentClient = client;

      const result = await client.chat({
        userMessage,
        systemPrompt: composedPrompt.systemPrompt,
        ideContext: composedIdeContext,
        tools: availableTools as RuntimeToolDefinitionLike[],
        workspacePath,
      });

      // Best-effort: persist final usage to JSONL so per-turn token
      // breakdowns survive a reload. Failure here must never bubble
      // back into the user-facing response.
      if (latestUsage) {
        try {
          const ctxState = await this.getContextState();
          await threadService.updateUsage(
            threadId,
            latestUsage,
            {
              usedTokens: ctxState?.usedTokens ?? 0,
              contextWindow: ctxState?.contextWindow ?? 0,
              percentage: ctxState?.usagePercentage ?? 0,
            },
          );
        } catch (err) {
          console.warn("[AgentService] thread_update_usage failed:", err);
        }
      }

      // Legacy-shape onComplete — `ChatPanel` uses it as a backstop
      // when no streamed content arrived (e.g. some local models
      // return everything via reasoning_content).
      callbacks.onComplete?.({
        role: "assistant",
        content: finalContent,
        reasoning_content: finalThinking || undefined,
      } as AssistantMessage);

      taskFinalOutcome = "completed";

      return {
        content: finalContent,
        thinking: finalThinking || undefined,
        iterations: result.iterations,
      };
    } catch (error) {
      const isCancelled =
        error instanceof Error &&
        (error.message === "Request cancelled" ||
          error.name === "AbortError" ||
          error.message.includes("cancelled"));

      if (isCancelled) {
        // Mirror the legacy cancellation flow so the JSONL log gets a
        // proper Cancelled marker (the Rust handler already
        // synthesises tool-error replies for in-flight tools and
        // reconciles the in-memory ContextManager).
        const threadId = this.config.threadId;
        if (threadId) {
          await threadService
            .cancelCurrentTurn(threadId, "user_stop")
            .catch((err) => {
              console.warn("[AgentService] thread_cancel_current_turn failed:", err);
            });
        }
      }

      throw error;
    } finally {
      useTaskStore.getState().finalizeActiveTasks(taskFinalOutcome);
      this.isRunning = false;
      this.currentClient = null;
    }
  }

  /**
   * Pass-through to the Rust context engine for the active thread.
   * Kept on the façade so callers (e.g. `useContextStore` consumers)
   * don't have to know about the low-level command name.
   */
  public async getContextState(): Promise<ContextState | null> {
    const threadId = this.config.threadId;
    if (!threadId) return null;

    const providerConfig = this.config.providerConfig;
    const contextWindow = providerConfig?.contextWindow || 128000;
    const maxOutput = providerConfig?.maxOutputTokens || 8192;

    return auroraInvoke<ContextState>("context_get_state", {
      threadId,
      contextWindow,
      maxOutput,
    });
  }

  public async clearContext(): Promise<void> {
    const threadId = this.config.threadId;
    if (!threadId) return;

    await auroraInvoke("context_clear_thread", { threadId });
  }

  public isActive(): boolean {
    return this.isRunning;
  }

  public setThreadId(threadId: string): void {
    this.config.threadId = threadId;
  }

  /**
   * Configure the active LLM provider. The runtime client builds its
   * own per-turn snapshot from this config — we only stash it on
   * `this.config` so subsequent `chat()` calls see the latest
   * provider state.
   */
  public setProvider(config: ProviderConfig): void {
    this.config.providerConfig = config;
  }

  /**
   * Cancel any in-flight `agent_chat_v2` turn. The runtime
   * acknowledges via `agent_turn_error` with `error: "cancelled"`,
   * which the runtime client surfaces as an `AbortError` rejection
   * from the awaited chat() promise.
   */
  public stop(): void {
    this.isRunning = false;
    void this.currentClient?.cancel();
  }

  public updateConfig(config: Partial<AgentConfig>): void {
    this.config = { ...this.config, ...config };
  }

  // ─────────────────────────────────────────────────────────────────
  // Internal helpers
  // ─────────────────────────────────────────────────────────────────

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

    return filterToolsForExecutionMode(
      [...builtInTools, ...getMcpToolDefinitions()],
      normalizeAgentExecutionMode(this.config.executionMode),
    );
  }

  private requireThreadId(): string {
    const threadId = this.config.threadId;
    if (!threadId) {
      throw new Error("Thread ID required for agent runtime");
    }
    return threadId;
  }

  private requireProviderConfig(): ProviderConfig {
    const providerConfig = this.config.providerConfig;
    if (!providerConfig) {
      throw new Error(
        "Provider not configured. Call setProvider(...) before chat().",
      );
    }
    return providerConfig;
  }
}

let agentInstance: AgentService | null = null;

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

export default AgentService;
