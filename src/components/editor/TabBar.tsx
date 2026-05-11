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
      <div
        className="flex h-[34px] overflow-hidden border-b"
        style={{
          background: 'color-mix(in srgb, var(--aurora-title-bar-background) 78%, var(--aurora-editor-background) 22%)',
          borderColor: 'color-mix(in srgb, var(--aurora-common-border) 72%, transparent)',
        }}
      >
      {/*
        Undo / Redo controls.

        These delegate directly to the active Monaco editor, which now owns
        the canonical per-buffer undo stack (AI tool writes are routed
        through `replaceMonacoFileContent`, so they appear as one entry on
        the same stack — Ctrl+Z reverts a paste, an AI edit, or a manual
        keystroke uniformly).

        Visually they're flat ghost buttons that sit inside the tab strip's
        chrome — no inset shadow or pill outline, so they don't draw the
        eye away from the actual tabs.
      */}
      <div className="flex shrink-0 items-center gap-0.5 px-1">
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={triggerMonacoUndo}
          className="flex h-7 w-7 items-center justify-center rounded-md text-text-secondary transition-colors hover:bg-tabs-active hover:text-text-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/40"
          title="Undo (Ctrl+Z)"
          aria-label="Undo"
        >
          <Undo2 className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={triggerMonacoRedo}
          className="flex h-7 w-7 items-center justify-center rounded-md text-text-secondary transition-colors hover:bg-tabs-active hover:text-text-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/40"
          title="Redo (Ctrl+Y)"
          aria-label="Redo"
        >
          <Redo2 className="h-3.5 w-3.5" />
        </button>
        <span
          aria-hidden
          className="mx-1 h-4 w-px"
          style={{
            backgroundColor:
              'color-mix(in srgb, var(--aurora-common-border) 60%, transparent)',
          }}
        />
      </div>
      
      {/* Tabs - scrollable */}
      <div className="flex flex-1 overflow-x-auto overflow-y-hidden scrollbar-none">
        {tabs.map(tab => (
          <div
            key={tab.id}
            className={clsx(
              "group relative flex h-full shrink-0 items-center gap-1.5 border-r border-border px-3 cursor-pointer select-none transition-colors",
              activeTabId === tab.id
                ? "text-text-primary"
                : "text-text-secondary hover:text-text-primary",
            )}
            style={{
              // Active tab visually "becomes" the editor surface (VS Code style)
              background:
                activeTabId === tab.id
                  ? 'var(--aurora-editor-background)'
                  : 'transparent',
              boxShadow:
                activeTabId === tab.id
                  ? 'inset 0 1px 0 color-mix(in srgb, var(--aurora-common-primary-foreground) 5%, transparent)'
                  : 'none',
            }}
            onMouseEnter={(e) => {
              if (activeTabId !== tab.id) {
                e.currentTarget.style.background =
                  'color-mix(in srgb, var(--aurora-editor-background) 35%, transparent)';
              }
            }}
            onMouseLeave={(e) => {
              if (activeTabId !== tab.id) {
                e.currentTarget.style.background = 'transparent';
              }
            }}
            onClick={() => setActiveTab(tab.id)}
            title={tab.isDeleted ? `${tab.filename} (deleted)` : tab.filename}
          >
            {activeTabId === tab.id && (
              <span
                className="absolute inset-x-0 top-0 h-[2px]"
                style={{ background: 'var(--aurora-common-primary)' }}
              />
            )}
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
                "rounded p-0.5 opacity-0 transition-opacity hover:bg-border group-hover:opacity-100",
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
          className="flex h-full w-9 shrink-0 items-center justify-center transition-colors hover:bg-tabs-active"
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
            className="w-[min(440px,92vw)] overflow-hidden rounded-xl border border-border bg-sidebar shadow-2xl animate-in fade-in zoom-in-95 duration-150"
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
