import type { StreamCallbacks as ProviderStreamCallbacks, ToolCallRequest } from "./providers/types";
import type { AgentExecutionMode } from "./agent-execution-mode";

export interface AgentCallbacks extends ProviderStreamCallbacks {
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
  onQueuedMessageInjected?: (text: string) => void;
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
}

export interface AgentConfig {
  autoApproveTools?: boolean;
  beforeToolExecution?: () => Promise<void>;
  executionMode?: AgentExecutionMode;
  getToolApproval?: (toolName: string) => "auto" | "always_ask" | "deny";
  maxTokens?: number;
  maxToolIterations?: number;
  /**
   * Compaction trigger as a percentage of the context window (50–95). When the
   * projected request crosses it, the Rust runtime summarizes older history
   * into a persistent marker before continuing. `undefined`/`0` disables
   * compaction (trim-only). See `DOCS/compaction-design.md`.
   */
  compactionThresholdPct?: number;
  /** `max_output_tokens` budget for the summarization call (2,000–16,000). */
  compactionSummaryBudget?: number;
  /** Allow read-only file tools to read files outside the workspace. */
  allowOutsideWorkspace?: boolean;
  /**
   * Advertise the `chapter` tool so the agent can name the parts of a long turn
   * (Settings → Preferences → Transcript). The same value gates the chapter
   * instruction in `composeAgentSystemPrompt`, so the roster and the prompt are
   * switched together.
   */
  transcriptChapters?: boolean;
  providerConfig?: import("./providers").ProviderConfig;
  systemPrompt?: string;
  temperature?: number;
  thinkingEnabled?: boolean;
  /**
   * Explicit extended-thinking token budget for models whose reasoning control
   * is a budget rather than an effort tier (chosen per model in the composer's
   * model picker). Only read when `thinkingEnabled` — a budget never turns
   * thinking on by itself. `undefined` lets the provider adapter derive one.
   */
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
