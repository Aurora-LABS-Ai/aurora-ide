import { useEffect, useRef } from "react";
import { isTauri } from "../lib/tauri";
import { useWorkspaceStore } from "../store/useWorkspaceStore";
import { databaseService } from "../services/database";

/**
 * Automatically initializes the workspace store with the saved workspace
 * from the database when running inside Tauri.
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
    const restoreWorkspace = async () => {
      try {
        const savedState = await databaseService.getWorkspaceState();
        if (savedState?.workspace_path) {
          // Restore the previously opened workspace
          console.log('Restoring workspace:', savedState.workspace_path);
          setRootPath(savedState.workspace_path);
        }
        // If no saved workspace, don't auto-open anything - let user choose
      } catch (error) {
        console.error('Failed to restore workspace from database:', error);
      }
    };

    restoreWorkspace();
  }, [rootPath, setRootPath]);
};
