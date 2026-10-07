// ============================================================
// WORKSPACE STATE
// ============================================================
// ============================================================
// APP SETTINGS
// ============================================================

/**
 * One named global-instruction set (Settings → Agent). The user keeps up to
 * three and activates at most one.
 */
export interface GlobalInstructionProfile {
  id: string;
  name: string;
  text: string;
}

export interface AppSettings {
  agentExecutionMode?: 'agent' | 'plan' | 'chat';
  /** Which product the window is showing. `'chat'` is Aurora Chat. */
  auroraSurface?: 'build' | 'chat';
  /** Seed for the next chat, not the state of any conversation. */
  deepResearchNext?: boolean;
  /**
   * The models Aurora Chat's picker offers, as `"providerId:modelKey"`.
   *
   * Its own list, not `provider_models.enabled` — curating a short pool for
   * chatting must not shorten Build's roster. Empty means no shortlist yet,
   * and the picker then offers everything.
   */
  chatModelShortlist?: string[];
  /**
   * Image providers the user configured, with their models nested inside.
   *
   * Kept here rather than in tables of their own: a handful of rows, read at
   * startup, written when someone edits them, never joined against anything.
   * See `services/providers/image-providers.ts`.
   */
  /**
   * Provider categories and their assignments, as one blob.
   *
   * `unknown` on purpose, like `imageProviders` beside it: the shape is owned
   * and validated by `services/providers/provider-categories.ts`, which has to
   * tolerate whatever an older build or a hand-edited row left here.
   */
  providerCategories?: unknown;
  imageProviders?: unknown[];
  /**
   * Legacy single global-instruction text. Kept in lockstep with the ACTIVE
   * profile below so older builds sharing this database still read the right
   * rules. Empty/undefined means none.
   */
  globalInstructions?: string;
  /**
   * Named global-instruction sets (Settings → Agent), up to three. At most
   * one is active; its text is what the system prompt carries.
   */
  globalInstructionProfiles?: GlobalInstructionProfile[];
  /** Id of the active profile. Empty/undefined means none is sent. */
  activeGlobalInstructionProfileId?: string;
  /** Context-compaction trigger as a % of the context window (50–95). */
  compactionThresholdPct?: number;
  /** `max_output_tokens` budget for the compaction summary call (2,000–16,000). */
  compactionSummaryBudget?: number;
  /**
   * Provider/model the summarization call runs on, as a `"providerId:modelKey"`
   * selection. Empty/undefined summarizes on the conversation's own model.
   */
  compactionModel?: string;
  /** AI title maker — generate a short chat title from the first message. */
  titleMakerEnabled?: boolean;
  /** Title source: "off" (derived from the message), "local" (prompt-refine
   *  llama.cpp model), or "cloud" (the endpoint below). Absent/empty on legacy
   *  rows — derived from `titleMakerEnabled` instead. */
  titleMakerMode?: string;
  titleMakerBaseUrl?: string;
  titleMakerApiKey?: string;
  titleMakerModel?: string;
  /** Local title model, used when `titleMakerMode === "local"`. Empty means
   *  "reuse the prompt-refine model" — what local mode has always done. */
  titleMakerLocalModel?: string;
  /** Chat format for `titleMakerLocalModel`. Empty means "auto". */
  titleMakerLocalChatFormat?: string;
  /** How far outside the open project the file tools may reach:
   *  `workspace` | `read` | `full`. Empty means the row predates the mode. */
  workspaceAccess?: string;
  /** The boolean the mode above replaced. Read only when it is unset. */
  allowOutsideWorkspace?: boolean;
  /** Show the header flash + rail dot when a chat's turn finishes. Default on. */
  notifyOnTurnComplete?: boolean;
  /** While a turn streams, replace the header title with a live activity line. Default on. */
  showActivityInTitle?: boolean;
  /**
   * Let the agent split a long turn into named chapters. Adds a short
   * instruction to the system prompt and gives the agent the `chapter` tool, so
   * it only takes effect on turns started after it is switched on. Default off.
   */
  transcriptChapters?: boolean;
  /** Whether the browser toolset is advertised to the model. Defaults on. */
  browserTools?: boolean;
  /**
   * Hold the optional tool buckets (`mcp_*`, `browser_*`) out of the
   * advertised roster and let the model load them by name through
   * `tool_search`. Defaults off — it changes how the model reaches a tool.
   */
  deferTools?: boolean;
  /**
   * Whether other agents may send work to this Aurora over MCP (`aurora mcp`).
   * Defaults off; only the user turns it on.
   */
  mcpBridgeEnabled?: boolean;
  autoAcceptChanges?: boolean;
  autoApproveTools: boolean;
  autoSave: string;
  autoSaveDelay: number;
  explorerIconPack?: string;
  fontSize: number;
  fireworksAccountId?: string;
  fireworksTabEnabled?: boolean;
  /**
   * Provider ids the user has REMOVED from the Providers page. Built-in
   * presets are otherwise re-injected on every launch, so removal is
   * recorded here and filtered out of the seeded list. Reversible.
   */
  removedProviderIds?: string[];
  /**
   * Model row ids (`providerId::modelKey`) the user DELETED from a built-in
   * provider. Preset model rosters re-seed any missing key on every launch,
   * so — same story as `removedProviderIds` — a plain delete cannot stick
   * without a record of it. Cleared for an id when the user re-adds that
   * model by hand.
   */
  removedPresetModelIds?: string[];
  maxTokens: number;
  maxToolCallsPerRequest: number;
  projectLayoutEnabled?: boolean; // Include file tree in first message
  selectedModel: string;
  /** Image providers Aurora has already offered once; see `withSeededImageProviders`. */
  seededImageProviderIds?: string[];
  /** Per-workspace skill enablement: `scopeKey -> (storageKey -> boolean)`. */
  skillToggles?: Record<string, Record<string, boolean>>;
  skillsEnabled?: boolean;
  speechBackend?: string;
  speechDevicePreference?: 'auto' | 'cpu' | 'gpu';
  speechEnabled?: boolean;
  speechEngine?: string;
  speechLanguage?: string;
  /** `batch` transcribes on stop, `live` shows words while you talk. */
  speechMode?: 'batch' | 'live';
  /**
   * Live-dictation settings, stored as one object. Shaped by
   * `SpeechLiveSettings` in the settings store, which also fills in anything an
   * older saved row is missing.
   */
  speechLive?: unknown;
  speechModelPath?: string;
  speechRuntimePath?: string;
  speechThreads?: number;
  syntaxValidationEnabled?: boolean; // Pre-save syntax validation
  temperature: number;
  theme: string;
  thinkingEnabled: boolean;
  uiFontFamily?: string;
  uiScale?: number;
  uiTextScale?: number;
  wrapMode: boolean;
}

// ============================================================
// LLM PROVIDER (transport + auth + defaults — v15+)
// ============================================================
//
// As of schema v15 per-model capabilities (vision, thinking,
// tool-stream) and per-model context/output overrides live on
// `DbProviderModel` rows keyed by `providerId`. The `customModels`,
// `modelAliases`, `supportsThinking`, and `supportsVision` fields
// previously on this type are gone.
export interface DbLLMProvider {
  apiKey: string;
  /**
   * API-key POOL (v20+). When it holds more than one key the runtime
   * rotates them round-robin per turn and fails over to the next on an
   * auth / rate-limit / server error. `null`/`[]` → the single `apiKey`
   * is used. Persisted as a JSON array in the `api_keys` column.
   */
  apiKeys: string[] | null;
  baseUrl: string;
  contextWindow: number;
  createdAt: string;
  customHeaders: Record<string, string> | null;
  customParams: Record<string, unknown> | null;
  defaultMaxTokens: number | null;
  defaultTemperature: number | null;
  enabled: boolean;
  id: string;
  isCustom: boolean;
  maxOutputTokens: number;
  model: string;
  name: string;
  nickname: string | null;
  /** A line the user wrote about the provider, shown under its title (<= 150 chars, v25). */
  description: string | null;
  providerType: string | null;
  requiresApiKey: boolean;
  sortOrder: number;
  supportsToolStream: boolean;
  updatedAt: string;
}

// ============================================================
// PROVIDER MODEL (per-model capability profile — v15+)
// ============================================================
//
// One row per model exposed by a provider. `contextWindow` and
// `maxOutputTokens` are nullable: `null` means "inherit the
// provider's default", a non-null value overrides it.

/**
 * A model's reasoning capability + the user's chosen default, mirrored from
 * models.dev (v17+). `null`/absent means the model has no reasoning controls.
 *  - `effort`  → `levels` lists the selectable tiers (e.g. low/medium/high);
 *                `default` is the chosen tier.
 *  - `toggle`  → reasoning is simply on/off; `default` is a boolean.
 *  - `budget`  → a token budget in `[min, max]`; `default` is the chosen number.
 */
/**
 * How Aurora should encode a model's reasoning request.
 *
 * `auto` lets the selected API format choose its native representation. The
 * explicit modes exist for compatibility gateways whose model id does not say
 * which generation of a protocol they implement. This is request metadata,
 * not an arbitrary body field, so the adapter can validate and translate it.
 */
export type ReasoningRequestMode =
  | "auto"
  | "anthropic-adaptive"
  | "anthropic-budget"
  | "openai-effort"
  | "openai-thinking";

/** What Aurora does with a stored reasoning block on the next request. */
export type ReasoningReplayMode =
  | "auto"
  | "reasoning_content"
  | "reasoning"
  | "off";

export interface ModelReasoning {
  type: "effort" | "toggle" | "budget";
  levels?: string[];
  min?: number;
  max?: number;
  default?: string | number | boolean;
  /**
   * Master on/off for reasoning, controlled per-model from the composer. When
   * `false`, reasoning is OFF and no effort/budget is sent — regardless of
   * `default`. Undefined means ON for `effort`/`budget` models; `toggle` models
   * historically stored their on/off in `default` (kept for back-compat).
   */
  enabled?: boolean;
  /**
   * Whether reasoning can be turned OFF. `false` for natively-reasoning models
   * (the model always reasons; there's no on/off — only an effort selector). When
   * `false` the composer shows NO on/off switch and reasoning is always sent.
   * Undefined / `true` means it can be toggled. Only meaningful for `effort`.
   */
  toggleable?: boolean;
  /**
   * Every reasoning control models.dev says this model has — `reasoning_options`
   * is an array, and a model can declare more than one.
   *
   * Kept because `type` alone is lossy: it records which control Aurora
   * defaulted to, not which ones exist. The settings form renders its
   * reasoning-type choices from this list so a model is never offered a
   * control it does not have (picking `budget` on a Claude 4.7+ model, for
   * instance, is dropped on the wire with no feedback).
   *
   * Absent on rows written before this field existed — treat that as "unknown"
   * and offer everything, rather than hiding controls the user already set.
   */
  supported?: ("effort" | "toggle" | "budget")[];
  /**
   * Optional wire-encoding override. Undefined is the same as `auto` and is
   * what catalogue-backed models should normally keep.
   */
  requestMode?: ReasoningRequestMode;
  /**
   * Typed replacement for the old `extraBody.reasoning_replay` directive.
   * The resolver still reads that legacy key so existing rows keep working,
   * but every new edit is stored here and never leaks into an HTTP body.
   */
  replay?: ReasoningReplayMode;
}

export interface DbProviderModel {
  /** `${providerId}::${modelKey}` — primary key. */
  id: string;
  providerId: string;
  modelKey: string;
  label: string | null;
  contextWindow: number | null;
  maxOutputTokens: number | null;
  supportsVision: boolean;
  supportsThinking: boolean;
  supportsToolStream: boolean;
  enabled: boolean;
  sortOrder: number;
  // Pricing (v16+) — USD per 1M tokens, null means "unset".
  priceCacheHitPerMtok: number | null;
  priceCacheMissPerMtok: number | null;
  priceOutputPerMtok: number | null;
  /**
   * USD per 1M cache-CREATION tokens (v21+). `null` means "bill cache writes
   * at `priceCacheMissPerMtok`" — never zero. Cache writes are real spend and
   * were dropped from the cost entirely before this column existed.
   */
  priceCacheWritePerMtok: number | null;
  /** Currency ISO code. `null` is treated as `"USD"` by the UI. */
  priceCurrency: string | null;
  /**
   * Sampling temperature for this model (v22+). `null` inherits the provider's
   * `defaultTemperature`, then Aurora's own default.
   */
  temperature: number | null;
  /**
   * Wire format for this one model (v24+). `null` inherits the provider's own
   * type, which is how every provider whose format is a row-wide property
   * behaves. Set per model where the format belongs to the model instead — see
   * `LLMModel.providerType`.
   */
  providerType: string | null;
  /** Reasoning capability + chosen default (models.dev, v17+). */
  reasoning: ModelReasoning | null;
  /** Extra request-body fields merged verbatim at send time (v18+). */
  extraBody: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface EditorState {
  cursor_col: number | null;
  cursor_line: number | null;
  file_path: string;
  folded_regions: FoldedRegion[] | null;
  last_edited_at: string; // ISO timestamp
  scroll_offset: number | null;
}

export interface ExecutionProviderDetails {
  description: string;
  deviceId: number | null;
  isGpu: boolean;
  name: string;
}

// ============================================================
// EXPLORER STATE
// ============================================================
export interface ExplorerState {
  expanded_folders: string[];
  selected_file: string | null;
  workspace_path: string;
}

// ============================================================
// EDITOR STATE
// ============================================================
export interface FoldedRegion {
  end_line: number;
  start_line: number;
}

export interface PanelSizes {
  chat: number; // Percentage (0-100)
  editor: number; // Percentage (0-100)
  explorer: number; // Percentage (0-100)
}

export interface TabState {
  is_active: boolean;
  is_dirty: boolean;
  path: string;
}

// ============================================================
// TOOL SETTINGS
// ============================================================
export interface ToolSetting {
  approvalMode: 'auto' | 'always_ask' | 'deny';
  toolName: string;
  updatedAt: string;
}

export interface WorkspaceState {
  checkpoint_enabled?: boolean; // Whether checkpoints are enabled for this workspace (default: true)
  last_opened_at: string; // ISO timestamp
  open_tabs: TabState[];
  panel_sizes: PanelSizes | null;
  workspace_path: string | null;
}

