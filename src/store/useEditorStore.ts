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
    // Auto-save workspace state
    get().saveWorkspace();
  },

  closeTab: (tabId) => {
    const { tabs, activeTabId } = get();
    const newTabs = tabs.filter(t => t.id !== tabId);

    let newActiveId = activeTabId;
    if (activeTabId === tabId) {
      newActiveId = newTabs.length > 0 ? newTabs[newTabs.length - 1].id : null;
    }

    set({ tabs: newTabs, activeTabId: newActiveId });
    // Auto-save workspace state
    get().saveWorkspace();
  },

  setActiveTab: (tabId) => {
    set({ activeTabId: tabId });
    // Auto-save workspace state
    get().saveWorkspace();
  },

  updateTabContent: (tabId, content) => set(state => ({
    tabs: state.tabs.map(tab =>
      tab.id === tabId
        ? { ...tab, content, isDirty: true }
        : tab
    )
  })),

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
      get().saveWorkspace();
    } catch (error) {
      console.error('Failed to save file:', error);
    }
  },

  setWorkspacePath: (path) => {
    currentWorkspacePath = path;
    // Save workspace state immediately when path changes
    get().saveWorkspace();
  },

  setPanelSizes: (sizes) => {
    currentPanelSizes = sizes;
  },

  // Restore workspace state from database
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

        // Import readFileContent dynamically to avoid circular imports
        const { readFileContent } = await import('../lib/tauri');

        // Load file content for each tab
        const tabs: Tab[] = await Promise.all(
          state.open_tabs.map(async (tab) => {
            const filename = tab.path.split(/[/\\]/).pop() || tab.path;
            let content = '';
            try {
              content = await readFileContent(tab.path);
            } catch (err) {
              console.warn('Failed to load file content:', tab.path, err);
            }
            return {
              id: tab.path,
              path: tab.path,
              filename,
              content,
              isDirty: tab.is_dirty,
              language: detectLanguage(filename),
            };
          })
        );

        const activeTab = state.open_tabs.find(t => t.is_active);
        const activeTabId = activeTab?.path || (tabs.length > 0 ? tabs[0].id : null);

        set({ tabs, activeTabId });
      }
    } catch (error) {
      console.error('Failed to restore workspace:', error);
    }
  },

  // Save workspace state to database
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
