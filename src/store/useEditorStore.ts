import { create } from "zustand";

import { getLanguageFromExtension } from "../lib/file-utils";
import { isTauri, writeFileContent } from "../lib/tauri";
import { databaseService } from "../services/database";
import type { Tab } from "../types";
import type {
  WorkspaceState as DbWorkspaceState,
  PanelSizes,
  TabState,
} from "../types/database";
import { useCheckpointStore } from "./useCheckpointStore";

interface EditorState {
  activeTabId: string | null;
  closeTab: (tabId: string, options?: { skipUnsavedWarning?: boolean }) => void;
  fontSize: number;

  // Mark tab as deleted (file was removed from filesystem)
  markTabAsDeleted: (tabId: string) => void;

  // Browser tab actions
  openBrowserTab: (url?: string) => void;

  // Actions
  openFile: (
    fileId: string,
    filename: string,
    content: string,
    language?: string,
    isLoading?: boolean,
  ) => void;
  reloadTabContent: (
    tabId: string,
    content: string,
    isLoading?: boolean,
  ) => void;
  requestEditorReveal: (
    tabId: string,
    request: Omit<EditorRevealRequest, "requestId" | "tabId">,
  ) => void;

  // Database actions
  restoreWorkspace: () => Promise<void>;
  saveTabToDisk: (tabId: string) => Promise<void>;
  saveWorkspace: () => Promise<void>;
  setActiveTab: (tabId: string) => void;
  setFontSize: (size: number) => void;
  setPanelSizes: (sizes: PanelSizes) => void;
  setWorkspacePath: (path: string | null) => void;
  editorRevealRequest: EditorRevealRequest | null;
  tabs: Tab[];
  updateBrowserTab: (
    tabId: string,
    updates: Partial<
      Pick<Tab, "url" | "filename" | "favicon" | "canGoBack" | "canGoForward">
    >,
  ) => void;
  updateTabContent: (tabId: string, content: string) => void;
}

export interface EditorRevealRequest {
  column?: number;
  focus?: boolean;
  lineNumber?: number;
  mode: "bottom" | "line";
  requestId: number;
  tabId: string;
}

// Workspace path tracking
let currentWorkspacePath: string | null = null;
let currentPanelSizes: PanelSizes | null = null;
let nextRevealRequestId = 1;

// File size thresholds for performance optimization (shared constants)
const LARGE_FILE_THRESHOLD = 100 * 1024; // 100KB - disable most features, use plaintext
const MEDIUM_FILE_THRESHOLD = 50 * 1024; // 50KB - disable some features but keep syntax highlighting

export const useEditorStore = create<EditorState>((set, get) => ({
  tabs: [],
  activeTabId: null,
  editorRevealRequest: null,
  fontSize: 14,

  openFile: (fileId, filename, content, language, isLoading = false) => {
    const { tabs, setActiveTab, reloadTabContent } = get();
    const existingTab = tabs.find((t) => t.id === fileId);

    if (existingTab) {
      // Empty files can legitimately resolve to '' after a loading placeholder,
      // so clear the loading state even when the content itself did not change.
      if (
        existingTab.content !== content ||
        existingTab.isLoading !== isLoading
      ) {
        reloadTabContent(fileId, content, isLoading);
      }
      setActiveTab(fileId);
      return;
    }

    const isLargeFile = content.length > LARGE_FILE_THRESHOLD;
    const isMediumFile = !isLargeFile && content.length > MEDIUM_FILE_THRESHOLD;
    const resolvedLanguage = language || getLanguageFromExtension(filename);
    const effectiveLanguage = isLargeFile ? "plaintext" : resolvedLanguage;
    const newTab: Tab = {
      id: fileId,
      path: fileId,
      filename,
      content,
      isDirty: false,
      isLargeFile,
      isMediumFile,
      isLoading,
      language: effectiveLanguage,
    };

    set({ tabs: [...tabs, newTab], activeTabId: fileId });

    if (!isLargeFile) {
      // Initialize undo/redo tracking for this file
      queueMicrotask(async () => {
        try {
          const { undoRedoService } = await import("../services/undo-redo");
          await undoRedoService.initFile(fileId, content);
        } catch {
          // Ignore undo init errors
        }
      });

      // PERFORMANCE: Preload sibling files in background for faster subsequent opens
      // This makes clicking between files in the same folder instant
      queueMicrotask(async () => {
        try {
          const { preloadFiles } = await import("../lib/file-cache");
          const { useWorkspaceStore } = await import("./useWorkspaceStore");
          const { files } = useWorkspaceStore.getState();

          // Find the parent folder and preload siblings
          const dir = fileId.substring(
            0,
            fileId.lastIndexOf(fileId.includes("\\") ? "\\" : "/"),
          );
          const findSiblings = (nodes: typeof files): string[] => {
            for (const node of nodes) {
              if (node.path === dir && node.children) {
                return node.children
                  .filter(
                    (c) => c.type === "file" && c.path !== fileId && c.path,
                  )
                  .slice(0, 5) // Preload up to 5 siblings
                  .map((c) => c.path!);
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
    }
    // NO saveWorkspace() here - save only on window close
  },

  closeTab: (tabId) => {
    const { tabs, activeTabId } = get();
    const tabToClose = tabs.find((tab) => tab.id === tabId);
    if (!tabToClose) return;

    const newTabs = tabs.filter((t) => t.id !== tabId);

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

  updateTabContent: (tabId, content) =>
    set((state) => ({
      tabs: state.tabs.map((tab) => {
        if (tab.id !== tabId) return tab;
        const isLargeFile = content.length > LARGE_FILE_THRESHOLD;
        const isMediumFile =
          !isLargeFile && content.length > MEDIUM_FILE_THRESHOLD;
        return {
          ...tab,
          content,
          isDirty: true,
          isLargeFile,
          isMediumFile,
          language: isLargeFile ? "plaintext" : tab.language,
        };
      }),
    })),

  // Reload content from external source (e.g., fs watcher) - doesn't mark dirty
  reloadTabContent: (tabId, content, isLoading = false) => {
    return set((state) => ({
      tabs: state.tabs.map((tab) => {
        if (tab.id !== tabId) return tab;
        const isLargeFile = content.length > LARGE_FILE_THRESHOLD;
        const isMediumFile =
          !isLargeFile && content.length > MEDIUM_FILE_THRESHOLD;
        return {
          ...tab,
          content,
          isDirty: false,
          isDeleted: false, // File exists again, clear deleted flag
          isLargeFile,
          isMediumFile,
          isLoading,
          language: isLargeFile ? "plaintext" : tab.language,
        };
      }),
    }));
  },

  requestEditorReveal: (tabId, request) => {
    set({
      editorRevealRequest: {
        ...request,
        tabId,
        requestId: nextRevealRequestId++,
      },
    });
  },

  // Mark a tab as deleted when the underlying file is removed from filesystem
  markTabAsDeleted: (tabId) => {
    set((state) => ({
      tabs: state.tabs.map((tab) =>
        tab.id === tabId ? { ...tab, isDeleted: true } : tab,
      ),
    }));
  },

  setFontSize: (fontSize) => set({ fontSize }),

  // Browser tab actions
  openBrowserTab: (url = "about:blank") => {
    const tabId = `browser-${Date.now()}`;
    const filename =
      url === "about:blank"
        ? "New Browser"
        : (() => {
            try {
              const parsed = new URL(url);
              if (
                parsed.hostname === "localhost" ||
                parsed.hostname === "127.0.0.1"
              ) {
                return `localhost:${parsed.port || "80"}`;
              }
              return parsed.hostname;
            } catch {
              return "Browser";
            }
          })();

    const newTab: Tab = {
      id: tabId,
      path: tabId,
      filename,
      content: "",
      isDirty: false,
      language: "browser",
      type: "browser",
      url,
      canGoBack: false,
      canGoForward: false,
    };

    set((state) => ({
      tabs: [...state.tabs, newTab],
      activeTabId: tabId,
    }));
  },

  updateBrowserTab: (tabId, updates) => {
    set((state) => ({
      tabs: state.tabs.map((tab) =>
        tab.id === tabId ? { ...tab, ...updates } : tab,
      ),
    }));
  },

  saveTabToDisk: async (tabId) => {
    const state = get();
    const tab = state.tabs.find((t) => t.id === tabId);
    if (!tab) return;

    if (!tab.path) {
      console.warn("No path associated with tab, skipping save:", tabId);
      return;
    }

    if (!isTauri()) {
      console.warn("File saving is only available in the desktop app.");
      return;
    }

    try {
      await writeFileContent(tab.path, tab.content);
      set((current) => ({
        tabs: current.tabs.map((t) =>
          t.id === tabId ? { ...t, isDirty: false } : t,
        ),
      }));
      // NO saveWorkspace() here - save only on window close
    } catch (error) {
      console.error("Failed to save file:", error);
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
      if (state) {
        // Always set workspace path and panel sizes from saved state
        currentWorkspacePath = state.workspace_path;
        currentPanelSizes = state.panel_sizes;
      }

      // Only restore tabs if there are any
      if (state && state.open_tabs.length > 0) {
        // PERFORMANCE: Use batch file reading - single IPC call for all files
        const { readFilesBatch } = await import("../lib/file-cache");
        const paths = state.open_tabs.map((tab) => tab.path);
        const contentMap = await readFilesBatch(paths);

        // Build tabs with batch-loaded content
        const tabs: Tab[] = state.open_tabs.map((tab) => {
          const filename = tab.path.split(/[/\\]/).pop() || tab.path;
          const content = contentMap.get(tab.path) || "";
          return {
            id: tab.path,
            path: tab.path,
            filename,
            content,
            isDirty: tab.is_dirty,
            language: getLanguageFromExtension(filename),
          };
        });

        const activeTab = state.open_tabs.find((t) => t.is_active);
        const activeTabId =
          activeTab?.path || (tabs.length > 0 ? tabs[0].id : null);

        set({ tabs, activeTabId });
      }
    } catch (error) {
      console.error("Failed to restore workspace:", error);
    }
  },

  // Save workspace state to database (called ONLY on window close)
  saveWorkspace: async () => {
    try {
      // Don't save if no workspace is open - prevents saving null workspace_path
      // which would corrupt the "most recent workspace" query
      if (!currentWorkspacePath) {
        return;
      }

      const { tabs, activeTabId } = get();

      // Convert store tabs to database tabs (filter out browser tabs)
      const tabStates: TabState[] = tabs
        .filter((tab) => tab.type !== "browser" && tab.path)
        .map((tab) => ({
          path: tab.path,
          is_active: tab.id === activeTabId,
          is_dirty: tab.isDirty,
        }));

      const checkpointStore = useCheckpointStore.getState();
      const checkpointEnabled =
        checkpointStore.workspacePath === currentWorkspacePath
          ? checkpointStore.enabled
          : (await databaseService.getWorkspaceState(currentWorkspacePath))
              ?.checkpoint_enabled ?? true;

      const workspaceState: DbWorkspaceState = {
        workspace_path: currentWorkspacePath,
        open_tabs: tabStates,
        panel_sizes: currentPanelSizes,
        last_opened_at: new Date().toISOString(),
        checkpoint_enabled: checkpointEnabled,
      };

      await databaseService.saveWorkspaceState(workspaceState);
    } catch (error) {
      console.error("Failed to save workspace:", error);
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
    const tab = tabs.find((t) => t.id === activeTabId);
    if (tab?.path) {
      // Dynamically import to avoid circular dependency
      import("./useWorkspaceStore").then(({ useWorkspaceStore }) => {
        const workspaceStore = useWorkspaceStore.getState();
        if (workspaceStore.selectedFileId === tab.path) {
          return;
        }

        workspaceStore.revealFile(tab.path);
      });
    }
  }
});
