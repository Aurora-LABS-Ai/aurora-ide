/**
 * CLI Open Hook
 * 
 * Listens for `cli-open` events from the Rust backend when Aurora is launched
 * with command-line arguments (e.g., `aurora .` or `aurora /path/to/folder`).
 * 
 * This provides VS Code-like CLI functionality:
 * - `aurora .` opens the current directory
 * - `aurora /path/to/folder` opens a specific folder
 * - `aurora file.txt` opens a file (and its parent folder as workspace)
 */

import { useEffect } from 'react';
import { listen } from '@tauri-apps/api/event';
import { useWorkspaceStore } from '../store/useWorkspaceStore';
import { useEditorStore } from '../store/useEditorStore';
import { isTauri, readFileContent } from '../lib/tauri';

export interface CliOpenRequest {
  /** Workspace root folder to open */
  workspace_path: string | null;
  /** Specific file to open (and focus) */
  file_path: string | null;
  /** Line number to go to (1-indexed) */
  goto_line: number | null;
  /** Whether this should open in a new window */
  new_window: boolean;
  /** Files for diff view */
  diff_files: [string, string] | null;
}

/**
 * Hook to handle CLI open requests from the Rust backend
 */
export function useCliOpen() {
  const { setRootPath, rootPath } = useWorkspaceStore();
  const { openFile } = useEditorStore();

  useEffect(() => {
    if (!isTauri()) return;

    let unlisten: (() => void) | undefined;

    const setupListener = async () => {
      try {
        unlisten = await listen<CliOpenRequest>('cli-open', async (event) => {
          const request = event.payload;
          console.log('[useCliOpen] Received CLI open request:', request);

          // Open workspace if provided and different from current
          if (request.workspace_path && request.workspace_path !== rootPath) {
            console.log('[useCliOpen] Opening workspace:', request.workspace_path);
            setRootPath(request.workspace_path);
          }

          // Open file if provided
          if (request.file_path) {
            console.log('[useCliOpen] Opening file:', request.file_path);
            try {
              const content = await readFileContent(request.file_path);
              const filename = request.file_path.split(/[/\\]/).pop() || request.file_path;
              const language = detectLanguage(filename);
              
              openFile(request.file_path, filename, content, language);

              // TODO: If goto_line is provided, scroll to that line
              // This would require Monaco editor integration
              if (request.goto_line) {
                console.log('[useCliOpen] Would go to line:', request.goto_line);
                // Future: Integrate with Monaco editor to scroll to line
              }
            } catch (error) {
              console.error('[useCliOpen] Failed to open file:', error);
            }
          }

          // TODO: Handle diff_files for diff view
          if (request.diff_files) {
            console.log('[useCliOpen] Diff view requested:', request.diff_files);
            // Future: Implement diff view
          }
        });

        console.log('[useCliOpen] Listening for CLI open events');
      } catch (error) {
        console.error('[useCliOpen] Failed to setup listener:', error);
      }
    };

    setupListener();

    return () => {
      if (unlisten) {
        unlisten();
      }
    };
  }, [setRootPath, rootPath, openFile]);
}

/**
 * Detect language from filename extension
 */
function detectLanguage(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  const langMap: Record<string, string> = {
    'ts': 'typescript',
    'tsx': 'typescript',
    'js': 'javascript',
    'jsx': 'javascript',
    'json': 'json',
    'css': 'css',
    'scss': 'scss',
    'less': 'less',
    'html': 'html',
    'htm': 'html',
    'md': 'markdown',
    'mdx': 'markdown',
    'rs': 'rust',
    'toml': 'toml',
    'yaml': 'yaml',
    'yml': 'yaml',
    'py': 'python',
    'go': 'go',
    'java': 'java',
    'c': 'c',
    'cpp': 'cpp',
    'h': 'c',
    'hpp': 'cpp',
    'cs': 'csharp',
    'rb': 'ruby',
    'php': 'php',
    'sh': 'shell',
    'bash': 'shell',
    'zsh': 'shell',
    'ps1': 'powershell',
    'sql': 'sql',
    'graphql': 'graphql',
    'gql': 'graphql',
    'vue': 'vue',
    'svelte': 'svelte',
    'txt': 'plaintext',
  };
  return langMap[ext] || 'plaintext';
}

