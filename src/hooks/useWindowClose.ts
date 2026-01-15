import { useEffect, useRef } from "react";

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
  const tauriUnlistenRef = useRef<(() => void) | null>(null);
  const isListenerSetup = useRef(false);

  useEffect(() => {
    const saveAllState = async () => {
      console.log('[WindowClose] Saving all state before close...');
      
      try {
        // Save explorer state (expanded folders, selected file)
        await useWorkspaceStore.getState().saveExplorer();
        
        // Save workspace state (open tabs, panel sizes, workspace path)
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

    // Setup Tauri window close event listener
    const setupTauriListener = async () => {
      if (!isTauri() || isListenerSetup.current) return;
      isListenerSetup.current = true;
      
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        const currentWindow = getCurrentWindow();

        if (currentWindow.label !== 'main') {
          return;
        }
        
        const unlisten = await currentWindow.onCloseRequested(async () => {
          console.log('[WindowClose] Tauri close requested');
          await saveAllState();
          await currentWindow.close();
        });
        
        tauriUnlistenRef.current = unlisten;
        console.log('[WindowClose] Tauri close listener registered');
      } catch (error) {
        console.error('[WindowClose] Failed to setup Tauri listener:', error);
      }
    };


    // Setup listeners
    window.addEventListener('beforeunload', handleBeforeUnload);
    setupTauriListener();

    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
      if (tauriUnlistenRef.current) {
        tauriUnlistenRef.current();
      }
    };
  }, []);
};
