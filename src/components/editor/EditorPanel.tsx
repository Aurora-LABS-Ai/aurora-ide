/**
 * THEME ARCHITECTURE NOTICE:
 * 
 * This project uses a centralized theme system. DO NOT use hardcoded colors.
 * 
 * Instead of:
 *   - Hardcoded hex values: #ff0000, #1a1a1a
 *   - Hardcoded RGB values: rgb(255, 0, 0)
 *   - Tailwind arbitrary colors: bg-[#1a1a1a], text-[#ff0000]
 * 
 * Use theme tokens via CSS variables:
 *   - CSS: var(--aurora-{category}-{token})
 *   - Tailwind: bg-[var(--aurora-editor-background)]
 *   - Component styles: style={{ background: 'var(--aurora-sidebar-background)' }}
 * 
 * Available categories: editor, sidebar, chat, terminal, statusBar, titleBar, common
 * 
 * See: DOCS/theme-dev.md for full token reference
 * See: src/types/theme.ts for TypeScript interfaces
 * See: src/services/theme-service.ts for theme utilities
 */

import React, { useEffect, useCallback, useRef } from 'react';
import { TabBar } from './TabBar';
import { CodeEditor } from './CodeEditor';
import { useSettingsStore } from '../../store/useSettingsStore';
import { useEditorStore } from '../../store/useEditorStore';
import { useDragStore } from '../../store/useDragStore';

export const EditorPanel: React.FC = () => {
  const { autoSave, autoSaveDelay } = useSettingsStore();
  const { tabs, activeTabId, saveTabToDisk } = useEditorStore();
  const { isDragging, dropTargetType } = useDragStore();
  const prevActiveRef = useRef<string | null>(null);

  // Check if editor is the current drop target
  const isDropTarget = isDragging && dropTargetType === 'editor';

  const saveActiveIfDirty = useCallback(() => {
    if (!activeTabId) return;
    const activeTab = tabs.find((tab) => tab.id === activeTabId);
    if (activeTab?.isDirty) {
      void saveTabToDisk(activeTab.id);
    }
  }, [activeTabId, tabs, saveTabToDisk]);

  useEffect(() => {
    if (autoSave !== 'afterDelay') return;

    const dirtyTabs = tabs.filter((tab) => tab.isDirty && tab.path);
    if (dirtyTabs.length === 0) return;

    const timer = setTimeout(() => {
      dirtyTabs.forEach((tab) => {
        void saveTabToDisk(tab.id);
      });
    }, autoSaveDelay);

    return () => clearTimeout(timer);
  }, [autoSave, autoSaveDelay, tabs, saveTabToDisk]);

  useEffect(() => {
    if (autoSave !== 'onFocusChange') {
      prevActiveRef.current = activeTabId;
      return;
    }

    const previous = prevActiveRef.current;
    if (previous && previous !== activeTabId) {
      const previousTab = tabs.find((tab) => tab.id === previous);
      if (previousTab?.isDirty) {
        void saveTabToDisk(previousTab.id);
      }
    }
    prevActiveRef.current = activeTabId;
  }, [autoSave, activeTabId, tabs, saveTabToDisk]);

  useEffect(() => {
    if (autoSave !== 'onFocusChange' && autoSave !== 'onWindowChange') return;

    const handleBlur = () => {
      saveActiveIfDirty();
    };

    const handleVisibility = () => {
      if (document.visibilityState === 'hidden') {
        saveActiveIfDirty();
      }
    };

    window.addEventListener('blur', handleBlur);
    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      window.removeEventListener('blur', handleBlur);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [autoSave, saveActiveIfDirty]);

  useEffect(() => {
    if (autoSave !== 'onWindowChange') return;

    const handleBeforeUnload = () => {
      saveActiveIfDirty();
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
    };
  }, [autoSave, saveActiveIfDirty]);

  return (
    <div
      className={`h-full flex flex-col ${isDropTarget ? 'ring-2 ring-primary/50 ring-inset' : ''}`}
      data-editor-panel
    >
      <TabBar />
      <CodeEditor />
    </div>
  );
};
