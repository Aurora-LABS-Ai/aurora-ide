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
  autoAcceptChanges?: boolean;
  syntaxValidationEnabled?: boolean; // Pre-save syntax validation
  projectLayoutEnabled?: boolean; // Include file tree in first message
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

// ============================================================
// SEMANTIC SEARCH
// ============================================================

export type SemanticIndexStatus = 'pending' | 'indexing' | 'ready' | 'error';

export interface SemanticIndex {
  id: string;
  workspacePath: string;
  workspaceName: string;
  documentCount: number;
  chunkCount: number;
  totalBytes: number;
  status: SemanticIndexStatus;
  errorMessage: string | null;
  lastIndexedAt: string | null;
  /** Workspace-specific file exclusions (relative paths) */
  excludedFiles: string[];
  /** Workspace-specific directory exclusions (relative paths) */
  excludedDirectories: string[];
  createdAt: string;
  updatedAt: string;
}

export type SearchMode = 'lexical' | 'semantic' | 'hybrid';

export interface SemanticSettings {
  modelPath: string | null;
  enabled: boolean;
  autoIndex: boolean;
  autoReindexInterval: number | null; // Minutes, null = disabled
  ignoredPatterns: string[];
  ignoredDirectories: string[];
  /** Specific file paths to exclude (relative to workspace root) */
  excludedFiles: string[];
  /** Specific directory paths to exclude (relative to workspace root) */
  excludedDirectories: string[];
  maxFileSize: number; // Bytes
  searchMode: SearchMode;
  lexicalWeight: number;
  semanticWeight: number;
  updatedAt: string;
}

export interface IndexProgress {
  workspaceId: string;
  phase: string;
  processed: number;
  total: number;
  currentFile: string | null;
  percentage: number;
}

export interface SemanticSearchResult {
  filePath: string;
  relativePath: string;
  startLine: number;
  endLine: number;
  chunkType: string;
  symbolName: string | null;
  content: string;
  score: number;
  matchType: string;
}

export interface ExecutionProviderDetails {
  name: string;
  isGpu: boolean;
  deviceId: number | null;
  description: string;
}

export interface GpuFeatures {
  cuda: boolean;
  tensorrt: boolean;
  directml: boolean;
  coreml: boolean;
}