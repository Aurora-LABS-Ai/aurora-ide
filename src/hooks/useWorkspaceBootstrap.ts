import { useEffect, useRef } from "react";

import { isTauri } from "../lib/tauri";
import { databaseService } from "../services/database";
import { useWorkspaceStore } from "../store/useWorkspaceStore";

/**
 * Automatically initializes the workspace store with the saved workspace
 * from the database when running inside Tauri.
 * 
 * This hook restores the FILE EXPLORER (rootPath) from the most recently
 * opened workspace. The useEditorStore.restoreWorkspace() handles restoring
 * open TABS separately.
 */
export const useWorkspaceBootstrap = (): void => {
  const { rootPath, setRootPath } = useWorkspaceStore();
  const hasInitialized = useRef(false);

  useEffect(() => {
    if (!isTauri()) return;
    if (hasInitialized.current) return; // Only run once
    if (rootPath) return; // Already has a path

    hasInitialized.current = true;

    // Try to restore the last opened workspace from database
    const restoreWorkspaceFromDb = async () => {
      try {
        const savedState = await databaseService.getWorkspaceState();
        if (savedState?.workspace_path) {
          // Restore the previously opened workspace
          console.log('[WorkspaceBootstrap] Restoring workspace:', savedState.workspace_path);
          setRootPath(savedState.workspace_path);
        } else {
          console.log('[WorkspaceBootstrap] No saved workspace found');
        }
        // If no saved workspace, don't auto-open anything - let user choose
      } catch (error) {
        console.error('[WorkspaceBootstrap] Failed to restore workspace from database:', error);
      }
    };

    restoreWorkspaceFromDb();
  }, [rootPath, setRootPath]);
};
