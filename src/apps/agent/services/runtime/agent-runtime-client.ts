/**
 * Agent Runtime Client (Phase 2.3)
 * --------------------------------
 *
 * Thin TypeScript driver for the Rust `agent_chat_v2` IPC. This module
 * replaces the in-process provider loop that used to live in
 * `agent-service.ts` — instead of streaming from the LLM provider
 * directly, the frontend asks the Rust runtime to drive the turn,
 * subscribes to its event channels, and forwards each event back to
 * the existing UI callbacks.
 *
 * Tools still execute on the frontend in Phase 2.3 via the
 * `FrontendBridgeExecutor` mechanism: when the Rust runtime needs a
 * tool result, it emits `agent_tool_pending`; the client then
 * dispatches the call through the existing `AgentToolRunner` (so the
 * approval workflow, plan-mode rules, MCP integration, and audit
 * recording all stay intact) and posts the result back via
 * `agent_post_tool_result`.
 *
 * Wire shapes are locked by `docs/plan/phase-2-3-contract.md`. Every
 * field in `AgentChatRequest` is camelCase on the wire (the Rust
 * struct uses `#[serde(rename_all = "camelCase")]`); event payloads
 * are read defensively so a struct that is still snake_case on the
 * Rust side (e.g. `TurnCompletion` from Phase 2.2) doesn't break.
 */
import { auroraInvoke, auroraListen } from "@/kernel/lib/ipc/runtime";
import { parseToolArguments } from "@/kernel/lib/llm/tool-arguments";
import { toolCallForDisplay } from "@/apps/agent/services/tools/tool-invocation";
import type {
  ProviderConfig,
  ReasoningRequestConfig,
} from "@/kernel/services/providers/types";
import type { ToolCallRequest, TokenUsage } from "@/kernel/services/providers/types";
import type { AgentCallbacks, AgentConfig } from "@/apps/agent/services/runtime/agent-service.types";
import type { AgentExecutionMode } from "@/apps/agent/services/runtime/agent-execution-mode";
import type { ImageProvider } from "@/apps/agent/services/providers/image-providers";
import type {
  AttachedPromptChip,
  AttachedSelectedElement,
} from "@/apps/agent/services/threads/thread-service";
import {
  executeMcpTool,
  isMcpTool,
  shouldAutoApproveMcpTool,
} from "@/apps/agent/services/tools/mcp-tools";
import {
  executeAuroraFrontendTool,
  isAuroraFrontendTool,
  shouldAutoApproveAuroraFrontendTool,
} from "@/apps/agent/services/tools/aurora-tools";

/**
 * Loose tool-definition shape so we can accept either the
 * `tools/types` `ToolDefinition` (used by `agent-service`) or the
 * `providers/types` `ToolDefinition` (used by the legacy provider
 * loop). Both share the `function.{name, description, parameters}`
 * skeleton; only the parameter-schema typings differ.
 */
export interface RuntimeToolDefinitionLike {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: unknown;
  };
}

// ============================================================================
// Wire-format types (mirror the Rust `agent_runtime` crate exactly)
// ============================================================================

/**
 * Individual tool the model is allowed to call this turn. The Rust
 * `AllowedTool` struct is `rename_all = "camelCase"` so this maps
 * 1-to-1 onto the wire shape.
 */
export interface AllowedTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/**
 * Provider snapshot pushed as part of `AgentChatRequest`. Sub-A's
 * `ApiFactory::build` reads this to construct the right HTTP client
 * per-turn — no settings round-trip required.
 *
 * camelCase on the wire to match the Rust struct.
 */
export interface ProviderConfigSnapshot {
  /**
   * Provider ROW id — a preset slug for built-ins, a generated UUID for
   * user-added providers. Identity only. Never infer the wire shape from
   * it; that is `providerType`'s job.
   */
  providerId: string;
  /**
   * The user's explicit "API type" selection. Decides the wire shape in
   * Rust (`ProviderKind::detect`) plus prompt caching, `stream_options`
   * and reasoning-field replay.
   *
   * MUST be forwarded. Omitting it makes Rust fall back to `providerId`,
   * which for a custom provider is a UUID that matches no known type —
   * so every custom provider silently degrades to OpenAI Chat
   * Completions regardless of what the user picked.
   */
  providerType?: string;
  baseUrl: string;
  apiKey: string;
  /**
   * API-key POOL. Present only when there are 2+ non-blank keys. The Rust
   * runtime (`api::pool::PooledStreamingClient`) rotates them round-robin per
   * turn and fails over to the next on a 401/429/5xx before content streams.
   */
  apiKeys?: string[];
  model: string;
  customHeaders?: Record<string, string>;
  customParams?: Record<string, unknown>;
  defaultTemperature?: number;
  defaultMaxTokens?: number;
  supportsThinking: boolean;
  /** One semantic reasoning contract; adapters decide its wire fields. */
  reasoning?: ReasoningRequestConfig;
  /**
   * Does the active model accept image content blocks? Drives whether
   * `browser_screenshot` is registered in the tool list AND whether
   * the API adapter emits multimodal `tool_result` payloads. Default
   * false — opt in per-model via the Vision-capable checkbox in the
   * provider settings UI.
   */
  supportsVision?: boolean;
  contextWindow?: number;
  maxOutputTokens?: number;
}

/**
 * One agent turn request. Mirrors the Rust `AgentChatRequest`
 * (camelCase on the wire).
 */
export interface AgentChatRequest {
  turnId: string;
  threadId: string;
  userMessage: string;
  /**
   * Who started this turn. Omitted (or `"user"`) for every send a person makes.
   *
   * `"process"` means a background process ended while the conversation was
   * idle and Aurora woke it to say so. The message is real and the model
   * answers it, but nobody typed it — Rust persists it as a process event, so
   * the transcript draws a beat instead of a bubble in the user's voice.
   */
  userMessageOrigin?: "user" | "process";
  /** The transcript's one line when `userMessageOrigin` is `"process"`. */
  userMessageSummary?: string | null;
  providerId: string;
  model: string;
  /** See {@link AgentRuntimeChatInput.modelSelection}. */
  modelSelection: string | null;
  workspacePath: string | null;
  executionMode: AgentExecutionMode;
  /**
   * The `aurora agent` task this turn is running, when it came from one.
   *
   * Set only for a turn the Agent Window started on behalf of a terminal
   * dispatch. Rust uses it to tee this turn's events into the task's
   * transcript, so `aurora agent --follow` watches the same work the window
   * is showing.
   *
   * Passed down rather than bound from here because binding needs the turn
   * id, and the turn id is generated inside this client — reaching it from
   * the window would mean threading it back out through every callback in
   * the chain to serve one caller.
   */
  cliTaskId?: string | null;
  providerConfig: ProviderConfigSnapshot;
  systemPrompt: string | null;
  ideContext: string | null;
  tools: AllowedTool[];
  temperature: number | null;
  maxOutputTokens: number | null;
  thinkingEnabled: boolean | null;
  /**
   * Extended-thinking token budget the user picked for this model, for models
   * whose reasoning control is a budget rather than an effort tier. Read by the
   * runtime only when `thinkingEnabled` is true; `null` lets the provider
   * adapter derive a budget from the effort tier instead.
   */
  thinkingBudgetTokens: number | null;
  /**
   * Provider's advertised total context window (input + output tokens) for
   * the chosen model. When set, the Rust runtime applies a budget-aware
   * trim before each API call so older messages get dropped from the API
   * view (the persisted JSONL stays intact). `null` disables trimming —
   * the legacy "send the whole session every turn" behaviour.
   *
   * Sourced from `useSettingsStore.getLLMConfig().contextWindow` so the
   * runtime always uses the same value the chat header already shows.
   */
  contextWindow: number | null;
  /**
   * Compaction trigger as a percentage of `contextWindow` (50–95). When the
   * projected request crosses it, the runtime summarizes older history into a
   * persistent marker (`DOCS/compaction-design.md`). `null`/`0` disables it —
   * the request then relies on trim alone.
   */
  compactionThresholdPct: number | null;
  /** `max_output_tokens` budget for the summarization call (2,000–16,000). */
  compactionSummaryBudget: number | null;
  /**
   * Provider the summarization call runs on, when the user pinned one under
   * Settings → Agent → Compaction model. `null` summarizes on the
   * conversation's own model and provider — the prior behaviour.
   *
   * A full snapshot rather than a selection string because the runtime builds
   * its own client from it: the summarizer must be able to reach a provider
   * the chat is not using at all.
   */
  compactionProviderConfig: ProviderConfigSnapshot | null;
  /** How far outside the project the file tools may reach, as the wire spells
   *  it: `workspace` | `read` | `full`. `null` keeps the strict boundary. */
  workspaceAccess: string | null;
  /**
   * Advertise the `chapter` tool for this turn (Settings → Preferences →
   * Transcript). Sent from the same preference read that decides whether the
   * chapter instruction goes into the system prompt, so the model is never asked
   * to announce chapters without the tool, or given the tool with nothing telling
   * it when to call it.
   */
  transcriptChapters: boolean | null;
  /**
   * Whether the browser toolset is advertised this turn. `null` means an
   * older caller and resolves to ON in Rust — see `browser_tools` in `ipc.rs`.
   */
  browserTools: boolean | null;
  /** Legacy wire field; Rust always uses the static discovery wrappers. */
  deferTools: boolean | null;
  /**
   * Browser-inspector element chips attached to this user turn. Persisted
   * by the runtime onto the user `ConversationMessage` in the session JSONL
   * (camelCase on the wire → Rust `attached_selected_elements`). `null`/
   * omitted when the user attached nothing.
   */
  attachedSelectedElements?: AttachedSelectedElement[] | null;
  /** Exact composer pills retained for transcript replay after reopening. */
  attachedPromptChips?: AttachedPromptChip[] | null;
  /**
   * The image providers `generate_image` may use this turn (Rust
   * `image_providers`). The rows are sent as stored — the wire shape IS the
   * settings shape, field for field — and only on Aurora Chat turns; the Rust
   * driver ignores them in every other mode.
   */
  imageProviders: ImageProvider[];
}

/**
 * Streaming events emitted by the runtime on the `"agent_event"`
 * channel. Internally tagged with `"type"` (snake_case variant
 * names) — this is the read shape, not write, since events flow
 * Rust → frontend only.
 */
export type AssistantEvent =
  | { type: "thinking"; text: string; signature?: string | null }
  | { type: "text_delta"; delta: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_use_delta"; id: string; name: string; arguments: string }
  | { type: "tool_execution_start"; id: string; name: string; input: Record<string, unknown> }
  | {
      type: "tool_execution_result";
      id: string;
      name: string;
      input: Record<string, unknown>;
      content: string;
      is_error: boolean;
    }
  | {
      type: "usage";
      input_tokens: number;
      output_tokens: number;
      cache_creation_input_tokens?: number | null;
      cache_read_input_tokens?: number | null;
      /** Aurora's own tiktoken estimate, not provider-reported usage. Drives
       *  a money figure, so it must reach the UI as approximate. */
      estimated?: boolean | null;
      /** USD the provider charged for this request, when it says so. */
      cost_usd?: number | null;
    }
  | { type: "message_stop"; stop_reason: string }
  | {
      type: "queued_message_injected";
      /** Display copy — what the user typed, without the steering block. */
      text: string;
      /** Composer pill metadata (file mentions, `/` directives), if any. */
      chips?: AttachedPromptChip[] | null;
      /**
       * Who queued it. Absent on events from an older runtime, which only ever
       * carried the user's own messages — so the default is `"user"`.
       */
      origin?: "user" | "process" | null;
    }
  | { type: "compaction_started" }
  | { type: "compaction_completed"; before_tokens: number; after_tokens: number }
  | {
      type: "compaction_failed";
      before_tokens: number;
      reason: string;
      cancelled: boolean;
    }
  | { type: "error"; message: string; recoverable: boolean }
  | {
      /** The stream died mid-reply and the runtime is re-requesting it. What
       *  already streamed for THIS reply must be dropped — the retry sends it
       *  again from the first token. Scope is one model call: finished replies
       *  and tool calls above it are committed and untouched. */
      type: "partial_reply_discarded";
      /** The attempt that failed, 1-based. */
      attempt: number;
      max_attempts: number;
      /** Transport/provider error, for diagnostics — not user-facing copy. */
      reason: string;
    };

/**
 * Wrapper for one streamed event. Sub-A's struct is currently
 * snake_case (`turn_id`) but the Phase 2.3 contract upgrades it to
 * camelCase (`turnId`). We accept both at read time so the frontend
 * keeps working through Sub-A's transition.
 */
export interface AgentEventEnvelope {
  turnId?: string;
  turn_id?: string;
  seq: number;
  event: AssistantEvent;
}

export interface ToolPendingPayload {
  turnId?: string;
  turn_id?: string;
  toolUseId?: string;
  tool_use_id?: string;
  name: string;
  input: Record<string, unknown>;
}

/**
 * Recovery hint codes emitted by the Rust runtime's `classify_error`
 * (see `src-tauri/src/agent_runtime/recovery.rs`). Phase 4 additive
 * field on `agent_turn_error` — `undefined` means the runtime could
 * not classify the error and the UI should fall back to displaying
 * the raw `error` string.
 */
export type RecoveryHint =
  | "authFailed"
  | "rateLimited"
  | "networkError"
  | "invalidModel"
  | "invalidPath"
  | "permissionDenied"
  | "contextOverflow"
  | "cancelled";

export interface TurnErrorPayload {
  turnId?: string;
  turn_id?: string;
  error: string;
  /** Phase 4: optional recovery hint produced by the Rust runtime. */
  recoveryHint?: RecoveryHint;
}

export interface TurnCompletionPayload {
  turnId?: string;
  turn_id?: string;
  stop_reason?: string;
  stopReason?: string;
  iterations?: number;
  usage?: WireTokenUsage;
}

interface WireTokenUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  /** Aurora's tiktoken estimate rather than provider-reported usage. */
  estimated?: boolean | null;
  /** USD the provider charged for this request. */
  cost_usd?: number | null;
}

// ============================================================================
// Public callback / chat-input shapes
// ============================================================================

/**
 * Streaming callbacks the consumer wires up. Mirror the legacy
 * `AgentCallbacks` shape so the existing `ChatPanel` flow keeps
 * working — only the source of the events changes (Rust runtime
 * instead of in-process provider).
 *
 * `onMessageStop` and `onTurnComplete` / `onTurnError` are the new
 * Phase 2.3-specific signals; the existing UI ignores them today and
 * relies on the chat() promise resolving / rejecting.
 */
export interface AgentRuntimeCallbacks extends AgentCallbacks {
  /** Fires when the runtime closes out the assistant message. */
  onMessageStop?: (stopReason: string) => void;
  /**
   * Fires when a user-queued mid-turn message gets injected at the
   * next tool-result boundary. The Rust runtime appends the queued
   * text as a Text content block on the tool message; this callback
   * lets the UI clear the pending pill and render a regular user
   * bubble in the chat list (so the timeline reads in human order:
   * tool result → user note → assistant continuation).
   */
  onQueuedMessageInjected?: (
    text: string,
    chips?: AttachedPromptChip[] | null,
    origin?: "user" | "process",
  ) => void;
  /** Fires once on success — typically right before the chat() promise resolves. */
  onTurnComplete?: (summary: TurnCompletionPayload) => void;
  /** Fires once on error / cancellation — typically right before the chat() promise rejects. */
  onTurnError?: (payload: TurnErrorPayload) => void;
}

export interface AgentRuntimeChatInput {
  userMessage: string;
  /**
   * Who started this turn. See {@link AgentChatRequest.userMessageOrigin}.
   *
   * Nothing else about the request changes with it — same system prompt, same
   * tools, same model — because a machine-started turn must APPEND to the
   * cached prefix exactly as a person's turn does. Anything that varied here
   * would re-bill the whole conversation as a cache write.
   */
  userMessageOrigin?: "user" | "process";
  /** The transcript's one line when the origin is `"process"`. */
  userMessageSummary?: string | null;
  systemPrompt: string;
  ideContext: string | null;
  tools: RuntimeToolDefinitionLike[];
  workspacePath?: string | null;
  /**
   * The model as the conversation is pinned to it — `provider:modelKey` — when
   * that differs from the id the request carries.
   *
   * Only Cursor differs. Its effort tier and Fast lane are capabilities the
   * user chooses, so the row and the pin hold `cursor-grok-4.6` while the
   * request carries what those choices compose to. Sending the composed id as
   * the thread's model made it the pin, and the pin is the key every later
   * lookup uses — so the row holding the model's context window stopped
   * matching, and the turn was budgeted against the provider default.
   *
   * Omitted by every other provider, where the wire model is the pin.
   */
  modelSelection?: string | null;
  attachedSelectedElements?: AttachedSelectedElement[] | null;
  attachedPromptChips?: AttachedPromptChip[] | null;
  /**
   * The `aurora agent` task this turn is running, when a terminal dispatched
   * it. See the field of the same name on the request.
   */
  cliTaskId?: string | null;
}

export interface AgentRuntimeClientOptions {
  callbacks: AgentRuntimeCallbacks;
  config: AgentConfig;
  threadId: string;
  providerConfig: ProviderConfig;
  /** Used by the bridge listener to dispatch tools through the existing approval flow. */
  beforeToolExecution?: () => Promise<void>;
}

export interface AgentRuntimeChatResult {
  turnId: string;
  stopReason: string;
  iterations: number;
  usage?: TokenUsage;
}

// ============================================================================
// Channel name constants — locked by the contract
// ============================================================================

export const AGENT_EVENT_CHANNEL = "agent_event";
export const AGENT_TURN_COMPLETE_CHANNEL = "agent_turn_complete";
export const AGENT_TURN_ERROR_CHANNEL = "agent_turn_error";
export const AGENT_TOOL_PENDING_CHANNEL = "agent_tool_pending";
export const AGENT_PERMISSION_REQUEST_CHANNEL = "agent_permission_request";

export const AGENT_CHAT_COMMAND = "agent_chat_v2";
export const AGENT_COMPACT_THREAD_COMMAND = "agent_compact_thread";
export const AGENT_CANCEL_COMMAND = "agent_cancel";
export const AGENT_POST_TOOL_RESULT_COMMAND = "agent_post_tool_result";
export const AGENT_GRANT_PERMISSION_COMMAND = "agent_grant_permission";

/**
 * Phase 4 permission-prompt payload — emitted by the Rust runtime
 * when a tool whose `requires_permission()` returns `true`
 * (currently `shell_execute` and `shell_spawn`) is dispatched. The
 * frontend either approves via `agent_grant_permission(turnId,
 * toolName, granted=true)` or denies with `granted=false`.
 *
 * Defensive both-key reads: the Rust struct uses
 * `#[serde(rename_all = "camelCase")]`, but we still accept the
 * snake_case spellings so a future Rust refactor can't break the
 * frontend silently.
 */
export interface PermissionRequestPayload {
  turnId?: string;
  turn_id?: string;
  /**
   * Provider-issued id for the specific tool invocation
   * (`toolu_…` for Anthropic, `call_…` for OpenAI). Must match the
   * id of the streaming tool card already rendered in the chat
   * timeline — otherwise the inline approval card silently fails to
   * attach. This is the **same** id the model emitted in its
   * `tool_use` / tool_call delta stream.
   */
  toolUseId?: string;
  tool_use_id?: string;
  toolName?: string;
  tool_name?: string;
  input: Record<string, unknown>;
}

// ============================================================================
// AgentRuntimeClient
// ============================================================================

/**
 * Drives one `agent_chat_v2` invocation end-to-end.
 *
 * Per-turn lifecycle:
 *   1. Subscribe to all four event channels (filtered by `turnId`).
 *   2. Invoke `agent_chat_v2` with the camelCase `AgentChatRequest`.
 *   3. Forward each `AssistantEvent` to the matching callback.
 *   4. When the runtime emits `agent_tool_pending`, dispatch through
 *      the existing `AgentToolRunner` and post the result back via
 *      `agent_post_tool_result`.
 *   5. Resolve the chat() promise on `agent_turn_complete`,
 *      reject on `agent_turn_error`, and unsubscribe everything.
 *
 * `cancel()` calls `agent_cancel(turnId)`. The runtime then emits
 * `agent_turn_error` with `error: "cancelled"`, which still drives
 * the cleanup path above.
 */
export class AgentRuntimeClient {
  private currentTurnId: string | null = null;
  private cleanups: Array<() => void> = [];
  private readonly options: AgentRuntimeClientOptions;

  constructor(options: AgentRuntimeClientOptions) {
    this.options = options;
  }

  /** Stable channel-name accessors — useful for tests that mock listeners. */
  public static readonly channels = {
    event: AGENT_EVENT_CHANNEL,
    turnComplete: AGENT_TURN_COMPLETE_CHANNEL,
    turnError: AGENT_TURN_ERROR_CHANNEL,
    toolPending: AGENT_TOOL_PENDING_CHANNEL,
  };

  /**
   * Build the wire-format `providerConfig` block from a frontend
   * `ProviderConfig`. Stays static so callers can construct the
   * snapshot without instantiating a client (e.g. from tests, or
   * from the `agent-service` façade).
   */
  public static buildProviderConfigSnapshot(
    config: ProviderConfig,
  ): ProviderConfigSnapshot {
    return {
      providerId: config.id,
      providerType: config.providerType,
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      // Only forward a real pool (>1 non-blank key). A single/empty pool is
      // omitted so Rust takes the plain single-key path.
      apiKeys:
        config.apiKeys && config.apiKeys.filter((k) => k.trim().length > 0).length > 1
          ? config.apiKeys.filter((k) => k.trim().length > 0)
          : undefined,
      model: config.model,
      customHeaders: config.customHeaders,
      customParams: config.customParams,
      defaultTemperature: config.defaultTemperature,
      defaultMaxTokens: config.defaultMaxTokens,
      supportsThinking: config.supportsThinking ?? false,
      reasoning: config.reasoning,
      supportsVision: config.supportsVision ?? false,
      contextWindow: config.contextWindow,
      maxOutputTokens: config.maxOutputTokens,
    };
  }

  /**
   * Map the legacy frontend `ToolDefinition` shape to the runtime's
   * `AllowedTool`. The Rust runtime only needs name / description /
   * parameters — the OpenAI-style `{ type: "function", function: ... }`
   * envelope is unwrapped here.
   */
  public static buildAllowedTools(
    tools: RuntimeToolDefinitionLike[],
  ): AllowedTool[] {
    return tools.map((tool) => ({
      name: tool.function.name,
      description: tool.function.description,
      parameters: (tool.function.parameters ?? {}) as Record<string, unknown>,
    }));
  }

  /**
   * Build the on-the-wire `AgentChatRequest` from the chat input plus
   * the configured provider/thread state. Static so tests can verify
   * the request shape without subscribing to event channels.
   */
  public static buildRequest(args: {
    turnId: string;
    threadId: string;
    input: AgentRuntimeChatInput;
    providerConfig: ProviderConfig;
    config: AgentConfig;
  }): AgentChatRequest {
    const { turnId, threadId, input, providerConfig, config } = args;
    return {
      turnId,
      threadId,
      userMessage: input.userMessage,
      userMessageOrigin: input.userMessageOrigin ?? "user",
      userMessageSummary: input.userMessageSummary ?? null,
      providerId: providerConfig.id,
      model: providerConfig.model,
      modelSelection: input.modelSelection ?? null,
      workspacePath: input.workspacePath ?? null,
      executionMode: config.executionMode ?? "agent",
      cliTaskId: input.cliTaskId ?? null,
      providerConfig: AgentRuntimeClient.buildProviderConfigSnapshot(providerConfig),
      systemPrompt: input.systemPrompt && input.systemPrompt.length > 0
        ? input.systemPrompt
        : null,
      ideContext: input.ideContext && input.ideContext.length > 0
        ? input.ideContext
        : null,
      tools: AgentRuntimeClient.buildAllowedTools(input.tools),
      temperature: typeof config.temperature === "number" ? config.temperature : null,
      maxOutputTokens: typeof config.maxTokens === "number" ? config.maxTokens : null,
      // Legacy top-level mirrors for an older Rust hot-reload target. When the
      // canonical contract exists, derive both values from it so they cannot
      // disagree with the provider snapshot the current runtime reads.
      thinkingEnabled:
        typeof config.reasoning?.enabled === "boolean"
          ? config.reasoning.enabled
          : typeof config.thinkingEnabled === "boolean"
            ? config.thinkingEnabled
            : null,
      thinkingBudgetTokens:
        typeof config.reasoning?.budgetTokens === "number" &&
        config.reasoning.budgetTokens > 0
          ? Math.round(config.reasoning.budgetTokens)
          : typeof config.thinkingBudgetTokens === "number" &&
              config.thinkingBudgetTokens > 0
            ? Math.round(config.thinkingBudgetTokens)
            : null,
      // Pass the active provider's advertised window so the Rust runtime
      // can budget-trim older messages before each API call. Falls back
      // to null when the provider config doesn't carry a window value
      // (the runtime treats null as "no enforcement" — legacy behaviour).
      contextWindow: typeof providerConfig.contextWindow === "number"
        ? providerConfig.contextWindow
        : null,
      // Compaction knobs (user-configurable, Settings → Agent). `null` lets the
      // runtime fall back to trim-only / its default budget.
      compactionThresholdPct:
        typeof config.compactionThresholdPct === "number"
          ? config.compactionThresholdPct
          : null,
      compactionSummaryBudget:
        typeof config.compactionSummaryBudget === "number"
          ? config.compactionSummaryBudget
          : null,
      // Snapshotted the same way as the chat provider so the runtime can build
      // a client for it. Absent → the summarizer rides the chat provider.
      compactionProviderConfig: config.compactionProvider
        ? AgentRuntimeClient.buildProviderConfigSnapshot(config.compactionProvider)
        : null,
      workspaceAccess:
        config.workspaceAccess === "workspace" ||
        config.workspaceAccess === "read" ||
        config.workspaceAccess === "full"
          ? config.workspaceAccess
          : null,
      transcriptChapters:
        typeof config.transcriptChapters === "boolean"
          ? config.transcriptChapters
          : null,
      browserTools:
        typeof config.browserTools === "boolean" ? config.browserTools : null,
      deferTools:
        typeof config.deferTools === "boolean" ? config.deferTools : null,
      attachedSelectedElements:
        input.attachedSelectedElements && input.attachedSelectedElements.length > 0
          ? input.attachedSelectedElements
          : null,
      attachedPromptChips:
        input.attachedPromptChips && input.attachedPromptChips.length > 0
          ? input.attachedPromptChips
          : null,
      // Only a chat turn carries them: the tool is not in the project modes'
      // roster, and there is no reason to put API keys on a request that
      // cannot use them.
      imageProviders:
        config.executionMode === "chat" && Array.isArray(config.imageProviders)
          ? config.imageProviders
          : [],
    };
  }

  /**
   * Drive one turn end-to-end. The returned promise resolves when the
   * runtime emits `agent_turn_complete` and rejects when it emits
   * `agent_turn_error` (cancellations rejected with the literal
   * `"cancelled"` error). The Tauri-level `Result<(), String>` from
   * `agent_chat_v2` carries the same condition — we await it but
   * treat the events as authoritative.
   */
  public async compactThread(input: Omit<AgentRuntimeChatInput, "userMessage">): Promise<{ beforeTokens: number; afterTokens: number } | null> {
    if (this.currentTurnId) {
      throw new Error("AgentRuntimeClient is already running a turn");
    }

    const turnId = generateTurnId();
    this.currentTurnId = turnId;
    const { callbacks, providerConfig, threadId, config } = this.options;
    const request = AgentRuntimeClient.buildRequest({
      turnId,
      threadId,
      input: { ...input, userMessage: "" },
      providerConfig,
      config,
    });

    callbacks.onStart?.();
    let unsubscribe: (() => void) | null = null;
    try {
      unsubscribe = await auroraListen<AgentEventEnvelope>(
        AGENT_EVENT_CHANNEL,
        ({ payload }) => {
          if (extractTurnId(payload) !== turnId) return;
          this.dispatchAssistantEvent(payload.event);
        },
      );
      const result = await auroraInvoke<null | [number, number] | { beforeTokens?: number; afterTokens?: number }>(
        AGENT_COMPACT_THREAD_COMMAND,
        { request },
      );
      if (Array.isArray(result)) {
        return { beforeTokens: Number(result[0] ?? 0), afterTokens: Number(result[1] ?? 0) };
      }
      if (result && typeof result === "object") {
        return {
          beforeTokens: Number(result.beforeTokens ?? 0),
          afterTokens: Number(result.afterTokens ?? 0),
        };
      }
      return null;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      callbacks.onTurnError?.({
        turnId,
        error: err.message,
      });
      callbacks.onError?.(err);
      throw err;
    } finally {
      unsubscribe?.();
      this.currentTurnId = null;
    }
  }

  public async chat(input: AgentRuntimeChatInput): Promise<AgentRuntimeChatResult> {
    if (this.currentTurnId) {
      throw new Error("AgentRuntimeClient is already running a turn");
    }

    const turnId = generateTurnId();
    this.currentTurnId = turnId;
    const { callbacks, providerConfig, threadId, config } = this.options;

    const request = AgentRuntimeClient.buildRequest({
      turnId,
      threadId,
      input,
      providerConfig,
      config,
    });

    callbacks.onStart?.();

    let resolveTurn!: (result: AgentRuntimeChatResult) => void;
    let rejectTurn!: (err: Error) => void;
    const turnPromise = new Promise<AgentRuntimeChatResult>((resolve, reject) => {
      resolveTurn = resolve;
      rejectTurn = reject;
    });

    let settled = false;
    const settleResolve = (result: AgentRuntimeChatResult) => {
      if (settled) return;
      settled = true;
      resolveTurn(result);
    };
    const settleReject = (err: Error) => {
      if (settled) return;
      settled = true;
      callbacks.onError?.(err);
      rejectTurn(err);
    };

    try {
      // ── Subscribe to all four channels FIRST so we don't miss the
      //    head of the stream while `agent_chat_v2` is still booting. ──
      const unEvent = await auroraListen<AgentEventEnvelope>(
      AGENT_EVENT_CHANNEL,
      ({ payload }) => {
        if (extractTurnId(payload) !== turnId) return;
        try {
          this.dispatchAssistantEvent(payload.event);
        } catch (err) {
          console.warn("[agent-runtime-client] event dispatch threw:", err);
        }
      },
    );
      this.cleanups.push(unEvent);

      const unToolPending = await auroraListen<ToolPendingPayload>(
      AGENT_TOOL_PENDING_CHANNEL,
      ({ payload }) => {
        if (extractTurnId(payload) !== turnId) return;
        // Fire-and-forget — bridge dispatch is async; failures inside
        // it are reported back to Rust via agent_post_tool_result with
        // is_error=true.
        void this.dispatchToolPending(turnId, payload);
      },
    );
      this.cleanups.push(unToolPending);

      const unTurnComplete = await auroraListen<TurnCompletionPayload>(
      AGENT_TURN_COMPLETE_CHANNEL,
      ({ payload }) => {
        if (extractTurnId(payload) !== turnId) return;
        callbacks.onTurnComplete?.(payload);
        settleResolve({
          turnId,
          stopReason: payload.stopReason ?? payload.stop_reason ?? "end_turn",
          iterations: payload.iterations ?? 0,
          usage: payload.usage ? mapWireUsage(payload.usage) : undefined,
        });
      },
    );
      this.cleanups.push(unTurnComplete);

      const unTurnError = await auroraListen<TurnErrorPayload>(
      AGENT_TURN_ERROR_CHANNEL,
      ({ payload }) => {
        if (extractTurnId(payload) !== turnId) return;
        callbacks.onTurnError?.(payload);
        const isCancelled = payload.error === "cancelled";
        const err = isCancelled
          ? Object.assign(new Error("Request cancelled"), { name: "AbortError" })
          : new Error(payload.error || "agent_turn_error");
        settleReject(err);
      },
    );
      this.cleanups.push(unTurnError);

    // Phase 4 — permission gate: subscribe to the prompter event
    // channel, render the existing approval UI via the consumer's
    // `onToolApprovalRequired` callback (same modal as bridge tools),
    // and post the verdict back through `agent_grant_permission`.
      const unPermissionRequest = await auroraListen<PermissionRequestPayload>(
      AGENT_PERMISSION_REQUEST_CHANNEL,
      ({ payload }) => {
        const eventTurnId = extractTurnId(payload);
        console.log(
          "[agent-runtime-client] agent_permission_request received",
          {
            eventTurnId,
            expectedTurnId: turnId,
            toolName: payload.toolName ?? payload.tool_name,
            toolUseId: payload.toolUseId ?? payload.tool_use_id,
            match: eventTurnId === turnId,
          },
        );
        if (eventTurnId !== turnId) return;
        void this.dispatchPermissionRequest(turnId, payload);
      },
    );
      this.cleanups.push(unPermissionRequest);

    // Kick off the turn. The `Result<(), String>` from `agent_chat_v2`
    // is authoritative ONLY if the events never fire (e.g. immediate
    // factory error before the registry registers the turn). When
    // events DO fire, they win — because they may resolve/reject the
    // promise before the IPC call returns.
      const invokePromise = auroraInvoke<void>(AGENT_CHAT_COMMAND, { request })
      .then(() => undefined)
      .catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        console.error("[AgentRuntimeClient] agent_chat_v2 rejected:", message);
        const wrapped = new Error(message);
        settleReject(wrapped);
      });

      const result = await turnPromise;
      // Drain the IPC promise so we don't leave it dangling — the
      // events have already settled `turnPromise` so the IPC's own
      // resolution is a no-op at this point.
      await invokePromise;
      return result;
    } catch (error) {
      // Listener registration can fail before the command starts. Surface that
      // through the normal UI error callback and still release any listeners
      // that were registered earlier in the sequence.
      if (!settled) {
        const err = error instanceof Error ? error : new Error(String(error));
        callbacks.onError?.(err);
      }
      throw error;
    } finally {
      this.runCleanups();
      this.currentTurnId = null;
    }
  }

  /**
   * Cancel an in-flight turn. The runtime acknowledges via an
   * `agent_turn_error` event with `error: "cancelled"`, which our
   * own listener turns into the chat() promise rejection.
   */
  public async cancel(): Promise<void> {
    const turnId = this.currentTurnId;
    if (!turnId) return;
    try {
      await auroraInvoke<boolean>(AGENT_CANCEL_COMMAND, { turnId });
    } catch (err) {
      console.warn("[agent-runtime-client] agent_cancel failed:", err);
    }
  }

  public isRunning(): boolean {
    return this.currentTurnId !== null;
  }

  /**
   * Translate one `AssistantEvent` into the existing UI callbacks.
   *
   * The legacy callbacks expect `ToolCallRequest` objects (with
   * `function.arguments` as a JSON string). The Rust runtime
   * delivers `tool_use { id, name, input }` where `input` is already
   * a parsed object — we re-encode it as a JSON string at the
   * boundary so `ChatPanel` and friends keep working unchanged.
   */
  private dispatchAssistantEvent(event: AssistantEvent): void {
    const { callbacks } = this.options;
    switch (event.type) {
      case "text_delta":
        callbacks.onToken?.(event.delta);
        break;
      case "thinking":
        callbacks.onThinking?.(event.text);
        break;
      case "tool_use": {
        callbacks.onToolCall?.(toToolCallRequest(event));
        break;
      }
      case "tool_use_delta": {
        // Streaming preview of a tool call. We synthesise a
        // ToolCallRequest whose `function.arguments` carries the
        // full accumulated raw JSON the model has typed so far —
        // the chat surfaces already handle re-firing
        // `onToolCall` with growing rawArgs (existing-event update
        // path), and `liveFilePreviewService.updateFromToolCall`
        // partial-parses the buffer to extract `path` / `content`
        // for the in-editor live write.
        callbacks.onToolCall?.(toolCallForDisplay({
          id: event.id,
          type: "function",
          function: {
            name: event.name,
            arguments: event.arguments,
          },
        }));
        break;
      }
      case "tool_execution_start": {
        const toolCall = toToolCallRequest(event);
        // Native Rust tools may begin execution before every provider
        // adapter has emitted a separate tool_use stream event. Calling
        // onToolCall here is idempotent in the UI and guarantees a card
        // exists before the status flips to executing.
        callbacks.onToolCall?.(toolCall);
        callbacks.onToolExecutionStart?.(toolCall);
        break;
      }
      case "tool_execution_result": {
        const toolCall = toToolCallRequest(event);
        if (event.is_error) {
          callbacks.onToolExecutionError?.(toolCall, event.content);
        } else {
          callbacks.onToolExecutionComplete?.(toolCall, event.content);
        }
        break;
      }
      case "usage":
        callbacks.onUsage?.(mapAssistantUsage(event));
        break;
      case "message_stop":
        callbacks.onMessageStop?.(event.stop_reason);
        break;
      case "queued_message_injected":
        callbacks.onQueuedMessageInjected?.(
          event.text,
          event.chips ?? null,
          event.origin ?? "user",
        );
        break;
      case "compaction_started":
        callbacks.onCompactionStarted?.();
        break;
      case "compaction_completed":
        callbacks.onCompactionCompleted?.(event.before_tokens, event.after_tokens);
        break;
      case "compaction_failed":
        callbacks.onCompactionFailed?.({
          beforeTokens: event.before_tokens,
          reason: event.reason,
          cancelled: event.cancelled,
        });
        break;
      case "partial_reply_discarded":
        callbacks.onPartialReplyDiscarded?.({
          attempt: event.attempt,
          maxAttempts: event.max_attempts,
          reason: event.reason,
        });
        break;
      case "error":
        // Never swallow this. A recoverable notice (output cap hit, provider
        // hiccup the runtime absorbed) becomes an inline marker; anything
        // non-recoverable also goes down the normal error path so the turn
        // can't end without an explanation.
        callbacks.onRuntimeNotice?.({
          message: event.message,
          recoverable: event.recoverable,
        });
        if (!event.recoverable) {
          callbacks.onError?.(new Error(event.message));
        }
        break;
      default: {
        // Defensive: log unknown event types so a future Sub-A
        // addition surfaces in dev rather than silently disappearing.
        const exhaustive: never = event;
        void exhaustive;
        console.warn("[agent-runtime-client] unknown AssistantEvent", event);
      }
    }
  }

  /**
   * Bridge listener: when Rust asks the frontend to execute a tool,
   * we route it to one of two frontend executors:
   *
   *   - MCP tools (`mcp_*`)        → `executeMcpTool` (mcp-tools.ts)
   *   - Aurora frontend tools      → `executeAuroraFrontendTool`
   *     (aurora-tools.ts; currently `aurora_skill_search` and
   *     `aurora_skill_load`, both read-only)
   *
   * Every other tool is owned by the Rust ToolRegistry and should
   * never reach this listener. If one does fall through (registry
   * mis-spelling, missing registration, or a tool definition that
   * advertises a name no executor knows about), we synthesise a
   * hard error so the model sees a deterministic failure instead
   * of a silent stall. The error envelope is the same shape used
   * by every other tool failure: `{ error, tool }` JSON with
   * `isError=true` on the `agent_post_tool_result` call.
   *
   * Approval flow:
   *   1. `shouldAutoApprove*Tool(name)` → auto-approve, skip the
   *      modal. For MCP this is sourced from per-server config; for
   *      Aurora frontend tools it's intrinsic (they're all
   *      read-only by construction).
   *   2. Otherwise, route through `onToolApprovalRequired` (same UI
   *      modal native Rust tools use via the
   *      `agent_permission_request` channel). Denying here surfaces
   *      to the model as `"Tool execution rejected by user"`.
   *
   * Best-effort: any throw is converted into an `is_error: true`
   * reply so the Rust runtime can advance instead of deadlocking on
   * the awaited oneshot.
   */
  private async dispatchToolPending(
    turnId: string,
    payload: ToolPendingPayload,
  ): Promise<void> {
    const toolUseId = payload.toolUseId ?? payload.tool_use_id;
    if (!toolUseId) {
      console.warn("[agent-runtime-client] tool_pending without toolUseId:", payload);
      return;
    }

    const toolName = payload.name;
    const isMcp = isMcpTool(toolName);
    const isAuroraFrontend = !isMcp && isAuroraFrontendTool(toolName);

    let content = "";
    let isError = false;

    if (!isMcp && !isAuroraFrontend) {
      // Tool fell through to the frontend bridge but no frontend
      // executor recognises it. This is a registration gap: the
      // Rust ToolRegistry doesn't have it either, or its definition
      // would never have reached this listener. Surface it as a
      // hard tool error so the model sees a deterministic failure
      // and can recover.
      console.error(
        `[agent-runtime-client] tool '${toolName}' reached the bridge with no frontend or Rust executor — registry gap?`,
      );
      content = JSON.stringify({
        error: `Tool '${toolName}' is not registered. The Rust runtime has no executor for it, and the frontend bridge only handles MCP tools ('mcp_*') and registered Aurora frontend tools.`,
        tool: toolName,
      });
      isError = true;
      await this.postToolResult(turnId, toolUseId, content, isError);
      return;
    }

    try {
      // `parseToolArguments` returns `parsed | repaired | invalid`. Both
      // `parsed` and `repaired` mean we have a usable object; `invalid`
      // falls back to the raw object the bridge handed us (which is the
      // already-parsed `input`, so it's safe to forward).
      const parsed = parseToolArguments(safeStringify(payload.input));
      const args =
        parsed.status === "parsed" || parsed.status === "repaired"
          ? parsed.args
          : (payload.input as Record<string, unknown>);

      // Approval gate. MCP tools use the per-server config; Aurora
      // frontend tools auto-approve because they're all read-only
      // by construction (see `aurora-tools.ts` for the full list).
      const autoApproved = isAuroraFrontend
        ? shouldAutoApproveAuroraFrontendTool(toolName)
        : shouldAutoApproveMcpTool(toolName);
      if (!autoApproved) {
        const callback = this.options.callbacks.onToolApprovalRequired;
        if (callback) {
          const synthetic: ToolCallRequest = {
            id: toolUseId,
            type: "function",
            function: {
              name: toolName,
              arguments: safeStringify(payload.input),
            },
          };
          const approved = await callback(synthetic);
          if (!approved) {
            content = JSON.stringify({
              error: "Tool execution rejected by user",
              tool: toolName,
            });
            isError = true;
            this.options.callbacks.onToolRejected?.(synthetic, "user denied");
            await this.postToolResult(turnId, toolUseId, content, isError);
            return;
          }
        }
      }

      // Run any pre-tool hook the consumer wired (e.g. snapshot the
      // active editor). Best-effort — failures here mustn't block.
      try {
        await this.options.beforeToolExecution?.();
      } catch (err) {
        console.warn(
          "[agent-runtime-client] beforeToolExecution hook threw:",
          err,
        );
      }

      this.options.callbacks.onToolExecutionStart?.({
        id: toolUseId,
        type: "function",
        function: {
          name: toolName,
          arguments: safeStringify(payload.input),
        },
      });

      content = isAuroraFrontend
        ? await executeAuroraFrontendTool(toolName, args, {
            // Pin team/frontend tools to THIS turn's workspace + thread, not
            // whatever project/chat is globally open. A background turn can
            // drive the team while another chat is on screen; without this the
            // global stores would point team_dispatch at the wrong project.
            workspacePath: this.options.config.workspacePath ?? null,
            threadId: this.options.threadId,
          })
        : await executeMcpTool(toolName, args);
      this.options.callbacks.onToolExecutionComplete?.(
        {
          id: toolUseId,
          type: "function",
          function: {
            name: toolName,
            arguments: safeStringify(payload.input),
          },
        },
        content,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      content = JSON.stringify({ error: message, tool: toolName });
      isError = true;
      // Defensive: a throw inside the UI's error callback (React render
      // crash, store mutation throwing, etc.) would unwind us before
      // `postToolResult` runs and leave the Rust bridge oneshot parked
      // forever. Wrap it so the bridge always closes the loop.
      try {
        this.options.callbacks.onToolExecutionError?.(
          {
            id: toolUseId,
            type: "function",
            function: {
              name: toolName,
              arguments: safeStringify(payload.input),
            },
          },
          message,
        );
      } catch (callbackErr) {
        console.warn(
          "[agent-runtime-client] onToolExecutionError callback threw:",
          callbackErr,
        );
      }
    }

    await this.postToolResult(turnId, toolUseId, content, isError);
  }

  /** Helper — post the bridge result back to the Rust runtime. */
  private async postToolResult(
    turnId: string,
    toolUseId: string,
    content: string,
    isError: boolean,
  ): Promise<void> {
    try {
      await auroraInvoke<void>(AGENT_POST_TOOL_RESULT_COMMAND, {
        turnId,
        toolUseId,
        content,
        isError,
      });
    } catch (err) {
      console.warn(
        "[agent-runtime-client] agent_post_tool_result failed for",
        toolUseId,
        err,
      );
    }
  }

  /**
   * Phase 4 permission gate dispatcher: turns the Rust
   * `agent_permission_request` payload into a `ToolCallRequest`,
   * routes it through the consumer's existing
   * `onToolApprovalRequired` callback (the same modal that bridge
   * tools use), and posts the verdict back via
   * `agent_grant_permission` so the Rust runtime can resume.
   *
   * Best-effort: if the consumer doesn't supply
   * `onToolApprovalRequired`, we deny by default (safer than auto-
   * approving a shell command). Any throw inside the callback is
   * also treated as deny.
   */
  private async dispatchPermissionRequest(
    turnId: string,
    payload: PermissionRequestPayload,
  ): Promise<void> {
    const toolName = payload.toolName ?? payload.tool_name;
    if (!toolName) {
      console.warn(
        "[agent-runtime-client] permission_request without toolName:",
        payload,
      );
      return;
    }

    // Use the *real* provider-issued tool_use_id so the inline
    // approval card in the chat timeline (which is keyed on the same
    // id as the streaming tool card) actually attaches and renders.
    // Falling back to a synthetic id silently breaks the modal — the
    // bug we're fixing here. If Rust didn't include it for some
    // reason, fall back to a synthetic so we at least drive the
    // approval flow even without a visible card.
    const toolUseId =
      payload.toolUseId ??
      payload.tool_use_id ??
      `perm:${toolName}:${turnId}`;

    const { callbacks } = this.options;
    console.log(
      "[agent-runtime-client] dispatching permission for",
      toolName,
      "tool_use_id=",
      toolUseId,
      "→ onToolApprovalRequired present:",
      !!callbacks.onToolApprovalRequired,
    );

    let granted = false;
    try {
      if (callbacks.onToolApprovalRequired) {
        // Synthesise a ToolCallRequest so the existing approval UI
        // can render unchanged. `id` MUST match the streaming tool
        // card's id — `ToolTimeline` only renders the inline approval
        // card when `pendingApproval.id === tool.id`. Use the
        // provider-issued id passed from Rust.
        const synthetic: ToolCallRequest = {
          id: toolUseId,
          type: "function",
          function: {
            name: toolName,
            arguments: safeStringify(payload.input),
          },
        };
        granted = await callbacks.onToolApprovalRequired(synthetic);
      } else {
        // No approval callback wired — deny by default. The Rust
        // tool will surface `ToolError::PermissionDenied` and the
        // model will see "user denied {tool}".
        granted = false;
      }
    } catch (err) {
      console.warn(
        "[agent-runtime-client] permission approval callback threw — denying:",
        err,
      );
      granted = false;
    }

    try {
      await auroraInvoke<void>(AGENT_GRANT_PERMISSION_COMMAND, {
        turnId,
        toolName,
        granted,
      });
    } catch (err) {
      // Most likely cause: the Rust executor was cancelled before
      // the user clicked. Log and move on — the runtime will resolve
      // the turn through the cancel path.
      console.warn(
        "[agent-runtime-client] agent_grant_permission failed for",
        toolName,
        err,
      );
    }
  }

  private runCleanups(): void {
    while (this.cleanups.length > 0) {
      const fn = this.cleanups.pop();
      try {
        fn?.();
      } catch (err) {
        console.warn("[agent-runtime-client] cleanup threw:", err);
      }
    }
  }
}

// ============================================================================
// Helpers
// ============================================================================

const extractTurnId = (
  payload: { turnId?: string; turn_id?: string } | undefined,
): string | undefined => payload?.turnId ?? payload?.turn_id;

const toToolCallRequest = (event: {
  id: string;
  name: string;
  input: Record<string, unknown>;
}): ToolCallRequest => toolCallForDisplay({
  id: event.id,
  type: "function",
  function: {
    name: event.name,
    arguments: safeStringify(event.input),
  },
});

/**
 * Safe JSON.stringify that never throws (e.g. on circular refs) — falls
 * back to an empty object so the model still gets *something* parseable.
 */
const safeStringify = (value: unknown): string => {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return "{}";
  }
};

const mapAssistantUsage = (event: Extract<AssistantEvent, { type: "usage" }>): TokenUsage => ({
  promptTokens: event.input_tokens ?? 0,
  completionTokens: event.output_tokens ?? 0,
  totalTokens: (event.input_tokens ?? 0) + (event.output_tokens ?? 0),
  cacheReadTokens: event.cache_read_input_tokens ?? undefined,
  cacheWriteTokens: event.cache_creation_input_tokens ?? undefined,
  // Carried through, never defaulted to false: a cost built from estimated
  // counts must be labelled approximate everywhere it is shown.
  estimated: event.estimated === true ? true : undefined,
  // `0` is a meaningful claim ("free"), so only `null`/absent falls back.
  costUsd: typeof event.cost_usd === "number" ? event.cost_usd : undefined,
});

const mapWireUsage = (usage: WireTokenUsage): TokenUsage => ({
  promptTokens: usage.input_tokens ?? 0,
  completionTokens: usage.output_tokens ?? 0,
  totalTokens: (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0),
  cacheReadTokens: usage.cache_read_input_tokens ?? undefined,
  cacheWriteTokens: usage.cache_creation_input_tokens ?? undefined,
  estimated: usage.estimated === true ? true : undefined,
  costUsd: typeof usage.cost_usd === "number" ? usage.cost_usd : undefined,
});

/**
 * Generate a turn id. The contract recommends ULID via `ulidx`, but
 * `ulidx` is not a project dependency and we are not allowed to add
 * top-level deps in Phase 2.3 — fall back to `crypto.randomUUID()`,
 * which is universally available in Tauri's WebView2 / WKWebView.
 */
const generateTurnId = (): string => {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  // Defensive fallback for ancient runtimes — never hit in practice
  // because Tauri 2.x targets modern WebViews.
  return `turn-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
};

export default AgentRuntimeClient;
