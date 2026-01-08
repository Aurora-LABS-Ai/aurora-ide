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
import Editor, { useMonaco, type OnMount } from '@monaco-editor/react';
import { useEditorStore } from '../../store/useEditorStore';
import { useSettingsStore } from '../../store/useSettingsStore';
import { useThemeStore } from '../../store/useThemeStore';
import { useUiStore } from '../../store/useUiStore';
import { themeService, getMonacoThemeId } from '../../services/theme-service';
import { convertFileSrc } from '@tauri-apps/api/core';
import { isTauri } from '../../lib/tauri';
import { Search, Settings } from 'lucide-react';
import { BrowserTab } from './BrowserTab';
import { setMonacoInstance } from '../../tools/executors/editor-executors';
import { setActiveMonacoEditor } from '../../lib/monaco-editor-ref';

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg']);

export const CodeEditor: React.FC = () => {
  const { tabs, activeTabId, updateTabContent, fontSize } = useEditorStore();
  const { wrapMode } = useSettingsStore();
  const { activeThemeId, themes } = useThemeStore();
  const activeTheme = useMemo(() => themes.find(t => t.id === activeThemeId) || themes[0], [themes, activeThemeId]);
  const monaco = useMonaco();
  const diagnosticsConfigured = useRef(false);

  // Store Monaco editor instance for programmatic undo/redo
  const handleEditorMount: OnMount = (editor) => {
    setActiveMonacoEditor(editor);
  };

  // Clear editor ref when component unmounts
  useEffect(() => {
    return () => setActiveMonacoEditor(null);
  }, []);


  // Configure Monaco to disable semantic validation (we don't have project type definitions)
  // This prevents false red squiggles for imports, types, etc.
  // Also set Monaco instance for read_lints tool
  useEffect(() => {
    if (monaco && !diagnosticsConfigured.current) {
      diagnosticsConfigured.current = true;

      // Set Monaco instance for read_lints tool
      setMonacoInstance(monaco);

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

  if (!activeTab) {
    const openSettings = () => useUiStore.getState().setSettingsOpen(true);
    const openQuickOpen = () => {
      const event = new KeyboardEvent('keydown', { key: 'p', ctrlKey: true });
      window.dispatchEvent(event);
    };

    return (
      <div className="flex-1 flex items-center justify-center text-text-secondary bg-editor">
        <div className="text-center max-w-xs">
          {/* Icon with glow effect - matching chat panel style */}
          <div className="w-16 h-16 mx-auto mb-5 relative group">
            <div className="absolute inset-0 bg-primary/15 rounded-2xl blur-xl" />
            <img
              src="/app-icon.svg"
              alt="Aurora"
              className="relative z-10 w-full h-full drop-shadow-lg"
            />
          </div>
          <p className="text-sm text-text-primary mb-1">Select a file to start editing</p>
          <p className="text-xs text-text-disabled mb-5">Open a file from the explorer or use shortcuts below</p>

          {/* Shortcut buttons */}
          <div className="flex flex-wrap justify-center gap-2">
            <button
              onClick={openQuickOpen}
              className="flex items-center gap-2 px-3 py-1.5 text-[11px] text-text-secondary hover:text-text-primary bg-sidebar hover:bg-input border border-border rounded-md transition-colors"
            >
              <Search size={12} />
              <span>Search Files</span>
              <kbd className="ml-1 px-1.5 py-0.5 text-[9px] bg-editor border border-border rounded">Ctrl+P</kbd>
            </button>
            <button
              onClick={openSettings}
              className="flex items-center gap-2 px-3 py-1.5 text-[11px] text-text-secondary hover:text-text-primary bg-sidebar hover:bg-input border border-border rounded-md transition-colors"
            >
              <Settings size={12} />
              <span>Settings</span>
            </button>
          </div>
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

  // Browser tab
  if (activeTab.type === 'browser') {
    return (
      <BrowserTab
        tabId={activeTab.id}
        url={activeTab.url || 'about:blank'}
      />
    );
  }

  return (
    <div className="flex-1 bg-editor overflow-hidden relative flex flex-col">
      {/* Monaco Editor */}
      <div className="flex-1 relative overflow-hidden">
        <Editor
          height="100%"
          path={activeTab.path}
          defaultLanguage={activeTab.language}
          language={activeTab.language}
          defaultValue={activeTab.content}
          value={activeTab.content}
          theme={activeTheme ? getMonacoThemeId(activeTheme) : 'aurora-dark'}
          onMount={handleEditorMount}
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
