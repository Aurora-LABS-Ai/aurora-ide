/**
 * Agent Service (Phase 2.3 — façade)
 * ==================================
 *
 * The legacy in-process loop (provider streaming, context engine sync,
 * summarization, JSONL bookkeeping per round) has moved to the Rust
 * `agent_chat_v2` runtime under `src-tauri/src/agent_runtime/`. This
 * module is now a THIN façade that:
 *
 *   1. Preserves the public surface that `ChatPanel` already speaks
 *      (`setProvider`, `setThreadId`, `updateConfig`, `chat`, `stop`).
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
import { getTeamState, getRunStatus } from "./team-client";
import { isAuroraRuntimeAvailable } from "../lib/runtime";
import type { TeamProjectState, TeamRunStatus } from "../types/team";
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

/**
 * Tools whose result the model can only act on if it accepts image
 * content blocks. We strip these from the schema we ship to the LLM
 * when the active **model's** `supportsVision === false`, both to save
 * the schema's tokens AND to prevent the model from emitting a
 * tool_use call whose response it can't read. As of schema v15 the
 * vision flag lives on the per-model row (`LLMModel.supportsVision`)
 * and reaches us via `ProviderConfigSnapshot.supportsVision`, which
 * `useSettingsStore.getLLMConfig()` derives from the resolved active
 * model.
 */
const VISION_REQUIRED_TOOLS = new Set<string>(["browser_screenshot"]);

/**
 * Build the `<active_team_context>` IDE-context block for Team mode, or `null`
 * when there's nothing to report.
 *
 * This is the **"pull" re-engage** mechanism (ground truth §17): the team runs
 * in its own background engine, so instead of pushing a turn back into the chat
 * when it finishes, we inject the live run status into the Lead's context on
 * **every** user message. The moment the user pings the Lead, the Lead already
 * knows whether the team is still working (and in which phase), finished, or
 * failed — and can report back without guessing.
 *
 * The brain is keyed by **workspace** (`projectId`), not by conversation, so a
 * brand-new conversation in Team mode is talking to whatever team exists for
 * this workspace. This block also guards against the Lead re-dispatching a
 * still-running effort.
 */
async function buildActiveTeamContext(
  repoPath: string | null,
): Promise<string | null> {
  if (!repoPath || !isAuroraRuntimeAvailable()) return null;

  let state: TeamProjectState;
  let run: TeamRunStatus | null = null;
  try {
    // A small channel tail lets us surface the recent group chat to the Lead.
    state = await getTeamState(repoPath, 14);
  } catch {
    return null;
  }
  try {
    run = await getRunStatus(repoPath);
  } catch {
    run = null;
  }

  const runState = run?.state ?? "idle";
  // Nothing has ever happened for this workspace — no context to inject.
  if (!state.initialized && runState === "idle") return null;

  const phase = state.team.phase;
  const total = state.tasks.tasks.length;
  const done = state.tasks.tasks.filter((t) => t.status === "done").length;
  const agents = state.team.agents
    .map((a) => {
      const name = a.role?.trim() || a.id;
      return `${name}${a.model ? ` (${a.model})` : ""}: ${a.status}`;
    })
    .join("; ");
  const inProgress = state.tasks.tasks
    .filter((t) => t.status === "in_progress")
    .map((t) => `${t.title}${t.owner ? ` (owner: ${t.owner})` : ""}`);
  const contracts = state.scopeMap.assignments
    .flatMap((a) => a.ownedContracts)
    .filter(Boolean);
  const recentChat = state.channel
    .slice(-8)
    .map((e) => `- ${e.author}: ${e.body.replace(/\s+/g, " ").slice(0, 160)}`);

  // The run-status line is the headline — it's what tells the Lead what to do.
  let runLine: string;
  let guidance: string;
  if (runState === "running") {
    runLine = `Run status: RUNNING — phase: ${run?.phase ?? phase}${run?.goal ? ` (goal: "${run.goal}")` : ""}`;
    guidance = `- The team is STILL WORKING in the background. Do NOT call team_dispatch again for this effort — it would fork a competing run over the same brain. Tell the user it's in progress (name the phase). Use team_status / team_chat to check details.`;
  } else if (runState === "done") {
    runLine = `Run status: DONE — the background workers finished their assigned work${run?.goal ? ` (goal: "${run.goal}")` : ""}.`;
    guidance = `- The team FINISHED. Report what they built to the user (call team_chat for the details of what each member did, and team_status for the roster/task summary). Only call team_dispatch again for a genuinely NEW effort the user asks for.`;
  } else if (runState === "failed") {
    runLine = `Run status: FAILED — ${run?.error ?? "the background run errored"}.`;
    guidance = `- The team run FAILED. Tell the user what failed (above) and offer to retry team_dispatch or handle it yourself. Do not pretend it succeeded.`;
  } else if (phase === "done") {
    runLine = `Run status: a previous team run for this workspace is complete (phase: Done).`;
    guidance = `- Call team_status / team_chat to inspect it. Only call team_dispatch to start a genuinely new effort.`;
  } else if (phase === "disbanded") {
    return null; // stopped and nothing running — nothing to coordinate
  } else {
    runLine = `Run status: a team exists for this workspace (phase: ${phase}) but no background run is active.`;
    guidance = `- Use team_status / team_chat to inspect it. Call team_dispatch to (re)start work if the user wants it.`;
  }

  return `<active_team_context authoritative="true">
The Aurora Agent Team runs peer workers in its own background engine and persists across conversations (shown in the Team screen, embedded in this window). You are the Lead; you do NOT write the team's code — the ICs do. This status is live as of THIS message.
${runLine}
- Brain phase: ${phase}
- Agents: ${agents || "(none yet)"}
- Tasks: ${done}/${total} done${inProgress.length ? `\n- In progress: ${inProgress.join("; ")}` : ""}${contracts.length ? `\n- Published contracts: ${contracts.join(", ")}` : ""}${recentChat.length ? `\n- Recent team chat:\n${recentChat.join("\n")}` : ""}
Guidance for you (the Lead) right now:
${guidance}
- The Team screen is available in this window; team_show reveals it.
</active_team_context>`;
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

/**
 * The non-message prompt overhead the runtime sends the model on EVERY
 * iteration: the fully composed system prompt (base + skills + mode + global
 * instructions + MCP summary), the authoritative IDE context block, and the
 * serialized tool schemas. The local token estimator must count these — they
 * are the bulk of the gap between our estimate and a usage-reporting provider's
 * real number (~16% on a DeepSeek run, almost entirely the tool schemas).
 */
export interface PromptOverhead {
  /** Composed system prompt + the IDE context block, joined. */
  systemText: string;
  /** Provider-format tool array, JSON-serialized exactly as sent. */
  toolSchemaJson: string;
}

export class AgentService {
  private config: AgentConfig;
  private isRunning = false;
  private currentClient: AgentRuntimeClient | null = null;
  /** Overhead composed for the most recent `chat()`; read by the estimator. */
  private lastPromptOverhead: PromptOverhead | null = null;

  constructor(config?: AgentConfig) {
    this.config = { ...SENSIBLE_DEFAULTS, ...config };
  }

  /**
   * The system + tool overhead composed for the last `chat()` call, or `null`
   * if no turn has run (or it failed before composing). The no-usage token
   * estimator counts this so its number matches what the model actually
   * received, not just the base system prompt.
   */
  public getLastPromptOverhead(): PromptOverhead | null {
    return this.lastPromptOverhead;
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
      let composedIdeContext: string | null =
        ideContext && ideContext.trim().length > 0
          ? `${executionModeBlock}\n\n${ideContext}`
          : executionModeBlock;

      const availableTools = this.buildAvailableTools(tools, providerConfig);
      // Per-turn workspace override (agent window runs concurrent turns across
      // different projects); falls back to the global store for the IDE.
      const workspacePath =
        this.config.workspacePath !== undefined
          ? this.config.workspacePath
          : useWorkspaceStore.getState().rootPath || null;

      // Team mode: the team runs in its own background engine, so we inject its
      // live run status on EVERY message (the "pull" re-engage model, §17). A
      // fresh conversation may also be talking to a team already running for
      // this workspace (the brain is keyed by workspace, not conversation).
      // This authoritative block tells the Lead where the team stands and stops
      // it re-dispatching a still-running effort.
      if (executionMode === "team") {
        const activeTeamContext = await buildActiveTeamContext(workspacePath);
        if (activeTeamContext) {
          composedIdeContext = composedIdeContext
            ? `${composedIdeContext}\n\n${activeTeamContext}`
            : activeTeamContext;
        }
      }

      // Record the exact non-message overhead sent this turn so the no-usage
      // token estimator can count it (the composed system prompt, the IDE
      // context block, and the serialized tool schemas). Without this the
      // estimate undercounts by the tool-schema size — ~16% on a DeepSeek run.
      this.lastPromptOverhead = {
        systemText: composedIdeContext
          ? `${composedPrompt.systemPrompt}\n\n${composedIdeContext}`
          : composedPrompt.systemPrompt,
        toolSchemaJson: JSON.stringify(availableTools),
      };

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
        onQueuedMessageInjected: (text) => {
          // The Rust runtime just drained the queue slot and stapled
          // this text to the tool message about to be sent to the
          // model. UI: clear the pill, then let the panel-level
          // callback (which owns the streaming message id) drop a
          // `user_injection` timeline event into the in-flight
          // assistant message. That way the injected user note
          // renders inline — after the tool result, before the
          // continuing assistant text — matching what the API sees.
          // We do NOT append a separate user bubble: that would land
          // after the still-streaming assistant message and read as
          // if the agent replied before the user spoke.
          //
          // Lazy import avoids the chat-store ↔ agent-service cycle.
          void import("../store/useChatStore").then(({ useChatStore }) => {
            useChatStore.getState().clearQueuedMessageLocal();
          });
          callbacks.onQueuedMessageInjected?.(text);
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
        attachedSelectedElements: promptContext?.attachedSelectedElements ?? null,
        attachedPromptChips: promptContext?.attachedPromptChips ?? null,
      });

      // Best-effort: persist final usage to JSONL so per-turn token
      // breakdowns survive a reload. Failure here must never bubble
      // back into the user-facing response.
      //
      // CRITICAL: the context-window accounting must NOT gate the usage
      // write. The legacy context engine (`context_get_state`) is only
      // seeded by the IDE; the agent window never seeds it, so that call
      // THROWS there. Previously the throw landed in the catch and
      // `updateUsage` never ran — so a usage-reporting thread
      // (DeepSeek/Anthropic) reopened with an EMPTY context ring (no
      // `tokenUsage` in its `.meta.json`). Compute context separately,
      // fall back to the provider window when the engine is unavailable,
      // and always persist `latestUsage`.
      if (latestUsage) {
        const context = await this.computeContextUsage(latestUsage);
        try {
          await threadService.updateUsage(threadId, latestUsage, context);
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
   * Context-window accounting for the just-finished turn, used when
   * persisting usage to the thread meta. Prefers the legacy context
   * engine's view (the IDE seeds it), but that engine is never seeded for
   * agent-window threads — `context_get_state` throws there — so we fall
   * back to deriving the numbers from the provider-reported usage and the
   * model's context window. Mirrors `ContextRing`'s own derivation
   * (`used = prompt + cacheRead`, `pct = used / window`) so the persisted
   * snapshot matches the live ring.
   */
  private async computeContextUsage(
    usage: TokenUsage,
  ): Promise<{ usedTokens: number; contextWindow: number; percentage: number }> {
    try {
      const ctxState = await this.getContextState();
      if (ctxState) {
        return {
          usedTokens: ctxState.usedTokens,
          contextWindow: ctxState.contextWindow,
          percentage: ctxState.usagePercentage,
        };
      }
    } catch {
      // Legacy engine not seeded (agent window) — derive from usage below.
    }
    const usedTokens = usage.promptTokens + (usage.cacheReadTokens ?? 0);
    const contextWindow = this.config.providerConfig?.contextWindow || 128_000;
    const percentage =
      contextWindow > 0
        ? Math.min(100, Math.round((usedTokens / contextWindow) * 100))
        : 0;
    return { usedTokens, contextWindow, percentage };
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
    providerConfig: ProviderConfig,
  ): ToolDefinition[] {
    const supportsVision = providerConfig.supportsVision ?? false;

    const builtInTools: ToolDefinition[] = (tools || getToolsForModel())
      // SINGLE SOURCE OF TRUTH: native tools (`nativeRustOwned`) are
      // registered AND advertised by the Rust runtime's own catalogue —
      // that registry is the one place their schemas live. Sending the
      // frontend's TS copy too would register a duplicate bridge entry
      // per tool, so any stale/renamed name in TS (e.g. an old
      // `search_replace`) would reappear to the model alongside the real
      // Rust set. We send ONLY the tools the frontend actually executes
      // (skills, team, question, MCP); everything native comes from Rust.
      .filter((tool) => !tool.nativeRustOwned)
      // Vision-only tools (browser_screenshot returns an image the model
      // must be able to see). Stripping them from the schema entirely
      // prevents non-vision models from emitting tool_use blocks they
      // can't act on, AND saves the schema's tokens.
      .filter((tool) => supportsVision || !VISION_REQUIRED_TOOLS.has(tool.function.name))
      .map((tool) => ({
        type: "function",
        function: {
          name: tool.function.name,
          description: tool.function.description,
          parameters: tool.function.parameters,
        },
      }));

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
