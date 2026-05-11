// ============================================================
// WORKSPACE STATE
// ============================================================
// ============================================================
// APP SETTINGS
// ============================================================
export interface AppSettings {
  agentExecutionMode?: 'agent' | 'plan';
  autoAcceptChanges?: boolean;
  autoApproveTools: boolean;
  autoSave: string;
  autoSaveDelay: number;
  explorerIconPack?: string;
  fontSize: number;
  fireworksAccountId?: string;
  fireworksTabEnabled?: boolean;
  maxTokens: number;
  maxToolCallsPerRequest: number;
  projectLayoutEnabled?: boolean; // Include file tree in first message
  selectedModel: string;
  skillToggles?: Record<string, boolean>;
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

