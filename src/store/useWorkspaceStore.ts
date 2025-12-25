import { create } from 'zustand';
import type { FileNode } from '../types';
import { isTauri, readDirectory, readFileContent } from '../lib/tauri';

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
    get().loadDirectory(path);
  },
  
  loadDirectory: async (path: string) => {
    if (!isTauri()) {
      console.log('Not in Tauri environment');
      return;
    }

    // Preserve current expanded folders
    const currentExpanded = get().expandedFolders;
    set({ isLoading: true });

    try {
      const entries = await readDirectory(path);
      const folderName = path.split(/[/\\]/).pop() || 'workspace';
      
      const buildTree = async (dirPath: string, entries: Awaited<ReturnType<typeof readDirectory>>): Promise<FileNode[]> => {
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
    return { expandedFolders: newExpanded };
  }),

  expandFolder: (folderId) => set((state) => {
    const newExpanded = new Set(state.expandedFolders);
    newExpanded.add(folderId);
    return { expandedFolders: newExpanded };
  }),
  
  selectFile: (fileId) => set({ selectedFileId: fileId }),
  
  setFiles: (files) => set({ files }),

  clearWorkspace: () => set({ 
    rootPath: '', 
    files: [], 
    expandedFolders: new Set(),
    selectedFileId: null 
  }),
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
