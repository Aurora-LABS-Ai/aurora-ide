/**
 * Undo/Redo Keyboard Shortcuts Hook
 *
 * Handles Ctrl+Z (undo) and Ctrl+Y/Ctrl+Shift+Z (redo) shortcuts
 * for the active file in the editor.
 *
 * Note: Monaco Editor handles its own keystroke-level undo/redo internally.
 * This hook handles undo/redo for programmatic changes (AI edits).
 */

import { useEffect, useCallback } from 'react';
import { useEditorStore } from '../store/useEditorStore';
import { useUndoRedoStore } from '../store/useUndoRedoStore';

/**
 * Hook to handle undo/redo keyboard shortcuts
 * @param enabled Whether shortcuts are enabled (disable when focused on text inputs)
 */
export function useUndoRedoShortcuts(enabled = true) {
  const { activeTabId, tabs, reloadTabContent } = useEditorStore();
  const { undo, redo, canUndo, canRedo } = useUndoRedoStore();

  const activeTab = tabs.find(t => t.id === activeTabId);
  const activeFilePath = activeTab?.path || null;

  const handleUndo = useCallback(async () => {
    if (!activeFilePath) return;
    
    // Check if we can undo programmatic changes
    if (!canUndo(activeFilePath)) {
      // Let Monaco handle its own undo
      return;
    }

    const content = await undo(activeFilePath);
    if (content !== null && activeTabId) {
      // Update editor content
      reloadTabContent(activeTabId, content);
    }
  }, [activeFilePath, activeTabId, canUndo, undo, reloadTabContent]);

  const handleRedo = useCallback(async () => {
    if (!activeFilePath) return;
    
    // Check if we can redo programmatic changes
    if (!canRedo(activeFilePath)) {
      // Let Monaco handle its own redo
      return;
    }

    const content = await redo(activeFilePath);
    if (content !== null && activeTabId) {
      // Update editor content
      reloadTabContent(activeTabId, content);
    }
  }, [activeFilePath, activeTabId, canRedo, redo, reloadTabContent]);

  useEffect(() => {
    if (!enabled) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      // Check if user is typing in an input/textarea (let those handle their own undo)
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') {
        return;
      }

      // Ctrl+Z or Cmd+Z for undo
      if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
        // Don't prevent default - let Monaco try its undo first
        // Our undo will only activate if there are programmatic changes
        handleUndo();
        return;
      }

      // Ctrl+Y or Cmd+Y or Ctrl+Shift+Z or Cmd+Shift+Z for redo
      if (
        ((e.ctrlKey || e.metaKey) && e.key === 'y') ||
        ((e.ctrlKey || e.metaKey) && e.key === 'z' && e.shiftKey)
      ) {
        // Don't prevent default - let Monaco try its redo first
        handleRedo();
        return;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [enabled, handleUndo, handleRedo]);

  return {
    handleUndo,
    handleRedo,
    canUndo: activeFilePath ? canUndo(activeFilePath) : false,
    canRedo: activeFilePath ? canRedo(activeFilePath) : false,
  };
}

