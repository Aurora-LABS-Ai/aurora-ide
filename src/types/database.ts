// ============================================================
// WORKSPACE STATE
// ============================================================

export interface TabState {
  path: string;
  is_active: boolean;
  is_dirty: boolean;
}

export interface PanelSizes {
  explorer: number; // Percentage (0-100)
  editor: number;   // Percentage (0-100)
  chat: number;     // Percentage (0-100)
}

export interface WorkspaceState {
  workspace_path: string | null;
  open_tabs: TabState[];
  panel_sizes: PanelSizes | null;
  last_opened_at: string; // ISO timestamp
}

// ============================================================
// EDITOR STATE
// ============================================================

export interface FoldedRegion {
  start_line: number;
  end_line: number;
}

export interface EditorState {
  file_path: string;
  cursor_line: number | null;
  cursor_col: number | null;
  scroll_offset: number | null;
  folded_regions: FoldedRegion[] | null;
  last_edited_at: string; // ISO timestamp
}

// ============================================================
// EXPLORER STATE
// ============================================================

export interface ExplorerState {
  workspace_path: string;
  expanded_folders: string[];
  selected_file: string | null;
}

// ============================================================
// APP SETTINGS
// ============================================================

export interface AppSettings {
  selectedModel: string;
  autoApproveTools: boolean;
  fontSize: number;
  theme: string;
  thinkingEnabled: boolean;
  maxTokens: number;
  temperature: number;
  autoSave: string;
  autoSaveDelay: number;
  maxToolCallsPerRequest: number;
  wrapMode: boolean;
}

// ============================================================
// LLM PROVIDER
// ============================================================

export interface DbLLMProvider {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  contextWindow: number;
  maxOutputTokens: number;
  supportsThinking: boolean;
  supportsToolStream: boolean;
  enabled: boolean;
  isCustom: boolean;
  customModels: string[] | null;
  customHeaders: Record<string, string> | null;
  customParams: Record<string, unknown> | null;
  providerType: string | null;
  defaultTemperature: number | null;
  defaultMaxTokens: number | null;
  requiresApiKey: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

// ============================================================
// TOOL SETTINGS
// ============================================================

export interface ToolSetting {
  toolName: string;
  approvalMode: 'auto' | 'always_ask' | 'deny';
  updatedAt: string;
}