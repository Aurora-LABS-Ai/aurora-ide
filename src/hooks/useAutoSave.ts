import { useEffect, useRef, useCallback } from 'react';
import { useSettingsStore } from '../store/useSettingsStore';
import { useEditorStore } from '../store/useEditorStore';

/**
 * Hook that handles auto-saving files based on the auto-save setting.
 * This hook should be used in the main App or EditorPanel component.
 */
export const useAutoSave = () => {
  const { autoSave, autoSaveDelay } = useSettingsStore();
  const { tabs, saveTabToDisk } = useEditorStore();
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSavedRef = useRef<Map<string, string>>(new Map());

  // Save all dirty tabs
  const saveDirtyTabs = useCallback(async () => {
    const dirtyTabs = tabs.filter(tab => tab.isDirty);
    for (const tab of dirtyTabs) {
      await saveTabToDisk(tab.id);
    }
  }, [tabs, saveTabToDisk]);

  // Save with delay (debounced)
  const scheduleSave = useCallback(() => {
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }
    saveTimeoutRef.current = setTimeout(() => {
      saveDirtyTabs();
    }, autoSaveDelay);
  }, [saveDirtyTabs, autoSaveDelay]);

  // Handle afterDelay mode - save when content changes
  useEffect(() => {
    if (autoSave !== 'afterDelay') return;

    // Check if any tab content has changed
    let hasChanges = false;
    for (const tab of tabs) {
      const lastContent = lastSavedRef.current.get(tab.id);
      if (tab.isDirty && lastContent !== tab.content) {
        hasChanges = true;
        lastSavedRef.current.set(tab.id, tab.content);
      }
    }

    if (hasChanges) {
      scheduleSave();
    }

    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }
    };
  }, [autoSave, tabs, scheduleSave]);

  // Handle focus change mode
  useEffect(() => {
    if (autoSave !== 'onFocusChange') return;

    const handleBlur = () => {
      saveDirtyTabs();
    };

    // Listen for blur events on the editor (when user clicks away from editor)
    document.addEventListener('focusout', handleBlur);

    return () => {
      document.removeEventListener('focusout', handleBlur);
    };
  }, [autoSave, saveDirtyTabs]);

  // Handle window change mode
  useEffect(() => {
    if (autoSave !== 'onWindowChange') return;

    const handleVisibilityChange = () => {
      if (document.hidden) {
        saveDirtyTabs();
      }
    };

    const handleBeforeUnload = () => {
      saveDirtyTabs();
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('beforeunload', handleBeforeUnload);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('beforeunload', handleBeforeUnload);
    };
  }, [autoSave, saveDirtyTabs]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }
    };
  }, []);

  return {
    saveDirtyTabs,
    autoSave,
  };
};
