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
  os: string;
  arch: string;
  hostname: string;
}

// Check if running in Tauri
export const isTauri = (): boolean => {
  return typeof window !== 'undefined' && '__TAURI__' in window;
};

// File System Operations
export const readDirectory = async (path: string): Promise<FileEntry[]> => {
  if (!isTauri()) {
    console.warn('readDirectory: Not running in Tauri');
    return [];
  }
  return invoke<FileEntry[]>('read_directory', { path });
};

export const readFileContent = async (path: string): Promise<string> => {
  if (!isTauri()) {
    console.warn('readFileContent: Not running in Tauri');
    return '';
  }
  return invoke<string>('read_file_content', { path });
};

export const writeFileContent = async (path: string, content: string): Promise<void> => {
  if (!isTauri()) {
    console.warn('writeFileContent: Not running in Tauri');
    return;
  }
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
    return { os: 'unknown', arch: 'unknown', hostname: 'unknown' };
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

