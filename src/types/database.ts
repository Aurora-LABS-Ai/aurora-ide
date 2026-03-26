// ============================================================
// WORKSPACE STATE
// ============================================================
// ============================================================
// APP SETTINGS
// ============================================================
export interface AppSettings {
  autoAcceptChanges?: boolean;
  autoApproveTools: boolean;
  autoSave: string;
  autoSaveDelay: number;
  fontSize: number;
  maxTokens: number;
  maxToolCallsPerRequest: number;
  projectLayoutEnabled?: boolean; // Include file tree in first message
  selectedModel: string;
  skillToggles?: Record<string, boolean>;
  skillsEnabled?: boolean;
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
// LLM PROVIDER
// ============================================================
export interface DbLLMProvider {
  apiKey: string;
  baseUrl: string;
  contextWindow: number;
  createdAt: string;
  customHeaders: Record<string, string> | null;
  customModels: string[] | null;
  customParams: Record<string, unknown> | null;
  defaultMaxTokens: number | null;
  defaultTemperature: number | null;
  enabled: boolean;
  id: string;
  isCustom: boolean;
  maxOutputTokens: number;
  model: string;
  name: string;
  providerType: string | null;
  requiresApiKey: boolean;
  sortOrder: number;
  supportsThinking: boolean;
  supportsToolStream: boolean;
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

export interface GpuFeatures {
  coreml: boolean;
  cuda: boolean;
  directml: boolean;
  tensorrt: boolean;
}

export interface IndexProgress {
  currentFile: string | null;
  percentage: number;
  phase: string;
  processed: number;
  total: number;
  workspaceId: string;
}

export interface PanelSizes {
  chat: number; // Percentage (0-100)
  editor: number; // Percentage (0-100)
  explorer: number; // Percentage (0-100)
}

export interface SemanticIndex {
  chunkCount: number;
  createdAt: string;
  documentCount: number;
  errorMessage: string | null;

  /** Workspace-specific directory exclusions (relative paths) */
  excludedDirectories: string[];

  /** Workspace-specific file exclusions (relative paths) */
  excludedFiles: string[];
  id: string;
  lastIndexedAt: string | null;
  status: SemanticIndexStatus;
  totalBytes: number;
  updatedAt: string;
  workspaceName: string;
  workspacePath: string;
}

export interface SemanticSearchResult {
  chunkType: string;
  content: string;
  endLine: number;
  filePath: string;
  matchType: string;
  relativePath: string;
  score: number;
  startLine: number;
  symbolName: string | null;
}

export interface SemanticSettings {
  autoIndex: boolean;
  autoReindexInterval: number | null; // Minutes, null = disabled
  enabled: boolean;

  /** Specific directory paths to exclude (relative to workspace root) */
  excludedDirectories: string[];

  /** Specific file paths to exclude (relative to workspace root) */
  excludedFiles: string[];
  ignoredDirectories: string[];
  ignoredPatterns: string[];
  lexicalWeight: number;
  maxFileSize: number; // Bytes
  modelPath: string | null;
  searchMode: SearchMode;
  semanticWeight: number;
  updatedAt: string;
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

export type SearchMode = 'lexical' | 'semantic' | 'hybrid';

// ============================================================
// SEMANTIC SEARCH
// ============================================================
export type SemanticIndexStatus = 'pending' | 'indexing' | 'ready' | 'error';
