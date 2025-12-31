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

import React, { useMemo, useEffect, useRef } from 'react';
import Editor, { useMonaco } from '@monaco-editor/react';
import { useEditorStore } from '../../store/useEditorStore';
import { useSettingsStore } from '../../store/useSettingsStore';
import { useThemeStore } from '../../store/useThemeStore';
import { themeService, getMonacoThemeId } from '../../services/theme-service';
import { convertFileSrc } from '@tauri-apps/api/core';
import { isTauri } from '../../lib/tauri';
import { usePendingChangesStore } from '../../store/usePendingChangesStore';
import { Check, X, FileCode, ChevronLeft, ChevronRight } from 'lucide-react';

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg']);

export const CodeEditor: React.FC = () => {
  const { tabs, activeTabId, updateTabContent, fontSize, setActiveTab } = useEditorStore();
  const { wrapMode } = useSettingsStore();
  const { activeThemeId, themes } = useThemeStore();
  const activeTheme = useMemo(() => themes.find(t => t.id === activeThemeId) || themes[0], [themes, activeThemeId]);
  const monaco = useMonaco();
  const diagnosticsConfigured = useRef(false);

  const {
    getPendingChanges,
    getSelectedChange,
    acceptChange,
    rejectChange,
    navigateChange,
    selectedChangeIndex
  } = usePendingChangesStore();

  // Configure Monaco to disable semantic validation (we don't have project type definitions)
  // This prevents false red squiggles for imports, types, etc.
  useEffect(() => {
    if (monaco && !diagnosticsConfigured.current) {
      diagnosticsConfigured.current = true;
      
      try {
        // Access the typescript language service (may be under languages.typescript or directly)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const ts = (monaco.languages as any).typescript;
        
        if (ts && ts.typescriptDefaults) {
          // Disable semantic validation for TypeScript (keeps syntax validation)
          ts.typescriptDefaults.setDiagnosticsOptions({
            noSemanticValidation: true,  // Disable type checking (no false import errors)
            noSyntaxValidation: false,   // Keep syntax validation (catch real syntax errors)
          });
          
          // Set compiler options to be more lenient
          ts.typescriptDefaults.setCompilerOptions({
            target: ts.ScriptTarget?.ESNext ?? 99,
            allowNonTsExtensions: true,
            moduleResolution: ts.ModuleResolutionKind?.NodeJs ?? 2,
            module: ts.ModuleKind?.ESNext ?? 99,
            noEmit: true,
            esModuleInterop: true,
            jsx: ts.JsxEmit?.React ?? 2,
            allowJs: true,
            checkJs: false,
            strict: false,
            skipLibCheck: true,
            noImplicitAny: false,
          });
        }
        
        if (ts && ts.javascriptDefaults) {
          // Same for JavaScript
          ts.javascriptDefaults.setDiagnosticsOptions({
            noSemanticValidation: true,
            noSyntaxValidation: false,
          });
          
          ts.javascriptDefaults.setCompilerOptions({
            target: ts.ScriptTarget?.ESNext ?? 99,
            allowNonTsExtensions: true,
            moduleResolution: ts.ModuleResolutionKind?.NodeJs ?? 2,
            module: ts.ModuleKind?.ESNext ?? 99,
            noEmit: true,
            esModuleInterop: true,
            jsx: ts.JsxEmit?.React ?? 2,
            allowJs: true,
            checkJs: false,
          });
        }
        
        console.log('[CodeEditor] Monaco diagnostics configured - semantic validation disabled');
      } catch (e) {
        console.warn('[CodeEditor] Failed to configure Monaco diagnostics:', e);
      }
    }
  }, [monaco]);

  // Register and update theme when it changes
  useEffect(() => {
    if (monaco && activeTheme) {
      const monacoTheme = themeService.getMonacoTheme(activeTheme);
      const themeId = getMonacoThemeId(activeTheme);
      monaco.editor.defineTheme(themeId, monacoTheme);
      monaco.editor.setTheme(themeId);
    }
  }, [monaco, activeTheme]);

  const activeTab = useMemo(() => tabs.find(t => t.id === activeTabId), [tabs, activeTabId]);

  const isImage = useMemo(() => {
    if (!activeTab?.path) return false;
    const ext = activeTab.path.split('.').pop()?.toLowerCase();
    return !!ext && IMAGE_EXTS.has(ext);
  }, [activeTab]);

  const imageSrc = useMemo(() => {
    if (!isImage || !activeTab?.path) return null;
    if (!isTauri()) return null;
    return convertFileSrc(activeTab.path);
  }, [isImage, activeTab]);

  // Get all pending changes and the currently selected one
  const pendingChanges = getPendingChanges();
  const selectedChange = getSelectedChange();
  const totalChanges = pendingChanges.length;
  const currentIndex = Math.min(selectedChangeIndex, totalChanges - 1);

  // Auto-focus the tab for the selected change (but don't open new tabs)
  useEffect(() => {
    if (selectedChange && selectedChange.filePath) {
      const existingTab = tabs.find(t => t.path === selectedChange.filePath);
      if (existingTab && activeTabId !== existingTab.id) {
        setActiveTab(existingTab.id);
      }
    }
  }, [selectedChange?.id, tabs, activeTabId, setActiveTab]);

  if (!activeTab) {
    return (
      <div className="flex-1 flex items-center justify-center text-text-secondary bg-editor">
        <div className="text-center">
          <img
            src="/app-icon.svg"
            alt="Aurora"
            className="w-16 h-16 mx-auto mb-4 opacity-20"
          />
          <p className="text-sm pb-1.5">Select a file to start editing</p>
          <p className="text-xs text-text-disabled">Ctrl+P to search files</p>
        </div>
      </div>
    );
  }

  if (isImage) {
    return (
      <div className="flex-1 bg-editor overflow-auto flex items-center justify-center">
        {imageSrc ? (
          <img
            src={imageSrc}
            alt={activeTab.filename}
            className="max-h-full max-w-full object-contain"
          />
        ) : (
          <div className="text-text-secondary text-sm">
            Image preview unavailable outside the desktop app.
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="flex-1 bg-editor overflow-hidden relative flex flex-col">
      {/* Pending Changes Banner - Lightweight notification */}
      {selectedChange && (
        <div className="absolute top-0 left-0 right-0 z-50 flex items-center justify-between px-4 py-2 bg-panel-header border-b border-border backdrop-blur-md">
          <div className="flex items-center gap-3">
            {/* File Icon and Info */}
            <div className="flex items-center gap-2">
              <div className="p-1.5 rounded-md bg-primary/20 text-primary">
                <FileCode size={14} />
              </div>
              <div>
                <div className="text-[11px] font-bold text-primary uppercase tracking-wider leading-none">
                  Pending Changes
                </div>
                <div className="text-[10px] text-text-secondary mt-0.5 font-mono">
                  {selectedChange.operation.toUpperCase()} - {selectedChange.fileName}
                </div>
              </div>
            </div>

            {/* Navigation Arrows (when multiple changes) */}
            {totalChanges > 1 && (
              <div className="flex items-center gap-1 ml-4 px-2 py-1 rounded-md bg-sidebar border border-border">
                <button
                  onClick={() => navigateChange('prev')}
                  className="p-1 rounded hover:bg-input text-text-secondary hover:text-text-primary transition-colors"
                  title="Previous change"
                >
                  <ChevronLeft size={14} />
                </button>
                <span className="text-[11px] text-text-secondary font-mono px-2 min-w-[60px] text-center">
                  {currentIndex + 1} of {totalChanges}
                </span>
                <button
                  onClick={() => navigateChange('next')}
                  className="p-1 rounded hover:bg-input text-text-secondary hover:text-text-primary transition-colors"
                  title="Next change"
                >
                  <ChevronRight size={14} />
                </button>
              </div>
            )}
          </div>

          {/* Action Buttons */}
          <div className="flex items-center gap-2">
            <button
              onClick={() => rejectChange(selectedChange.id)}
              className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-bold text-danger hover:text-red-300 bg-danger/10 hover:bg-danger/20 rounded-md border border-danger/20 transition-all"
            >
              <X size={12} strokeWidth={3} />
              Reject
            </button>
            <button
              onClick={async () => {
                await acceptChange(selectedChange.id);
                // Also update the tab content in the editor store if the tab is open
                const openedTab = tabs.find(t => t.path === selectedChange.filePath);
                if (openedTab) {
                  const { reloadTabContent } = useEditorStore.getState();
                  reloadTabContent(openedTab.id, selectedChange.content);
                }
              }}
              className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-bold text-success hover:text-green-300 bg-success/10 hover:bg-success/20 rounded-md border border-success/20 transition-all shadow-[0_0_15px_-5px_rgba(137,209,133,0.3)]"
            >
              <Check size={12} strokeWidth={3} />
              Accept
            </button>
          </div>
        </div>
      )}

      {/* Monaco Editor - Always show the editor, no diff viewer */}
      <div className={`flex-1 relative overflow-hidden ${selectedChange ? 'pt-12' : ''}`}>
        <Editor
          height="100%"
          path={activeTab.path}
          defaultLanguage={activeTab.language}
          language={activeTab.language}
          defaultValue={activeTab.content}
          value={activeTab.content}
          theme={activeTheme ? getMonacoThemeId(activeTheme) : 'aurora-dark'}
          onChange={(value) => {
            if (value !== undefined) {
              updateTabContent(activeTab.id, value);
            }
          }}
          options={{
            minimap: { enabled: true },
            fontSize: fontSize,
            scrollBeyondLastLine: false,
            automaticLayout: true,
            wordWrap: wrapMode ? 'on' : 'off',
            wrappingIndent: 'same',
            wrappingStrategy: 'advanced',
            padding: { top: 16, bottom: 16 },
            fontFamily: "'JetBrains Mono', 'Cascadia Code', 'Fira Code', Consolas, monospace",
            fontLigatures: true,
            lineNumbers: 'on',
            renderWhitespace: 'selection',
            tabSize: 2,
            cursorBlinking: 'smooth',
            smoothScrolling: true,
          }}
        />
      </div>
    </div>
  );
};
