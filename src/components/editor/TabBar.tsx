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

import React, { useState } from 'react';
import { X, Globe, Plus, Undo2, Redo2, AlertTriangle } from 'lucide-react';
import { useEditorStore } from '../../store/useEditorStore';
import { useSettingsStore } from '../../store/useSettingsStore';
import { triggerMonacoUndo, triggerMonacoRedo } from '../../lib/monaco-editor-ref';
import clsx from 'clsx';
import { FileIcon } from '../explorer/FileIcons';

export const TabBar: React.FC = () => {
  const { tabs, activeTabId, setActiveTab, closeTab, openBrowserTab, saveTabToDisk } = useEditorStore();
  const autoSave = useSettingsStore((state) => state.autoSave);
  const [pendingUnsavedTabId, setPendingUnsavedTabId] = useState<string | null>(null);
  const [isSavingPendingClose, setIsSavingPendingClose] = useState(false);

  const pendingUnsavedTab = pendingUnsavedTabId
    ? tabs.find((tab) => tab.id === pendingUnsavedTabId) ?? null
    : null;

  const requestCloseTab = (tabId: string) => {
    const tab = tabs.find((item) => item.id === tabId);
    if (!tab) return;

    const shouldWarnUnsaved =
      autoSave === 'off' &&
      tab.type !== 'browser' &&
      tab.isDirty &&
      !tab.isDeleted;

    if (shouldWarnUnsaved) {
      setPendingUnsavedTabId(tab.id);
      return;
    }

    closeTab(tab.id, { skipUnsavedWarning: true });
  };

  const handleCancelUnsavedClose = () => {
    if (isSavingPendingClose) return;
    setPendingUnsavedTabId(null);
  };

  const handleCloseWithoutSaving = () => {
    if (!pendingUnsavedTab) return;
    closeTab(pendingUnsavedTab.id, { skipUnsavedWarning: true });
    setPendingUnsavedTabId(null);
  };

  const handleSaveAndClose = async () => {
    if (!pendingUnsavedTab || isSavingPendingClose) return;

    setIsSavingPendingClose(true);
    try {
      await saveTabToDisk(pendingUnsavedTab.id);
      closeTab(pendingUnsavedTab.id, { skipUnsavedWarning: true });
      setPendingUnsavedTabId(null);
    } finally {
      setIsSavingPendingClose(false);
    }
  };

  if (tabs.length === 0) return null;

  return (
    <>
      <div className="flex h-[28px] bg-tabs overflow-hidden">
      {/* Undo/Redo buttons - at the start where editor begins */}
      <div className="flex items-center gap-0.5 px-1 border-r border-border shrink-0">
        <button
          onMouseDown={(e) => e.preventDefault()}
          onClick={triggerMonacoUndo}
          className="p-1 rounded text-text-secondary hover:text-text-primary hover:bg-tabs-active transition-colors"
          title="Undo (Ctrl+Z)"
        >
          <Undo2 className="w-3.5 h-3.5" />
        </button>
        <button
          onMouseDown={(e) => e.preventDefault()}
          onClick={triggerMonacoRedo}
          className="p-1 rounded text-text-secondary hover:text-text-primary hover:bg-tabs-active transition-colors"
          title="Redo (Ctrl+Y)"
        >
          <Redo2 className="w-3.5 h-3.5" />
        </button>
      </div>
      
      {/* Tabs - scrollable */}
      <div className="flex flex-1 overflow-x-auto overflow-y-hidden scrollbar-none">
        {tabs.map(tab => (
          <div
            key={tab.id}
            className={clsx(
              "flex items-center gap-1.5 px-2.5 cursor-pointer select-none group border-r border-border shrink-0",
              activeTabId === tab.id
                ? "bg-tabs-active text-text-primary"
                : "bg-tabs text-text-secondary hover:text-text-primary"
            )}
            onClick={() => setActiveTab(tab.id)}
            title={tab.isDeleted ? `${tab.filename} (deleted)` : tab.filename}
          >
            {tab.type === 'browser' ? (
              <Globe className="w-3 h-3 text-info" />
            ) : (
              <FileIcon name={tab.filename} className={clsx("w-3 h-3", tab.isDeleted && "opacity-50")} />
            )}
            <span className={clsx(
              "text-[12px] truncate max-w-[120px]",
              tab.isDeleted && "text-error line-through opacity-75"
            )}>
              {tab.filename}
            </span>
            {tab.isDeleted && (
              <span className="text-[10px] text-error opacity-75">(deleted)</span>
            )}
            {tab.isDirty && !tab.isDeleted && <div className="w-1.5 h-1.5 rounded-full bg-text-secondary group-hover:hidden" />}
            <button
              className={clsx(
                "p-0.5 rounded hover:bg-border opacity-0 group-hover:opacity-100 transition-opacity",
                tab.isDirty && "group-hover:block"
              )}
              onClick={(e) => {
                e.stopPropagation();
                requestCloseTab(tab.id);
              }}
            >
              <X className="w-3 h-3" />
            </button>
          </div>
        ))}
        
        {/* New Browser Tab Button */}
        <button
          onClick={() => openBrowserTab()}
          className="flex items-center justify-center w-7 h-full hover:bg-tabs-active transition-colors shrink-0"
          title="Open Browser Tab (Preview localhost)"
        >
          <Plus className="w-3.5 h-3.5 text-text-secondary hover:text-text-primary" />
        </button>
      </div>
      </div>

      {pendingUnsavedTab && (
        <div
          className="fixed inset-0 z-[160] flex items-center justify-center bg-black/65 backdrop-blur-[1px]"
          onClick={handleCancelUnsavedClose}
        >
          <div
            className="w-[min(440px,92vw)] rounded-xl border border-border bg-sidebar shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-150"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="p-4 flex items-start gap-3">
              <div className="w-10 h-10 rounded-lg bg-warning/15 text-warning flex items-center justify-center shrink-0">
                <AlertTriangle className="w-5 h-5" />
              </div>
              <div className="min-w-0">
                <h3 className="text-[14px] font-semibold text-text-primary mb-1">
                  Unsaved Changes
                </h3>
                <p className="text-[12px] text-text-secondary leading-relaxed">
                  <span className="text-text-primary font-medium">{pendingUnsavedTab.filename}</span> has unsaved edits.
                  Close this tab without saving?
                </p>
              </div>
            </div>

            <div className="mx-4 mb-4 px-3 py-2 rounded-lg border border-border bg-input/40">
              <p className="text-[11px] text-text-disabled">Tip: use Save & Close to keep your changes.</p>
            </div>

            <div className="p-4 border-t border-border bg-titlebar flex items-center justify-end gap-2">
              <button
                onClick={handleCancelUnsavedClose}
                disabled={isSavingPendingClose}
                className="px-3 py-1.5 rounded-lg text-[12px] font-medium text-text-secondary hover:text-text-primary bg-input hover:bg-input-border border border-border transition-colors disabled:opacity-60"
              >
                Cancel
              </button>
              <button
                onClick={handleCloseWithoutSaving}
                disabled={isSavingPendingClose}
                className="px-3 py-1.5 rounded-lg text-[12px] font-medium text-danger-foreground bg-danger hover:bg-danger/85 transition-colors disabled:opacity-60"
              >
                Close Without Saving
              </button>
              <button
                onClick={handleSaveAndClose}
                disabled={isSavingPendingClose}
                className="px-3 py-1.5 rounded-lg text-[12px] font-medium text-primary-foreground bg-primary hover:bg-primary/85 transition-colors disabled:opacity-60"
              >
                {isSavingPendingClose ? 'Saving...' : 'Save & Close'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
};
