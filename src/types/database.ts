// ============================================================
// WORKSPACE STATE
// ============================================================
// ============================================================
// APP SETTINGS
// ============================================================
export interface AppSettings {
  agentExecutionMode?: 'agent' | 'plan' | 'team';
  // Agent Team (see DOCS/aurora-agent-team-ground-truth.md)
  teamEnabled?: boolean;
  maxTeamSize?: number;
  /**
   * Provider/model the Lead runs on, as a `"providerId:modelKey"` selection
   * from the user's configured providers. Empty/undefined means "use my
   * active chat model".
   */
  teamLeadModel?: string;
  /**
   * Provider/model the IC team members run on, same `"providerId:modelKey"`
   * shape. Empty/undefined falls back to the active chat model.
   */
  teamMemberModel?: string;
  /**
   * Default integration-gate commands (Settings → Team) the Lead runs after the
   * build to verify the project. Empty/undefined skips that gate. A
   * `team_dispatch` call inherits these when the model doesn't pass its own.
   */
  teamGateBuild?: string;
  teamGateLint?: string;
  teamGateTest?: string;
  /**
   * Global, workspace-agnostic user instructions injected into the agent's
   * system prompt for every workspace. Empty/undefined means none.
   */
  globalInstructions?: string;
  /** Context-compaction trigger as a % of the context window (50–95). */
  compactionThresholdPct?: number;
  /** `max_output_tokens` budget for the compaction summary call (2,000–16,000). */
  compactionSummaryBudget?: number;
  /** AI title maker — generate a short chat title from the first message. */
  titleMakerEnabled?: boolean;
  /** Title source: "off" (derived from the message), "local" (prompt-refine
   *  llama.cpp model), or "cloud" (the endpoint below). Absent/empty on legacy
   *  rows — derived from `titleMakerEnabled` instead. */
  titleMakerMode?: string;
  titleMakerBaseUrl?: string;
  titleMakerApiKey?: string;
  titleMakerModel?: string;
  /** Allow read-only file tools to read files outside the workspace. */
  allowOutsideWorkspace?: boolean;
  /** Show the header flash + rail dot when a chat's turn finishes. Default on. */
  notifyOnTurnComplete?: boolean;
  /** While a turn streams, replace the header title with a live activity line. Default on. */
  showActivityInTitle?: boolean;
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
  maxTokens: number;
  maxToolCallsPerRequest: number;
  projectLayoutEnabled?: boolean; // Include file tree in first message
  selectedModel: string;
  /** Per-workspace skill enablement: `scopeKey -> (storageKey -> boolean)`. */
  skillToggles?: Record<string, Record<string, boolean>>;
  skillsEnabled?: boolean;
  speechBackend?: string;
  speechDevicePreference?: 'auto' | 'cpu' | 'gpu';
  speechEnabled?: boolean;
  speechEngine?: string;
  speechLanguage?: string;
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
  /** Currency ISO code. `null` is treated as `"USD"` by the UI. */
  priceCurrency: string | null;
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

