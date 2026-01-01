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
  toggleFolder: (folderId: string) => Promise<void>;
  expandFolder: (folderId: string) => Promise<void>;
  selectFile: (fileId: string) => void;
  revealFile: (filePath: string) => void;
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
    // Guard against duplicate setRootPath calls (React Strict Mode, etc.)
    if (lastSetRootPath === path) {
      return;
    }
    lastSetRootPath = path;
    
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
              // INSTANT refresh - Rust watcher is efficient
              await get().refreshDirectory();

              // Refresh any open editor tabs that were modified
              if (kind === 'modify' || kind === 'create') {
                const editorStore = useEditorStore.getState();
                const openTabs = editorStore.tabs;

                for (const changedPath of paths) {
                  const matchingTab = openTabs.find(tab => tab.path === changedPath);
                  if (matchingTab && !matchingTab.isDirty) {
                    try {
                      const newContent = await readFileContent(changedPath);
                      editorStore.reloadTabContent(matchingTab.id, newContent);
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
      return;
    }

    // Guard against multiple simultaneous loads
    if (isLoadingDirectory) {
      pendingLoadPath = path;
      return;
    }
    
    isLoadingDirectory = true;

    // Restore explorer state first (only on initial load)
    if (!get().rootPath || get().rootPath !== path) {
      await get().restoreExplorer();
    }

    // Preserve current expanded folders
    const currentExpanded = get().expandedFolders;
    set({ isLoading: true });

    try {
      const entries = await readDirectory(path);
      
      // Only load 1 level deep eagerly, rest on-demand
      const buildTree = async (_dirPath: string, entries: Awaited<ReturnType<typeof readDirectory>>, depth: number = 0): Promise<FileNode[]> => {
        const nodes: FileNode[] = [];
        const maxEagerDepth = 1;

        for (const entry of entries) {
          if (entry.is_dir) {
            let children: FileNode[] = [];
            const isExpanded = currentExpanded.has(entry.path);
            const shouldLoadChildren = depth < maxEagerDepth || isExpanded;
            
            if (shouldLoadChildren) {
              try {
                const childEntries = await readDirectory(entry.path);
                children = await buildTree(entry.path, childEntries, depth + 1);
              } catch {
                children = [];
              }
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

      const children = await buildTree(path, entries, 0);
      const newExpanded = new Set([...currentExpanded, path]);

      set({
        files: children,
        expandedFolders: newExpanded,
        isLoading: false
      });
    } catch (err) {
      console.error('Failed to load directory:', err);
      set({ isLoading: false });
    } finally {
      isLoadingDirectory = false;
      
      if (pendingLoadPath && pendingLoadPath !== path) {
        const nextPath = pendingLoadPath;
        pendingLoadPath = null;
        get().loadDirectory(nextPath);
      } else {
        pendingLoadPath = null;
      }
    }
  },

  refreshDirectory: async () => {
    const { rootPath } = get();
    if (rootPath) {
      await get().loadDirectory(rootPath);
    }
  },

  toggleFolder: async (folderId) => {
    const state = get();
    const newExpanded = new Set(state.expandedFolders);
    const isExpanding = !newExpanded.has(folderId);
    
    if (isExpanding) {
      newExpanded.add(folderId);
    } else {
      newExpanded.delete(folderId);
    }
    
    set({ expandedFolders: newExpanded });
    // NO saveExplorer() here - save only on window close
    
    // If expanding, load children on-demand
    if (isExpanding) {
      const findFolder = (nodes: FileNode[]): FileNode | null => {
        for (const node of nodes) {
          if (node.id === folderId) return node;
          if (node.children) {
            const found = findFolder(node.children);
            if (found) return found;
          }
        }
        return null;
      };
      
      const folder = findFolder(state.files);
      if (folder && folder.type === 'folder' && (!folder.children || folder.children.length === 0)) {
        try {
          const childEntries = await readDirectory(folderId);
          const children: FileNode[] = childEntries.map(entry => ({
            id: entry.path,
            name: entry.name,
            type: entry.is_dir ? 'folder' as const : 'file' as const,
            path: entry.path,
            children: entry.is_dir ? [] : undefined,
            language: entry.is_file ? getLanguageFromExtension(entry.name) : undefined,
          }));
          
          const updateTree = (nodes: FileNode[]): FileNode[] => {
            return nodes.map(node => {
              if (node.id === folderId) {
                return { ...node, children };
              }
              if (node.children) {
                return { ...node, children: updateTree(node.children) };
              }
              return node;
            });
          };
          
          set({ files: updateTree(get().files) });
        } catch (err) {
          console.error('Failed to load folder children:', err);
        }
      }
    }
  },

  expandFolder: async (folderId) => {
    const state = get();
    const newExpanded = new Set(state.expandedFolders);
    const wasExpanded = newExpanded.has(folderId);
    newExpanded.add(folderId);
    
    set({ expandedFolders: newExpanded });
    // NO saveExplorer() here - save only on window close
    
    if (!wasExpanded) {
      const findFolder = (nodes: FileNode[]): FileNode | null => {
        for (const node of nodes) {
          if (node.id === folderId) return node;
          if (node.children) {
            const found = findFolder(node.children);
            if (found) return found;
          }
        }
        return null;
      };
      
      const folder = findFolder(state.files);
      if (folder && folder.type === 'folder' && (!folder.children || folder.children.length === 0)) {
        try {
          const childEntries = await readDirectory(folderId);
          const children: FileNode[] = childEntries.map(entry => ({
            id: entry.path,
            name: entry.name,
            type: entry.is_dir ? 'folder' as const : 'file' as const,
            path: entry.path,
            children: entry.is_dir ? [] : undefined,
            language: entry.is_file ? getLanguageFromExtension(entry.name) : undefined,
          }));
          
          const updateTree = (nodes: FileNode[]): FileNode[] => {
            return nodes.map(node => {
              if (node.id === folderId) {
                return { ...node, children };
              }
              if (node.children) {
                return { ...node, children: updateTree(node.children) };
              }
              return node;
            });
          };
          
          set({ files: updateTree(get().files) });
        } catch (err) {
          console.error('Failed to load folder children:', err);
        }
      }
    }
  },

  selectFile: (fileId) => {
    set({ selectedFileId: fileId });
    // NO saveExplorer() here - save only on window close
  },

  // Reveal a file in the explorer: expand parent folders and select it
  revealFile: (filePath) => {
    const { rootPath, expandedFolders } = get();
    if (!filePath || !rootPath) return;

    // Normalize path separators
    const normalizedPath = filePath.replace(/\\/g, '/');
    const normalizedRoot = rootPath.replace(/\\/g, '/');

    // Check if the file is within the workspace
    if (!normalizedPath.startsWith(normalizedRoot)) return;

    // Get the relative path and extract parent folders
    const relativePath = normalizedPath.slice(normalizedRoot.length);
    const parts = relativePath.split('/').filter(Boolean);
    
    // Build list of parent folder paths to expand
    const newExpanded = new Set(expandedFolders);
    let currentPath = rootPath;
    
    // Expand each parent folder (excluding the file itself)
    for (let i = 0; i < parts.length - 1; i++) {
      currentPath = currentPath + (currentPath.endsWith('/') || currentPath.endsWith('\\') ? '' : '/') + parts[i];
      // Normalize to match how paths are stored
      const normalizedCurrentPath = currentPath.replace(/\//g, '\\');
      newExpanded.add(normalizedCurrentPath);
      newExpanded.add(currentPath); // Add both variants
    }

    set({ 
      expandedFolders: newExpanded,
      selectedFileId: filePath 
    });
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

  // Restore explorer state from database (called once on load)
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

  // Save explorer state to database (called ONLY on window close)
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

// Guard to prevent multiple simultaneous loadDirectory calls
let isLoadingDirectory = false;
let pendingLoadPath: string | null = null;

// Track last set root path to prevent duplicate setRootPath calls
let lastSetRootPath: string | null = null;
