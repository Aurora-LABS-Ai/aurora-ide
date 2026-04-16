import { invoke } from "@tauri-apps/api/core";
import type { FileNode } from "../types";

export interface CommandOutput {
  exit_code: number | null;
  stderr: string;
  stdout: string;
  success: boolean;
}

export interface RipgrepFileCount {
  count: number;
  file: string;
}

export interface RipgrepMatch {
  afterContext?: string[];
  beforeContext?: string[];
  content: string;
  file: string;
  lineNumber: number;
}

export interface RipgrepSearchRequest {
  caseInsensitive?: boolean;
  contextLines?: number;
  glob?: string;
  isRegex?: boolean;
  maxResults?: number;
  outputMode?: "content" | "files_with_matches" | "count";
  path: string;
  pattern: string;
}

export interface RipgrepSearchResponse {
  counts?: RipgrepFileCount[];
  error?: string;
  files?: string[];
  matches?: RipgrepMatch[];
  pattern: string;
  success: boolean;
  tool: string;
  totalFiles?: number;
  totalMatches?: number;
  truncated?: boolean;
}

export interface StructuredDocumentValidationRequest {
  content: string;
  format: "json" | "yaml" | "toml";
}

export interface StructuredDocumentValidationResponse {
  column?: number;
  error?: string;
  line?: number;
  valid: boolean;
}

export interface DbContextUsage {
  contextWindow: number;
  percentage: number;
  usedTokens: number;
}

// Thread persistence types (for DB bridge)
export interface DbMessage {
  content: string;
  id: string;
  isThinking?: boolean;
  role: string;
  thinking?: string;
  timeline?: unknown;
  timestamp: string;
  toolProposal?: unknown;
  tool_calls?: unknown[];
  tools?: unknown;
}

export interface DbThread {
  context_usage?: DbContextUsage | null;
  created_at: string;
  id: string;
  messages: DbMessage[];
  summary?: string | null;
  title: string;
  token_usage?: DbTokenUsage | null;
  updated_at: string;
}

export interface DbTokenUsage {
  completionTokens: number;
  promptTokens: number;
  totalTokens: number;
}

// Types matching Rust structs
export interface FileEntry {
  extension: string | null;
  is_dir: boolean;
  is_file: boolean;
  name: string;
  path: string;
}

export interface FsEventPayload {
  kind: string;
  paths: string[];
}

export interface ExplorerSnapshot {
  expandedFolders: string[];
  files: FileNode[];
  rootPath: string;
  selectedFile: string | null;
}

// File System Operations
export interface ReadDirectoryOptions {
  /** Whether to include hidden files/folders (starting with .). Defaults to true. */
  includeHidden?: boolean;
}

export interface SystemInfo {
  arch: string; // e.g., "x86_64", "aarch64"
  hostname: string;
  os: string; // e.g., "windows", "macos", "linux"
  os_version: string; // e.g., "10.0.26200" for Windows
  shell: string | null; // Default shell path
}

// Copy a file or folder to a new location
export const copyPath = async (source: string, destination: string): Promise<void> => {
  if (!isTauri()) {
    console.warn('copyPath: Not running in Tauri');
    return;
  }
  return invoke<void>('copy_path', { source, destination });
};

// Clipboard Operations
export const copyToClipboard = async (text: string): Promise<void> => {
  if (!isTauri()) {
    // Fallback to browser API
    await navigator.clipboard.writeText(text);
    return;
  }

  const { writeText } = await import('@tauri-apps/plugin-clipboard-manager');
  await writeText(text);
};

// Create a new file
export const createFile = async (path: string): Promise<void> => {
  if (!isTauri()) {
    console.warn('createFile: Not running in Tauri');
    return;
  }
  return invoke<void>('create_file', { path });
};

// Create a new folder
export const createFolder = async (path: string): Promise<void> => {
  if (!isTauri()) {
    console.warn('createFolder: Not running in Tauri');
    return;
  }
  return invoke<void>('create_folder', { path });
};

// Delete a file or folder
export const deletePath = async (path: string): Promise<void> => {
  if (!isTauri()) {
    console.warn('deletePath: Not running in Tauri');
    return;
  }
  return invoke<void>('delete_path', { path });
};
// Shell Operations
export const executeCommand = async (command: string, cwd?: string, shell?: 'powershell' | 'bash'): Promise<CommandOutput> => {
  if (!isTauri()) {
    console.warn('executeCommand: Not running in Tauri');
    return { stdout: '', stderr: 'Not running in Tauri', exit_code: 1, success: false };
  }
  return invoke<CommandOutput>('execute_command', { command, cwd, shell });
};

export const executeCommandStream = async (
  requestId: string,
  command: string,
  cwd?: string,
  shell?: 'powershell' | 'bash',
  timeoutMs?: number,
): Promise<CommandOutput> => {
  if (!isTauri()) {
    console.warn('executeCommandStream: Not running in Tauri');
    return { stdout: '', stderr: 'Not running in Tauri', exit_code: 1, success: false };
  }
  return invoke<CommandOutput>('execute_command_stream', {
    app: undefined,
    requestId,
    command,
    cwd,
    shell,
    timeoutMs,
  });
};

export const cancelCommandStream = async (requestId: string): Promise<void> => {
  if (!isTauri()) {
    console.warn('cancelCommandStream: Not running in Tauri');
    return;
  }
  await invoke<void>('cancel_command_stream', { requestId });
};

// System Operations
export const getSystemInfo = async (): Promise<SystemInfo> => {
  if (!isTauri()) {
    console.warn('getSystemInfo: Not running in Tauri');
    return { os: 'unknown', os_version: 'unknown', arch: 'unknown', hostname: 'unknown', shell: null };
  }
  return invoke<SystemInfo>('get_system_info');
};
export const getGlobalSkillsPath = async (): Promise<string | null> => {
  if (!isTauri()) {
    console.warn('getGlobalSkillsPath: Not running in Tauri');
    return null;
  }
  return invoke<string | null>('get_global_skills_path');
};
// Workspace helpers
export const getWorkspaceRoot = async (): Promise<string | null> => {
  if (!isTauri()) {
    console.warn('getWorkspaceRoot: Not running in Tauri');
    return null;
  }
  try {
    return await invoke<string>('get_workspace_root');
  } catch (err) {
    console.error('Failed to fetch workspace root:', err);
    return null;
  }
};

// Check if running in Tauri
export const isTauri = (): boolean => {
  return typeof window !== 'undefined' && '__TAURI__' in window;
};
// Dialog Operations (using Tauri plugin)
export const openFileDialog = async (options?: {
  multiple?: boolean;
  directory?: boolean;
  filters?: { name: string; extensions: string[] }[];
}): Promise<string | string[] | null> => {
  if (!isTauri()) {
    console.warn('openFileDialog: Not running in Tauri');
    return null;
  }

  const { open } = await import('@tauri-apps/plugin-dialog');
  return open(options);
};

// Open a terminal at the specified path
export const openInTerminal = async (path: string): Promise<void> => {
  if (!isTauri()) {
    console.warn('openInTerminal: Not running in Tauri');
    return;
  }
  return invoke<void>('open_in_terminal', { path });
};
export const readDirectory = async (path: string, options?: ReadDirectoryOptions): Promise<FileEntry[]> => {
  if (!isTauri()) {
    console.warn('readDirectory: Not running in Tauri');
    return [];
  }
  return invoke<FileEntry[]>('read_directory', {
    path,
    includeHidden: options?.includeHidden ?? true  // Default to showing hidden files
  });
};

export const ripgrepSearch = async (
  request: RipgrepSearchRequest,
): Promise<RipgrepSearchResponse> => {
  if (!isTauri()) {
    return {
      success: false,
      tool: "grep",
      pattern: request.pattern,
      error: "File operations require desktop app",
    };
  }

  return invoke<RipgrepSearchResponse>("ripgrep_search", { request });
};

export const validateStructuredDocument = async (
  request: StructuredDocumentValidationRequest,
): Promise<StructuredDocumentValidationResponse> => {
  if (!isTauri()) {
    return {
      valid: false,
      error: "Structured document validation requires desktop app",
    };
  }

  return invoke<StructuredDocumentValidationResponse>(
    "validate_structured_document",
    { request },
  );
};

export const readFileContent = async (path: string): Promise<string> => {
  if (!isTauri()) {
    console.warn('readFileContent: Not running in Tauri');
    return '';
  }
  // Use cached file reader for better performance
  const { readFileCached } = await import('./file-cache');
  return readFileCached(path);
};
export const readFromClipboard = async (): Promise<string> => {
  if (!isTauri()) {
    // Fallback to browser API
    return navigator.clipboard.readText();
  }

  const { readText } = await import('@tauri-apps/plugin-clipboard-manager');
  return readText();
};

// Rename a file or folder
export const renamePath = async (oldPath: string, newPath: string): Promise<void> => {
  if (!isTauri()) {
    console.warn('renamePath: Not running in Tauri');
    return;
  }
  return invoke<void>('rename_path', { oldPath, newPath });
};

// Reveal a file or folder in the system file explorer
export const revealInExplorer = async (path: string): Promise<void> => {
  if (!isTauri()) {
    console.warn('revealInExplorer: Not running in Tauri');
    return;
  }
  return invoke<void>('reveal_in_explorer', { path });
};
export const saveFileDialog = async (options?: {
  defaultPath?: string;
  filters?: { name: string; extensions: string[] }[];
}): Promise<string | null> => {
  if (!isTauri()) {
    console.warn('saveFileDialog: Not running in Tauri');
    return null;
  }

  const { save } = await import('@tauri-apps/plugin-dialog');
  return save(options);
};

// Thread persistence (DB-backed)
export const saveThreadToDb = async (thread: DbThread): Promise<void> => {
  if (!isTauri()) {
    console.warn('saveThreadToDb: Not running in Tauri');
    return;
  }
  return invoke<void>('thread_save', { thread });
};

// Start filesystem watcher
export const startFsWatcher = async (path: string): Promise<void> => {
  if (!isTauri()) {
    console.warn('startFsWatcher: Not running in Tauri');
    return;
  }
  return invoke<void>('start_fs_watcher', { path });
};

// Stop filesystem watcher
export const stopFsWatcher = async (): Promise<void> => {
  if (!isTauri()) {
    console.warn('stopFsWatcher: Not running in Tauri');
    return;
  }
  return invoke<void>('stop_fs_watcher');
};

export const explorerApplyFsChanges = async (
  paths: string[],
  kind?: string,
): Promise<ExplorerSnapshot> => {
  return invoke<ExplorerSnapshot>('explorer_apply_fs_changes', { paths, kind });
};

export const explorerClearWorkspace = async (): Promise<void> => {
  return invoke<void>('explorer_clear_workspace');
};

export const explorerCollapseAll = async (): Promise<ExplorerSnapshot> => {
  return invoke<ExplorerSnapshot>('explorer_collapse_all');
};

export const explorerExpandFolder = async (
  folderId: string,
): Promise<ExplorerSnapshot> => {
  return invoke<ExplorerSnapshot>('explorer_expand_folder', { folderId });
};

export const explorerGetState = async (): Promise<ExplorerSnapshot | null> => {
  return invoke<ExplorerSnapshot | null>('explorer_get_state');
};

export const explorerOpenWorkspace = async (
  path: string,
  showHidden?: boolean,
): Promise<ExplorerSnapshot> => {
  return invoke<ExplorerSnapshot>('explorer_open_workspace', { path, showHidden });
};

export const explorerRefresh = async (): Promise<ExplorerSnapshot> => {
  return invoke<ExplorerSnapshot>('explorer_refresh');
};

export const explorerRevealFile = async (
  filePath: string,
): Promise<ExplorerSnapshot> => {
  return invoke<ExplorerSnapshot>('explorer_reveal_file', { filePath });
};

export const explorerSaveState = async (): Promise<void> => {
  return invoke<void>('explorer_save_state');
};

export const explorerSelectFile = async (
  fileId: string | null,
): Promise<ExplorerSnapshot> => {
  return invoke<ExplorerSnapshot>('explorer_select_file', { fileId });
};

export const explorerToggleFolder = async (
  folderId: string,
): Promise<ExplorerSnapshot> => {
  return invoke<ExplorerSnapshot>('explorer_toggle_folder', { folderId });
};
export const writeFileContent = async (path: string, content: string): Promise<void> => {
  if (!isTauri()) {
    console.warn('writeFileContent: Not running in Tauri');
    return;
  }
  // Invalidate frontend cache before write (Rust backend handles its own cache)
  const { invalidateFileCache } = await import('./file-cache');
  invalidateFileCache(path);
  return invoke<void>('write_file_content', { path, content });
};

// PTY operations are now handled by tauri-plugin-pty
// Import from 'tauri-pty' package instead

// Re-export batch file operations for performance-critical code
export { readFilesBatch, preloadFiles, getCacheStats } from './file-cache';

// =============================================================================
// CLI Installation Commands
// =============================================================================

/**
 * Install the Aurora CLI command to system PATH
 * This enables using `aurora .` from any terminal
 * On Windows: Creates aurora.cmd and adds to user PATH
 * On Unix: Creates symlink in ~/.local/bin
 */
export const installAuroraCli = async (): Promise<string> => {
  if (!isTauri()) {
    console.warn('installAuroraCli: Not running in Tauri');
    return 'Not running in Tauri';
  }
  return invoke<string>('install_aurora_cli');
};

/**
 * Check if the Aurora CLI command is installed
 */
export const isAuroraCliInstalled = async (): Promise<boolean> => {
  if (!isTauri()) {
    console.warn('isAuroraCliInstalled: Not running in Tauri');
    return false;
  }
  return invoke<boolean>('is_aurora_cli_installed');
};

/**
 * Uninstall the Aurora CLI command from system PATH
 */
export const uninstallAuroraCli = async (): Promise<string> => {
  if (!isTauri()) {
    console.warn('uninstallAuroraCli: Not running in Tauri');
    return 'Not running in Tauri';
  }
  return invoke<string>('uninstall_aurora_cli');
};

/**
 * Install Aurora into the Windows Explorer context menu for folders.
 */
export const installAuroraContextMenu = async (): Promise<string> => {
  if (!isTauri()) {
    console.warn('installAuroraContextMenu: Not running in Tauri');
    return 'Not running in Tauri';
  }
  return invoke<string>('install_aurora_context_menu');
};

/**
 * Check whether the Aurora Windows Explorer context menu is installed.
 */
export const isAuroraContextMenuInstalled = async (): Promise<boolean> => {
  if (!isTauri()) {
    console.warn('isAuroraContextMenuInstalled: Not running in Tauri');
    return false;
  }
  return invoke<boolean>('is_aurora_context_menu_installed');
};

/**
 * Remove Aurora from the Windows Explorer context menu.
 */
export const uninstallAuroraContextMenu = async (): Promise<string> => {
  if (!isTauri()) {
    console.warn('uninstallAuroraContextMenu: Not running in Tauri');
    return 'Not running in Tauri';
  }
  return invoke<string>('uninstall_aurora_context_menu');
};

export interface AuroraWebSearchRequest {
  action?: string;
  query?: string;
  url?: string;
  numResults?: number;
  region?: string;
  safeSearch?: string;
}

export interface AuroraWebSearchResponse {
  success: boolean;
  action?: string;
  query?: string;
  url?: string;
  results?: unknown;
  content?: unknown;
  error?: string;
}

/**
 * Run native web search / fetch via Aurora WebSearch SDK
 */
export const auroraWebSearch = async (
  request: AuroraWebSearchRequest,
): Promise<AuroraWebSearchResponse> => {
  if (!isTauri()) {
    console.warn('auroraWebSearch: Not running in Tauri');
    return { success: false, error: 'Not running in Tauri' };
  }
  return invoke<AuroraWebSearchResponse>('aurora_websearch', { request });
};
