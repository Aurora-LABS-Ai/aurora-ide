import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";

import {
  explorerClearWorkspace,
  explorerCollapseAll,
  explorerExpandFolder,
  explorerGetState,
  explorerOpenWorkspace,
  explorerRefresh,
  explorerRevealFile,
  explorerSaveState,
  explorerSelectFile,
  explorerToggleFolder,
  isTauri,
  readFileContent,
  type ExplorerSnapshot,
} from "../lib/tauri";
import type { FileNode } from "../types";
import { useEditorStore } from "./useEditorStore";
import { useGitStore } from "./useGitStore";

/**
 * Strip Windows extended-length path prefix (\\?\)
 * This prefix causes issues with shell commands and display
 */
function stripExtendedPathPrefix(path: string): string {
  if (path.startsWith("\\\\?\\")) {
    return path.slice(4);
  }
  return path;
}

interface WorkspaceState {
  clearWorkspace: () => void;
  collapseAll: () => Promise<void>;
  expandFolder: (folderId: string) => Promise<void>;
  expandedFolders: Set<string>;
  files: FileNode[];
  isLoading: boolean;
  loadDirectory: (path: string) => Promise<void>;
  refreshDirectory: () => Promise<void>;

  // Database actions
  restoreExplorer: () => Promise<void>;
  revealFile: (filePath: string) => void;
  rootPath: string;
  saveExplorer: () => Promise<void>;
  selectFile: (fileId: string) => void;
  selectedFileId: string | null;
  setFiles: (files: FileNode[]) => void;

  // Actions
  setRootPath: (path: string) => void;
  toggleFolder: (folderId: string) => Promise<void>;
}

interface FsChangedPayload {
  kind?: string;
  paths?: string[];
}

// Helper to load file content
export const loadFileContent = async (path: string): Promise<string> => {
  if (!isTauri()) {
    return "// File content (desktop app only)";
  }

  try {
    return await readFileContent(path);
  } catch (err) {
    console.error("Failed to load file:", err);
    const message = err instanceof Error ? err.message : String(err);
    return `// Failed to load file: ${message}`;
  }
};

// Global watcher cleanup
let fsUnlisten: (() => void) | null = null;
let explorerUnlisten: (() => void) | null = null;

// Guard to prevent multiple simultaneous loadDirectory calls
let isLoadingDirectory = false;

// Track last set root path to prevent duplicate setRootPath calls
let lastSetRootPath: string | null = null;
let pendingLoadPath: string | null = null;

// Debounce timers for fs-changed events to prevent excessive refreshes
let gitRefreshDebounceTimer: ReturnType<typeof setTimeout> | null = null;
const GIT_REFRESH_DEBOUNCE_MS = 150; // Slightly slower to coalesce file bursts before refreshing git state

const applyExplorerSnapshot = (
  setState: (partial: Partial<WorkspaceState>) => void,
  snapshot: {
    expandedFolders: string[];
    files: FileNode[];
    rootPath: string;
    selectedFile: string | null;
  },
) => {
  setState({
    expandedFolders: new Set(snapshot.expandedFolders),
    files: snapshot.files,
    rootPath: snapshot.rootPath,
    selectedFileId: snapshot.selectedFile,
  });
};

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  rootPath: "",
  files: [],
  expandedFolders: new Set(),
  selectedFileId: null,
  isLoading: false,

  setRootPath: (path) => {
    // CRITICAL: Strip Windows \\?\ prefix that causes shell command failures
    const cleanPath = stripExtendedPathPrefix(path);
    const currentRootPath = get().rootPath;

    // Guard against duplicate setRootPath calls (React Strict Mode, etc.)
    if (currentRootPath === cleanPath && lastSetRootPath === cleanPath) {
      return;
    }
    lastSetRootPath = cleanPath;

    set({ rootPath: cleanPath });

    // Update editor store with workspace path
    useEditorStore.getState().setWorkspacePath(cleanPath);

    // IMMEDIATELY save workspace state to database when workspace is opened
    // This ensures the workspace is persisted even if close event fails
    if (isTauri() && cleanPath) {
      console.log(
        "[WorkspaceStore] Saving workspace path immediately:",
        cleanPath,
      );
      useEditorStore
        .getState()
        .saveWorkspace()
        .catch((err) => {
          console.error("[WorkspaceStore] Failed to save workspace:", err);
        });
    }

    if (isTauri()) {
      const startListening = async () => {
        try {
          if (fsUnlisten) {
            fsUnlisten();
            fsUnlisten = null;
          }

          if (explorerUnlisten) {
            explorerUnlisten();
            explorerUnlisten = null;
          }

          fsUnlisten = await listen<FsChangedPayload>(
            "fs-changed",
            async (event) => {
              const { rootPath } = get();
              if (!rootPath) return;
              const paths: string[] = event.payload?.paths || [];
              const kind: string = event.payload?.kind || "any";
              const hasMatch = paths.some((p) => p.startsWith(rootPath));

              if (hasMatch) {
                if (gitRefreshDebounceTimer) {
                  clearTimeout(gitRefreshDebounceTimer);
                }
                gitRefreshDebounceTimer = setTimeout(async () => {
                  gitRefreshDebounceTimer = null;
                  const gitStore = useGitStore.getState();
                  if (gitStore.isInitialized && gitStore.isGitRepo) {
                    await gitStore.loadStatus();
                  }
                }, GIT_REFRESH_DEBOUNCE_MS);

                // Refresh any open editor tabs that were modified (immediate, no debounce)
                if (kind === "modify" || kind === "create") {
                  const editorStore = useEditorStore.getState();
                  const openTabs = editorStore.tabs;

                  for (const changedPath of paths) {
                    const matchingTab = openTabs.find(
                      (tab) => tab.path === changedPath,
                    );
                    if (matchingTab && !matchingTab.isDirty) {
                      try {
                        const newContent = await readFileContent(changedPath);
                        editorStore.reloadTabContent(
                          matchingTab.id,
                          newContent,
                        );
                      } catch (err) {
                        console.warn(
                          `[fs-changed] Failed to refresh tab ${changedPath}:`,
                          err,
                        );
                      }
                    }
                  }
                }

                // Handle deleted files - mark corresponding tabs as deleted
                if (kind === "remove") {
                  const editorStore = useEditorStore.getState();
                  const openTabs = editorStore.tabs;

                  for (const deletedPath of paths) {
                    const matchingTab = openTabs.find(
                      (tab) => tab.path === deletedPath,
                    );
                    if (matchingTab) {
                      // If tab has unsaved changes, keep it open but mark as deleted
                      // If tab is clean, user can decide to close it
                      editorStore.markTabAsDeleted(matchingTab.id);
                    }
                  }
                }
              }
            },
          );

          explorerUnlisten = await listen<ExplorerSnapshot>(
            "explorer-updated",
            (event) => {
              const { rootPath } = get();
              const snapshot = event.payload;
              if (!rootPath || snapshot.rootPath !== rootPath) {
                return;
              }

              applyExplorerSnapshot(set, snapshot);
            },
          );
        } catch (err) {
          console.error("Failed to start explorer listeners:", err);
        }
      };
      startListening();
    }

    get().loadDirectory(cleanPath);
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
    set({ isLoading: true });

    try {
      const snapshot = await explorerOpenWorkspace(path, true);
      applyExplorerSnapshot(set, snapshot);
      set({ isLoading: false });
    } catch (err) {
      console.error("Failed to load directory:", err);
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
    if (!isTauri()) {
      return;
    }

    try {
      const snapshot = await explorerRefresh();
      applyExplorerSnapshot(set, snapshot);
    } catch (error) {
      console.error("Failed to refresh explorer:", error);
    }
  },

  toggleFolder: async (folderId) => {
    if (!isTauri()) {
      return;
    }

    try {
      const snapshot = await explorerToggleFolder(folderId);
      applyExplorerSnapshot(set, snapshot);
    } catch (error) {
      console.error("Failed to toggle folder:", error);
    }
  },

  expandFolder: async (folderId) => {
    if (!isTauri()) {
      return;
    }

    try {
      const snapshot = await explorerExpandFolder(folderId);
      applyExplorerSnapshot(set, snapshot);
    } catch (error) {
      console.error("Failed to expand folder:", error);
    }
  },

  selectFile: (fileId) => {
    set({ selectedFileId: fileId });

    if (!isTauri()) {
      return;
    }

    explorerSelectFile(fileId).catch((error) => {
      console.error("Failed to sync selected file:", error);
    });
  },

  // Reveal a file in the explorer: expand parent folders and select it
  revealFile: (filePath) => {
    if (!isTauri() || !filePath) {
      return;
    }

    explorerRevealFile(filePath)
      .then((snapshot) => {
        applyExplorerSnapshot(set, snapshot);
      })
      .catch((error) => {
        console.error("Failed to reveal file in explorer:", error);
      });
  },

  collapseAll: async () => {
    if (!isTauri()) {
      return;
    }

    try {
      const snapshot = await explorerCollapseAll();
      applyExplorerSnapshot(set, snapshot);
    } catch (error) {
      console.error("Failed to collapse explorer:", error);
    }
  },

  setFiles: (files) =>
    set({
      files,
    }),

  clearWorkspace: () => {
    lastSetRootPath = null;
    pendingLoadPath = null;
    isLoadingDirectory = false;

    if (gitRefreshDebounceTimer) {
      clearTimeout(gitRefreshDebounceTimer);
      gitRefreshDebounceTimer = null;
    }

    set(
      {
        rootPath: "",
        files: [],
        expandedFolders: new Set(),
        selectedFileId: null,
        isLoading: false,
      },
      false,
    );

    useEditorStore.getState().setWorkspacePath("");

    if (isTauri()) {
      explorerClearWorkspace().catch((error) => {
        console.error("Failed to clear explorer workspace:", error);
      });
    }

    if (fsUnlisten) {
      fsUnlisten();
      fsUnlisten = null;
    }

    if (explorerUnlisten) {
      explorerUnlisten();
      explorerUnlisten = null;
    }
  },

  // Restore explorer state from database (called once on load)
  restoreExplorer: async () => {
    if (!isTauri()) {
      return;
    }

    try {
      const snapshot = await explorerGetState();
      if (snapshot) {
        applyExplorerSnapshot(set, snapshot);
      }
    } catch (error) {
      console.error("Failed to restore explorer state:", error);
    }
  },

  // Save explorer state to database (called ONLY on window close)
  saveExplorer: async () => {
    if (!isTauri()) {
      return;
    }

    try {
      await explorerSaveState();
    } catch (error) {
      console.error("Failed to save explorer state:", error);
    }
  },
}));
