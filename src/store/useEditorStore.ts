import { create } from 'zustand';
import type { Tab } from '../types';
import { databaseService } from '../services/database';
import type { WorkspaceState as DbWorkspaceState, TabState, PanelSizes } from '../types/database';
import { writeFileContent, isTauri } from '../lib/tauri';

interface EditorState {
  tabs: Tab[];
  activeTabId: string | null;
  fontSize: number;

  // Actions
  openFile: (fileId: string, filename: string, content: string, language?: string) => void;
  closeTab: (tabId: string) => void;
  setActiveTab: (tabId: string) => void;
  updateTabContent: (tabId: string, content: string) => void;
  reloadTabContent: (tabId: string, content: string) => void;
  setFontSize: (size: number) => void;
  saveTabToDisk: (tabId: string) => Promise<void>;

  // Database actions
  restoreWorkspace: () => Promise<void>;
  saveWorkspace: () => Promise<void>;
  setWorkspacePath: (path: string | null) => void;
  setPanelSizes: (sizes: PanelSizes) => void;
}

// Workspace path tracking
let currentWorkspacePath: string | null = null;
let currentPanelSizes: PanelSizes | null = null;

export const useEditorStore = create<EditorState>((set, get) => ({
  tabs: [],
  activeTabId: null,
  fontSize: 14,

  openFile: (fileId, filename, content, language = 'typescript') => {
    const { tabs, setActiveTab } = get();
    const existingTab = tabs.find(t => t.id === fileId);

    if (existingTab) {
      setActiveTab(fileId);
      return;
    }

    const newTab: Tab = {
      id: fileId,
      path: fileId,
      filename,
      content,
      isDirty: false,
      language
    };

    set({ tabs: [...tabs, newTab], activeTabId: fileId });

    // PERFORMANCE: Preload sibling files in background for faster subsequent opens
    // This makes clicking between files in the same folder instant
    queueMicrotask(async () => {
      try {
        const { preloadFiles } = await import('../lib/file-cache');
        const { useWorkspaceStore } = await import('./useWorkspaceStore');
        const { files } = useWorkspaceStore.getState();

        // Find the parent folder and preload siblings
        const dir = fileId.substring(0, fileId.lastIndexOf(fileId.includes('\\') ? '\\' : '/'));
        const findSiblings = (nodes: typeof files): string[] => {
          for (const node of nodes) {
            if (node.path === dir && node.children) {
              return node.children
                .filter(c => c.type === 'file' && c.path !== fileId && c.path)
                .slice(0, 5) // Preload up to 5 siblings
                .map(c => c.path!);
            }
            if (node.children) {
              const found = findSiblings(node.children);
              if (found.length) return found;
            }
          }
          return [];
        };

        const siblings = findSiblings(files);
        if (siblings.length > 0) {
          preloadFiles(siblings);
        }
      } catch {
        // Ignore preload errors - this is just an optimization
      }
    });
    // NO saveWorkspace() here - save only on window close
  },

  closeTab: (tabId) => {
    const { tabs, activeTabId } = get();
    const newTabs = tabs.filter(t => t.id !== tabId);

    let newActiveId = activeTabId;
    if (activeTabId === tabId) {
      newActiveId = newTabs.length > 0 ? newTabs[newTabs.length - 1].id : null;
    }

    set({ tabs: newTabs, activeTabId: newActiveId });
    // NO saveWorkspace() here - save only on window close
  },

  setActiveTab: (tabId) => {
    set({ activeTabId: tabId });
    // NO saveWorkspace() here - save only on window close
  },

  updateTabContent: (tabId, content) => set(state => ({
    tabs: state.tabs.map(tab =>
      tab.id === tabId
        ? { ...tab, content, isDirty: true }
        : tab
    )
  })),

  // Reload content from external source (e.g., fs watcher) - doesn't mark dirty
  reloadTabContent: (tabId, content) => {
    return set(state => ({
      tabs: state.tabs.map(tab =>
        tab.id === tabId
          ? { ...tab, content, isDirty: false }
          : tab
      )
    }));
  },

  setFontSize: (fontSize) => set({ fontSize }),

  saveTabToDisk: async (tabId) => {
    const state = get();
    const tab = state.tabs.find((t) => t.id === tabId);
    if (!tab) return;

    if (!tab.path) {
      console.warn('No path associated with tab, skipping save:', tabId);
      return;
    }

    if (!isTauri()) {
      console.warn('File saving is only available in the desktop app.');
      return;
    }

    try {
      await writeFileContent(tab.path, tab.content);
      set((current) => ({
        tabs: current.tabs.map((t) =>
          t.id === tabId ? { ...t, isDirty: false } : t
        ),
      }));
      // NO saveWorkspace() here - save only on window close
    } catch (error) {
      console.error('Failed to save file:', error);
    }
  },

  setWorkspacePath: (path) => {
    currentWorkspacePath = path;
    // NO saveWorkspace() here - save only on window close
  },

  setPanelSizes: (sizes) => {
    currentPanelSizes = sizes;
  },

  // Restore workspace state from database (called once on load)
  restoreWorkspace: async () => {
    try {
      const state = await databaseService.getWorkspaceState();
      if (state && state.open_tabs.length > 0) {
        currentWorkspacePath = state.workspace_path;
        currentPanelSizes = state.panel_sizes;

        // Language detection helper
        const detectLanguage = (filename: string): string => {
          const ext = filename.split('.').pop()?.toLowerCase() || '';
          const langMap: Record<string, string> = {
            'ts': 'typescript', 'tsx': 'typescript',
            'js': 'javascript', 'jsx': 'javascript',
            'json': 'json', 'css': 'css', 'scss': 'scss',
            'html': 'html', 'md': 'markdown',
            'rs': 'rust', 'toml': 'toml',
            'yaml': 'yaml', 'yml': 'yaml',
            'py': 'python', 'go': 'go',
            'txt': 'plaintext',
          };
          return langMap[ext] || 'plaintext';
        };

        // PERFORMANCE: Use batch file reading - single IPC call for all files
        const { readFilesBatch } = await import('../lib/file-cache');
        const paths = state.open_tabs.map(tab => tab.path);
        const contentMap = await readFilesBatch(paths);

        // Build tabs with batch-loaded content
        const tabs: Tab[] = state.open_tabs.map((tab) => {
          const filename = tab.path.split(/[/\\]/).pop() || tab.path;
          const content = contentMap.get(tab.path) || '';
          return {
            id: tab.path,
            path: tab.path,
            filename,
            content,
            isDirty: tab.is_dirty,
            language: detectLanguage(filename),
          };
        });

        const activeTab = state.open_tabs.find(t => t.is_active);
        const activeTabId = activeTab?.path || (tabs.length > 0 ? tabs[0].id : null);

        set({ tabs, activeTabId });
      }
    } catch (error) {
      console.error('Failed to restore workspace:', error);
    }
  },

  // Save workspace state to database (called ONLY on window close)
  saveWorkspace: async () => {
    try {
      const { tabs, activeTabId } = get();

      // Convert store tabs to database tabs
      const tabStates: TabState[] = tabs.map(tab => ({
        path: tab.path,
        is_active: tab.id === activeTabId,
        is_dirty: tab.isDirty,
      }));

      const workspaceState: DbWorkspaceState = {
        workspace_path: currentWorkspacePath,
        open_tabs: tabStates,
        panel_sizes: currentPanelSizes,
        last_opened_at: new Date().toISOString(),
      };

      await databaseService.saveWorkspaceState(workspaceState);
    } catch (error) {
      console.error('Failed to save workspace:', error);
    }
  },
}));

// Subscribe to activeTabId changes and reveal the file in explorer
let previousActiveTabId: string | null = null;
useEditorStore.subscribe((state) => {
  const { activeTabId, tabs } = state;
  if (activeTabId && activeTabId !== previousActiveTabId) {
    previousActiveTabId = activeTabId;
    // Find the tab to get its path
    const tab = tabs.find(t => t.id === activeTabId);
    if (tab?.path) {
      // Dynamically import to avoid circular dependency
      import('./useWorkspaceStore').then(({ useWorkspaceStore }) => {
        useWorkspaceStore.getState().revealFile(tab.path);
      });
    }
  }
});
