import { useEffect } from "react";

import { isTauri } from "../lib/tauri";
import { useEditorStore } from "../store/useEditorStore";
import { useThreadStore } from "../store/useThreadStore";
import { useWorkspaceStore } from "../store/useWorkspaceStore";

/**
 * Hook to save all state when window closes.
 * This is the ONLY place where explorer/workspace state is saved to DB.
 * Following VS Code's pattern: keep in memory, save on exit.
 */
export const useWindowClose = () => {
  useEffect(() => {
    const saveAllState = async () => {
      console.log('[WindowClose] Saving all state before close...');
      
      try {
        // Save explorer state (expanded folders, selected file)
        await useWorkspaceStore.getState().saveExplorer();
        
        // Save workspace state (open tabs, panel sizes)
        await useEditorStore.getState().saveWorkspace();
        
        // Save current thread if any
        await useThreadStore.getState().saveCurrentThread();
        
        console.log('[WindowClose] All state saved successfully');
      } catch (error) {
        console.error('[WindowClose] Failed to save state:', error);
      }
    };

    // Browser beforeunload event
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      // Trigger async save (may not complete in time, but try)
      saveAllState();
      
      // Only show confirmation if there are dirty tabs
      const dirtyTabs = useEditorStore.getState().tabs.filter(t => t.isDirty);
      if (dirtyTabs.length > 0) {
        e.preventDefault();
        e.returnValue = '';
        return '';
      }
    };

    // Tauri window close event
    let tauriUnlisten: (() => void) | null = null;
    
    if (isTauri()) {
      import('@tauri-apps/api/event').then(({ listen }) => {
        // Listen for Tauri close request
        listen('tauri://close-requested', async () => {
          await saveAllState();
          // Allow the window to close
          import('@tauri-apps/api/window').then(({ getCurrentWindow }) => {
            getCurrentWindow().close();
          });
        }).then(unlisten => {
          tauriUnlisten = unlisten;
        });
      });
    }

    window.addEventListener('beforeunload', handleBeforeUnload);

    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
      if (tauriUnlisten) {
        tauriUnlisten();
      }
    };
  }, []);
};
