import { invoke } from '@tauri-apps/api/core';

// Types matching Rust structs
export interface FileEntry {
  name: string;
  path: string;
  is_dir: boolean;
  is_file: boolean;
  extension: string | null;
}

export interface CommandOutput {
  stdout: string;
  stderr: string;
  exit_code: number | null;
  success: boolean;
}

export interface SystemInfo {
  os: string;           // e.g., "windows", "macos", "linux"
  os_version: string;   // e.g., "10.0.26200" for Windows
  arch: string;         // e.g., "x86_64", "aarch64"
  hostname: string;
  shell: string | null; // Default shell path
}

// Thread persistence types (for DB bridge)
export interface DbMessage {
  id: string;
  role: string;
  content: string;
  timestamp: string;
  tool_calls?: Array<any>;
  thinking?: string;
  isThinking?: boolean;
  tools?: any;
  timeline?: any;
  toolProposal?: any;
}

export interface DbTokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface DbContextUsage {
  usedTokens: number;
  contextWindow: number;
  percentage: number;
}

export interface DbThread {
  id: string;
  title: string;
  summary?: string | null;
  messages: DbMessage[];
  token_usage?: DbTokenUsage | null;
  context_usage?: DbContextUsage | null;
  created_at: string;
  updated_at: string;
}

export interface FsEventPayload {
  paths: string[];
  kind: string;
}

// Check if running in Tauri
export const isTauri = (): boolean => {
  return typeof window !== 'undefined' && '__TAURI__' in window;
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

// File System Operations
export interface ReadDirectoryOptions {
  /** Whether to include hidden files/folders (starting with .). Defaults to true. */
  includeHidden?: boolean;
}

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

export const readFileContent = async (path: string): Promise<string> => {
  if (!isTauri()) {
    console.warn('readFileContent: Not running in Tauri');
    return '';
  }
  // Use cached file reader for better performance
  const { readFileCached } = await import('./file-cache');
  return readFileCached(path);
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

// Shell Operations
export const executeCommand = async (command: string, cwd?: string, shell?: 'powershell' | 'bash'): Promise<CommandOutput> => {
  if (!isTauri()) {
    console.warn('executeCommand: Not running in Tauri');
    return { stdout: '', stderr: 'Not running in Tauri', exit_code: 1, success: false };
  }
  return invoke<CommandOutput>('execute_command', { command, cwd, shell });
};

// System Operations
export const getSystemInfo = async (): Promise<SystemInfo> => {
  if (!isTauri()) {
    console.warn('getSystemInfo: Not running in Tauri');
    return { os: 'unknown', os_version: 'unknown', arch: 'unknown', hostname: 'unknown', shell: null };
  }
  return invoke<SystemInfo>('get_system_info');
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

export const readFromClipboard = async (): Promise<string> => {
  if (!isTauri()) {
    // Fallback to browser API
    return navigator.clipboard.readText();
  }

  const { readText } = await import('@tauri-apps/plugin-clipboard-manager');
  return readText();
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

// Rename a file or folder
export const renamePath = async (oldPath: string, newPath: string): Promise<void> => {
  if (!isTauri()) {
    console.warn('renamePath: Not running in Tauri');
    return;
  }
  return invoke<void>('rename_path', { oldPath, newPath });
};

// Copy a file or folder to a new location
export const copyPath = async (source: string, destination: string): Promise<void> => {
  if (!isTauri()) {
    console.warn('copyPath: Not running in Tauri');
    return;
  }
  return invoke<void>('copy_path', { source, destination });
};

// Thread persistence (DB-backed)
export const saveThreadToDb = async (thread: DbThread): Promise<void> => {
  if (!isTauri()) {
    console.warn('saveThreadToDb: Not running in Tauri');
    return;
  }
  return invoke<void>('save_thread', { thread });
};

export const getThreadFromDb = async (id: string): Promise<DbThread | null> => {
  if (!isTauri()) {
    console.warn('getThreadFromDb: Not running in Tauri');
    return null;
  }
  return invoke<DbThread | null>('get_thread', { id });
};

export const listThreadsFromDb = async (): Promise<DbThread[]> => {
  if (!isTauri()) {
    console.warn('listThreadsFromDb: Not running in Tauri');
    return [];
  }
  return invoke<DbThread[]>('list_threads');
};

export const deleteThreadFromDb = async (id: string): Promise<void> => {
  if (!isTauri()) {
    console.warn('deleteThreadFromDb: Not running in Tauri');
    return;
  }
  return invoke<void>('delete_thread', { id });
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

// Reveal a file or folder in the system file explorer
export const revealInExplorer = async (path: string): Promise<void> => {
  if (!isTauri()) {
    console.warn('revealInExplorer: Not running in Tauri');
    return;
  }
  return invoke<void>('reveal_in_explorer', { path });
};

// Open a terminal at the specified path
export const openInTerminal = async (path: string): Promise<void> => {
  if (!isTauri()) {
    console.warn('openInTerminal: Not running in Tauri');
    return;
  }
  return invoke<void>('open_in_terminal', { path });
};

// PTY operations are now handled by tauri-plugin-pty
// Import from 'tauri-pty' package instead

// Re-export batch file operations for performance-critical code
export { readFilesBatch, preloadFiles, getCacheStats } from './file-cache';
