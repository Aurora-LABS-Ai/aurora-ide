import type {
  ReasoningRequestConfig,
  StreamCallbacks as ProviderStreamCallbacks,
  ToolCallRequest,
} from "@/kernel/services/providers/types";
import type { AgentExecutionMode } from "@/apps/agent/services/runtime/agent-execution-mode";

export interface AgentCallbacks extends ProviderStreamCallbacks {
  /** Snapshot committed output before each model-call attempt starts. */
  onStreamAttemptStarted?: () => void;
  onIterationComplete?: (iteration: number) => void;
  onToolApprovalRequired?: (toolCall: ToolCallRequest) => Promise<boolean>;
  onToolExecutionComplete?: (toolCall: ToolCallRequest, result: string) => void;
  onToolExecutionError?: (toolCall: ToolCallRequest, error: string) => void;
  onToolExecutionStart?: (toolCall: ToolCallRequest) => void;
  onToolRejected?: (toolCall: ToolCallRequest, reason: string) => void;
  /**
   * Fires when the Rust runtime drained the mid-turn queue and
   * stapled the user's queued text to the just-built tool message.
   * Panels use this to drop an inline `user_injection` timeline
   * event into the streaming assistant message — no separate user
   * bubble, since the bubble would land after the streaming message
   * and visually invert the order.
   */
  onQueuedMessageInjected?: (
    text: string,
    chips?: import("@/apps/agent/services/threads/thread-service").AttachedPromptChip[] | null,
    /**
     * Who queued it. `"process"` is Aurora reporting a background process and
     * renders as a one-line beat — never as the user's own words, which is
     * what it used to do.
     */
    origin?: "user" | "process",
  ) => void;
  /**
   * Context compaction has begun (auto at threshold, or manual). UI: turn the
   * context ring into a spinner and show a live shimmer "compacting…" card.
   */
  onCompactionStarted?: () => void;
  /**
   * Context compaction finished. `beforeTokens`/`afterTokens` are the
   * model-context size immediately before/after the rewrite, for the card's
   * `before → after` label. The summary text is intentionally never surfaced.
   */
  onCompactionCompleted?: (beforeTokens: number, afterTokens: number) => void;
  /**
   * A compaction request ended without changing context. This is a terminal
   * state, not a zero-drop success; panels must stop their spinner and keep the
   * existing context projection.
   */
  onCompactionFailed?: (info: {
    beforeTokens: number;
    reason: string;
    cancelled: boolean;
  }) => void;
  /**
   * The runtime reported something the user needs to know that did NOT abort
   * the turn — most importantly, that the reply was cut off at the
   * output-token cap.
   *
   * These were previously dropped by the event dispatcher, which is how a turn
   * that ended at `max_tokens` mid-sentence reached the user as a stream that
   * simply stopped with no explanation. Panels should surface it as its own
   * inline marker rather than appending it to the message body, or it reads as
   * if the model wrote it.
   *
   * Non-recoverable runtime errors ALSO reach `onError`, so nothing the runtime
   * reports can go unseen.
   */
  onRuntimeNotice?: (notice: { message: string; recoverable: boolean }) => void;
  /**
   * The connection died mid-reply and the runtime is re-requesting the same
   * model call. Whatever streamed for THIS reply is about to be sent again
   * from its first token, so the panel must drop what it has already rendered
   * for it — otherwise the answer appears twice.
   *
   * Scope is one model call, never the turn: replies that already completed
   * and tool calls that already ran are in session history and must survive.
   *
   * Not an error, and deliberately not routed through {@link onRuntimeNotice}:
   * the user does not need to act, and if the retry succeeds there is nothing
   * to report afterwards. A failure that exhausts every attempt arrives as a
   * normal notice/error instead.
   */
  onPartialReplyDiscarded?: (info: {
    /** The attempt that failed, 1-based; the one now running is `attempt + 1`. */
    attempt: number;
    maxAttempts: number;
    /** Transport/provider detail. Diagnostics, not user-facing copy. */
    reason: string;
  }) => void;
}

export interface AgentConfig {
  autoApproveTools?: boolean;
  beforeToolExecution?: () => Promise<void>;
  executionMode?: AgentExecutionMode;
  getToolApproval?: (toolName: string) => "auto" | "always_ask" | "deny";
  maxTokens?: number;
  maxToolIterations?: number;
  /**
   * The model as the conversation is pinned to it (`provider:modelKey`), when
   * that differs from the id the request carries.
   *
   * Only Cursor separates the two: its effort tier and Fast lane are choices
   * folded into the model id at send time, and the pin has to stay the model
   * itself — it is the key every capability lookup uses, the context window
   * included.
   */
  modelSelection?: string;
  /**
   * Compaction trigger as a percentage of the context window (50–95). When the
   * projected request crosses it, the Rust runtime summarizes older history
   * into a persistent marker before continuing. `undefined`/`0` disables
   * compaction (trim-only). See `DOCS/compaction-design.md`.
   */
  compactionThresholdPct?: number;
  /** `max_output_tokens` budget for the summarization call (2,000–16,000). */
  compactionSummaryBudget?: number;
  /**
   * Provider the summarization call runs on (Settings → Agent → Compaction
   * model). `undefined` summarizes on the conversation's own provider.
   */
  compactionProvider?: import("@/apps/agent/services/providers").ProviderConfig;
  /** How far outside the project the file tools may reach:
   *  `workspace` | `read` | `full` (Settings → Tools → File access). */
  workspaceAccess?: "workspace" | "read" | "full";
  /**
   * Advertise the `chapter` tool so the agent can name the parts of a long turn
   * (Settings → Preferences → Transcript). The same value gates the chapter
   * instruction in `composeAgentSystemPrompt`, so the roster and the prompt are
   * switched together.
   */
  transcriptChapters?: boolean;
  /**
   * Aurora Chat: the CONVERSATION was started in deep research.
   *
   * Fixed at creation and read from the thread, never from a live setting —
   * which is what keeps its prompt section byte-identical across every turn
   * and therefore inside the cached prefix.
   */
  deepResearch?: boolean;
  /**
   * Advertise the browser toolset this turn. Sixteen schemas, ~2,800 tokens on
   * every request, so it is switchable — Settings → Agent → Browser control.
   */
  browserTools?: boolean;
  /** Legacy preference; optional tools always use tool_search and call_tool. */
  deferTools?: boolean;
  /**
   * Aurora Chat: the image providers `generate_image` may use this turn — the
   * rows from Settings → Providers → Image providers, keys included. Sent per
   * turn so a provider added mid-conversation works from the next message.
   * Omitted in the project modes, where the tool is not offered.
   */
  imageProviders?: import("@/apps/agent/services/providers/image-providers").ImageProvider[];
  providerConfig?: import("@/apps/agent/services/providers").ProviderConfig;
  systemPrompt?: string;
  temperature?: number;
  /**
   * Canonical provider-neutral reasoning intent for this model. The selected
   * adapter owns the actual request fields.
   */
  reasoning?: ReasoningRequestConfig;
  /** @deprecated Derived from `reasoning.enabled` for older callers. */
  thinkingEnabled?: boolean;
  /**
   * Explicit extended-thinking token budget for models whose reasoning control
   * is a budget rather than an effort tier (chosen per model in the composer's
   * model picker). Only read when `thinkingEnabled` — a budget never turns
   * thinking on by itself. `undefined` lets the provider adapter derive one.
   */
  /** @deprecated Derived from `reasoning.budgetTokens` for older callers. */
  thinkingBudgetTokens?: number;
  threadId?: string;
  /**
   * Explicit workspace root for this turn. When set, it overrides the global
   * `useWorkspaceStore.rootPath` lookup in `AgentService.chat` — required for
   * the agent window, where multiple turns can run concurrently for DIFFERENT
   * projects and must not race on a single shared global. Leave undefined in
   * the IDE (one window, one workspace) to keep the legacy store-driven path.
   */
  workspacePath?: string | null;
}

export interface ExecutedToolCall {
  args: Record<string, unknown>;
  id: string;
  name: string;
  result: string;
  status: "approved" | "rejected" | "executed" | "failed";
}

export interface AgentResponse {
  content: string;
  iterations: number;
  thinking?: string;
  toolCalls?: ExecutedToolCall[];
}
