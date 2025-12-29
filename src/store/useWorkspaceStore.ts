import { create } from 'zustand';
import type { FileNode } from '../types';
import { isTauri, readDirectory, readFileContent, startFsWatcher, stopFsWatcher } from '../lib/tauri';
import { databaseService } from '../services/database';
import { useEditorStore } from './useEditorStore';
import { listen } from '@tauri-apps/api/event';

interface WorkspaceState {
  rootPath: string;
  files: FileNode[];
  expandedFolders: Set<string>;
  selectedFileId: string | null;
  isLoading: boolean;

  // Actions
  setRootPath: (path: string) => void;
  loadDirectory: (path: string) => Promise<void>;
  refreshDirectory: () => Promise<void>;
  toggleFolder: (folderId: string) => void;
  expandFolder: (folderId: string) => void;
  selectFile: (fileId: string) => void;
  setFiles: (files: FileNode[]) => void;
  clearWorkspace: () => void;

  // Database actions
  restoreExplorer: () => Promise<void>;
  saveExplorer: () => Promise<void>;
}

const getLanguageFromExtension = (filename: string): string => {
  const ext = filename.split('.').pop()?.toLowerCase();
  const langMap: Record<string, string> = {
    'ts': 'typescript',
    'tsx': 'typescript',
    'js': 'javascript',
    'jsx': 'javascript',
    'json': 'json',
    'css': 'css',
    'scss': 'scss',
    'html': 'html',
    'md': 'markdown',
    'rs': 'rust',
    'toml': 'toml',
    'yaml': 'yaml',
    'yml': 'yaml',
    'py': 'python',
    'go': 'go',
  };
  return langMap[ext || ''] || 'plaintext';
};

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  rootPath: '',
  files: [],
  expandedFolders: new Set(),
  selectedFileId: null,
  isLoading: false,

  setRootPath: (path) => {
    set({ rootPath: path });

    // Update editor store with workspace path
    useEditorStore.getState().setWorkspacePath(path);

    get().loadDirectory(path);

    // Start filesystem watcher
    if (isTauri()) {
      const startWatch = async () => {
        try {
          // stop previous watcher if any
          if (fsUnlisten) {
            fsUnlisten();
            fsUnlisten = null;
          }
          await startFsWatcher(path);
          fsUnlisten = await listen('fs-changed', async (event: any) => {
            const { rootPath } = get();
            if (!rootPath) return;
            const paths: string[] = event?.payload?.paths || [];
            const kind: string = event?.payload?.kind || 'any';
            const hasMatch = paths.some(p => p.startsWith(rootPath));

            if (hasMatch) {
              // Refresh file tree
              await get().refreshDirectory();

              // CRITICAL: Also refresh any open editor tabs that were modified
              // This enables live updates when AI tools write to files
              if (kind === 'modify' || kind === 'create') {
                const editorStore = useEditorStore.getState();
                const openTabs = editorStore.tabs;

                for (const changedPath of paths) {
                  const matchingTab = openTabs.find(tab => tab.path === changedPath);
                  if (matchingTab && !matchingTab.isDirty) {
                    // Only refresh if tab is not dirty (avoid overwriting user edits)
                    try {
                      const newContent = await readFileContent(changedPath);
                      editorStore.reloadTabContent(matchingTab.id, newContent);
                      console.log(`[fs-changed] Refreshed editor tab: ${matchingTab.filename}`);
                    } catch (err) {
                      console.warn(`[fs-changed] Failed to refresh tab ${changedPath}:`, err);
                    }
                  }
                }
              }
            }
          });
        } catch (err) {
          console.error('Failed to start fs watcher:', err);
        }
      };
      startWatch();
    }
  },

  loadDirectory: async (path: string) => {
    if (!isTauri()) {
      console.log('Not in Tauri environment');
      return;
    }

    // Try to restore explorer state first
    await get().restoreExplorer();

    // Preserve current expanded folders
    const currentExpanded = get().expandedFolders;
    set({ isLoading: true });

    try {
      const entries = await readDirectory(path);
      const buildTree = async (_dirPath: string, entries: Awaited<ReturnType<typeof readDirectory>>): Promise<FileNode[]> => {
        const nodes: FileNode[] = [];

        for (const entry of entries) {
          if (entry.is_dir) {
            let children: FileNode[] = [];
            try {
              const childEntries = await readDirectory(entry.path);
              children = await buildTree(entry.path, childEntries);
            } catch {
              children = [];
            }

            nodes.push({
              id: entry.path,
              name: entry.name,
              type: 'folder',
              children,
              path: entry.path,
            });
          } else {
            nodes.push({
              id: entry.path,
              name: entry.name,
              type: 'file',
              language: getLanguageFromExtension(entry.name),
              path: entry.path,
            });
          }
        }

        return nodes;
      };

      // Build tree directly from root contents (don't wrap in root folder)
      const children = await buildTree(path, entries);

      // Merge with existing expanded folders to preserve state
      const newExpanded = new Set([...currentExpanded, path]);

      // Set files directly as children, not wrapped in root folder
      set({
        files: children,
        expandedFolders: newExpanded,
        isLoading: false
      });
    } catch (err) {
      console.error('Failed to load directory:', err);
      set({ isLoading: false });
    }
  },

  refreshDirectory: async () => {
    const { rootPath } = get();
    if (rootPath) {
      await get().loadDirectory(rootPath);
    }
  },

  toggleFolder: (folderId) => set((state) => {
    const newExpanded = new Set(state.expandedFolders);
    if (newExpanded.has(folderId)) {
      newExpanded.delete(folderId);
    } else {
      newExpanded.add(folderId);
    }
    // Auto-save explorer state
    get().saveExplorer();
    return { expandedFolders: newExpanded };
  }),

  expandFolder: (folderId) => set((state) => {
    const newExpanded = new Set(state.expandedFolders);
    newExpanded.add(folderId);
    // Auto-save explorer state
    get().saveExplorer();
    return { expandedFolders: newExpanded };
  }),

  selectFile: (fileId) => {
    set({ selectedFileId: fileId });
    // Auto-save explorer state
    get().saveExplorer();
  },

  setFiles: (files) => set({ files }),

  clearWorkspace: () => {
    set({
      rootPath: '',
      files: [],
      expandedFolders: new Set(),
      selectedFileId: null
    }, false);

    if (fsUnlisten) {
      fsUnlisten();
      fsUnlisten = null;
    }
    if (isTauri()) {
      stopFsWatcher().catch(() => { });
    }
  },

  // Restore explorer state from database
  restoreExplorer: async () => {
    const { rootPath } = get();
    if (!rootPath) {
      return;
    }

    try {
      const state = await databaseService.getExplorerState(rootPath);
      if (state) {
        set({
          expandedFolders: new Set(state.expanded_folders),
          selectedFileId: state.selected_file,
        });
      }
    } catch (error) {
      console.error('Failed to restore explorer state:', error);
    }
  },

  // Save explorer state to database
  saveExplorer: async () => {
    const { rootPath, expandedFolders, selectedFileId } = get();
    if (!rootPath) {
      return;
    }

    try {
      const explorerState = {
        workspace_path: rootPath,
        expanded_folders: Array.from(expandedFolders),
        selected_file: selectedFileId,
      };

      await databaseService.saveExplorerState(explorerState);
    } catch (error) {
      console.error('Failed to save explorer state:', error);
    }
  },
}));

// Helper to load file content
export const loadFileContent = async (path: string): Promise<string> => {
  if (!isTauri()) {
    return '// File content (desktop app only)';
  }

  try {
    return await readFileContent(path);
  } catch (err) {
    console.error('Failed to load file:', err);
    return '// Failed to load file';
  }
};

// Global watcher cleanup
let fsUnlisten: (() => void) | null = null;
