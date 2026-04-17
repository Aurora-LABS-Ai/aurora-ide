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

import React, { useMemo, useEffect, useRef, useState } from 'react';
import Editor, { useMonaco, type OnMount } from '@monaco-editor/react';
import { useEditorStore } from '../../store/useEditorStore';
import { useSettingsStore } from '../../store/useSettingsStore';
import { useThemeStore } from '../../store/useThemeStore';
import { useUiStore } from '../../store/useUiStore';
import { themeService, getMonacoThemeId } from '../../services/theme-service';
import { convertFileSrc } from '@tauri-apps/api/core';
import { isTauri } from '../../lib/tauri';
import { Search, Settings, Eye, FileCode, Columns, AlertTriangle } from 'lucide-react';
import { BrowserTab } from './BrowserTab';
import { MarkdownPreview } from './MarkdownPreview';
import { setMonacoInstance } from '../../tools/executors/editor-executors';
import { setActiveMonacoEditor } from '../../lib/monaco-editor-ref';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg']);
const MARKDOWN_EXTS = new Set(['md', 'markdown', 'mdown', 'mkdn', 'mkd']);

type ViewMode = 'raw' | 'preview' | 'split';

export const CodeEditor: React.FC = () => {
  const { tabs, activeTabId, updateTabContent, fontSize } = useEditorStore();
  const { wrapMode } = useSettingsStore();
  const { activeThemeId, themes } = useThemeStore();
  const activeTheme = useMemo(() => themes.find(t => t.id === activeThemeId) || themes[0], [themes, activeThemeId]);
  const monaco = useMonaco();
  const diagnosticsConfigured = useRef(false);
  
  const [viewMode, setViewMode] = useState<ViewMode>('raw');

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

  const isMarkdown = useMemo(() => {
    if (!activeTab?.path) return false;
    const ext = activeTab.path.split('.').pop()?.toLowerCase();
    return !!ext && MARKDOWN_EXTS.has(ext);
  }, [activeTab]);

  const imageSrc = useMemo(() => {
    if (!isImage || !activeTab?.path) return null;
    if (!isTauri()) return null;
    return convertFileSrc(activeTab.path);
  }, [isImage, activeTab]);

  const effectiveViewMode: ViewMode = isMarkdown ? viewMode : 'raw';

  if (!activeTab) {
    const openSettings = () => useUiStore.getState().setSettingsOpen(true);
    const openQuickOpen = () => {
      const event = new KeyboardEvent('keydown', { key: 'p', ctrlKey: true });
      window.dispatchEvent(event);
    };

    return (
      <div className="flex-1 flex items-center justify-center text-text-secondary bg-editor">
        <div className="text-center max-w-xs">
          {/* Empty state icon */}
          <img
            src="/empty.png"
            alt="Editor empty state"
            width={176}
            height={176}
            className="w-44 h-44 mx-auto mb-7 object-contain"
          />
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

  if (activeTab.isLoading) {
    return (
      <div className="flex-1 flex items-center justify-center text-text-secondary bg-editor">
        <div className="flex flex-col items-center gap-2">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary/50 border-t-primary"></div>
          <p className="text-sm">Loading file...</p>
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
      {/* Large File Warning Banner */}
      {(activeTab.isLargeFile || activeTab.isMediumFile) && (
        <div className={`h-7 border-b border-border flex items-center gap-2 px-3 ${
          activeTab.isLargeFile ? 'bg-yellow-500/10 text-yellow-500' : 'bg-blue-500/10 text-blue-400'
        }`}>
          <AlertTriangle size={12} />
          <span className="text-[11px]">
            {activeTab.isLargeFile 
              ? 'Large file detected — Some features disabled for better performance'
              : 'Medium file — Some features reduced for better performance'
            }
          </span>
          <span className="text-[10px] opacity-60 ml-auto">
            {(activeTab.content.length / 1024).toFixed(0)} KB
          </span>
        </div>
      )}

      {/* View Mode Toggle for Markdown Files */}
      {isMarkdown && (
        <div className="h-8 border-b border-border flex items-center justify-between px-3 bg-sidebar">
          <div className="flex items-center gap-1">
            <button
              onClick={() => setViewMode('raw')}
              className={`flex items-center gap-1.5 px-2 py-1 text-[11px] rounded transition-colors ${
                effectiveViewMode === 'raw'
                  ? 'bg-primary/20 text-primary font-medium'
                  : 'text-text-secondary hover:bg-input/50 hover:text-text-primary'
              }`}
              title="Raw markdown"
            >
              <FileCode size={12} />
              <span>Raw</span>
            </button>
            <button
              onClick={() => setViewMode('preview')}
              className={`flex items-center gap-1.5 px-2 py-1 text-[11px] rounded transition-colors ${
                effectiveViewMode === 'preview'
                  ? 'bg-primary/20 text-primary font-medium'
                  : 'text-text-secondary hover:bg-input/50 hover:text-text-primary'
              }`}
              title="Preview"
            >
              <Eye size={12} />
              <span>Preview</span>
            </button>
            <button
              onClick={() => setViewMode('split')}
              className={`flex items-center gap-1.5 px-2 py-1 text-[11px] rounded transition-colors ${
                effectiveViewMode === 'split'
                  ? 'bg-primary/20 text-primary font-medium'
                  : 'text-text-secondary hover:bg-input/50 hover:text-text-primary'
              }`}
              title="Split view"
            >
              <Columns size={12} />
              <span>Split</span>
            </button>
          </div>
        </div>
      )}

      {/* Content Area */}
      {effectiveViewMode === 'raw' ? (
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
            loading={
              <div className="flex-1 flex items-center justify-center text-text-secondary bg-editor h-full">
                <div className="flex flex-col items-center gap-2">
                  <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-primary/50 border-t-primary"></div>
                  <p className="text-xs text-text-disabled">Loading editor...</p>
                </div>
              </div>
            }
            onChange={(value) => {
              if (value !== undefined) {
                updateTabContent(activeTab.id, value);
              }
            }}
            options={{
              // === PERFORMANCE OPTIMIZATIONS ===
              // Enable Monaco's built-in large file optimizations
              largeFileOptimizations: activeTab.isLargeFile || activeTab.isMediumFile,
              
              // Stop rendering line content after this many characters (prevents long line lag)
              stopRenderingLineAfter: activeTab.isLargeFile ? 5000 : (activeTab.isMediumFile ? 10000 : -1),
              
              // Limit tokenization (syntax highlighting) per line
              maxTokenizationLineLength: activeTab.isLargeFile ? 1000 : (activeTab.isMediumFile ? 5000 : 20000),
              
              // Disable bracket pair colorization for large files (expensive)
              bracketPairColorization: { 
                enabled: !activeTab.isLargeFile && !activeTab.isMediumFile,
                independentColorPoolPerBracketType: false 
              },
              
              // Disable code folding for large files
              folding: !activeTab.isLargeFile,
              foldingStrategy: 'indentation',
              
              // Disable hover for large files
              hover: { enabled: !activeTab.isLargeFile },
              
              // Disable occurrence highlighting
              occurrencesHighlight: activeTab.isLargeFile ? 'off' : 'singleFile',
              
              // Disable selection highlight for large files
              selectionHighlight: !activeTab.isLargeFile,
              
              // Disable sticky scroll (expensive for large files)
              stickyScroll: { enabled: !activeTab.isLargeFile && !activeTab.isMediumFile },
              
              // Disable link detection for large files
              links: !activeTab.isLargeFile,
              
              // Disable color decorators for large files
              colorDecorators: !activeTab.isLargeFile,
              
              // === STANDARD OPTIONS ===
              minimap: { enabled: !activeTab.isLargeFile && !activeTab.isMediumFile },
              fontSize: fontSize,
              scrollBeyondLastLine: false,
              automaticLayout: true,
              // Force word wrap off for large files for better performance
              wordWrap: activeTab.isLargeFile ? 'off' : (wrapMode ? 'on' : 'off'),
              wrappingIndent: 'same',
              wrappingStrategy: activeTab.isLargeFile ? 'simple' : 'advanced',
              padding: { top: 16, bottom: 16 },
              fontFamily: "'JetBrains Mono', 'Cascadia Code', 'Fira Code', Consolas, monospace",
              fontLigatures: !activeTab.isLargeFile, // Disable ligatures for large files
              lineNumbers: 'on',
              renderWhitespace: activeTab.isLargeFile ? 'none' : 'selection',
              tabSize: 2,
              cursorBlinking: 'smooth',
              smoothScrolling: !activeTab.isLargeFile && !activeTab.isMediumFile,
              renderValidationDecorations: activeTab.isLargeFile ? 'off' : 'on',
              renderLineHighlight: activeTab.isLargeFile ? 'none' : 'all',
              // Disable guides for large files
              guides: {
                indentation: !activeTab.isLargeFile,
                bracketPairs: !activeTab.isLargeFile && !activeTab.isMediumFile,
                highlightActiveIndentation: !activeTab.isLargeFile,
                bracketPairsHorizontal: !activeTab.isLargeFile,
              },
              // Disable quick suggestions for large files
              quickSuggestions: !activeTab.isLargeFile,
              suggestOnTriggerCharacters: !activeTab.isLargeFile,
              // Disable parameter hints for large files
              parameterHints: { enabled: !activeTab.isLargeFile },
            }}
          />
        </div>
      ) : effectiveViewMode === 'preview' ? (
        <div className="flex-1 overflow-auto p-6">
          <MarkdownPreview content={activeTab.content} />
        </div>
      ) : (
        // Split view
        <PanelGroup direction="horizontal" className="flex-1">
          <Panel defaultSize={50} minSize={20} maxSize={80}>
            <div className="h-full overflow-hidden">
              <Editor
                height="100%"
                path={activeTab.path}
                defaultLanguage={activeTab.language}
                language={activeTab.language}
                defaultValue={activeTab.content}
                value={activeTab.content}
                theme={activeTheme ? getMonacoThemeId(activeTheme) : 'aurora-dark'}
                onMount={handleEditorMount}
                loading={
                  <div className="flex items-center justify-center text-text-secondary bg-editor h-full">
                    <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-primary/50"></div>
                  </div>
                }
                onChange={(value) => {
                  if (value !== undefined) {
                    updateTabContent(activeTab.id, value);
                  }
                }}
                options={{
                  // Performance options for split view (minimap always off)
                  largeFileOptimizations: activeTab.isLargeFile || activeTab.isMediumFile,
                  stopRenderingLineAfter: activeTab.isLargeFile ? 5000 : 10000,
                  maxTokenizationLineLength: activeTab.isLargeFile ? 1000 : 5000,
                  bracketPairColorization: { enabled: !activeTab.isLargeFile },
                  folding: !activeTab.isLargeFile,
                  hover: { enabled: !activeTab.isLargeFile },
                  occurrencesHighlight: activeTab.isLargeFile ? 'off' : 'singleFile',
                  selectionHighlight: !activeTab.isLargeFile,
                  stickyScroll: { enabled: false },
                  minimap: { enabled: false },
                  fontSize: fontSize,
                  scrollBeyondLastLine: false,
                  automaticLayout: true,
                  wordWrap: activeTab.isLargeFile ? 'off' : (wrapMode ? 'on' : 'off'),
                  wrappingIndent: 'same',
                  wrappingStrategy: 'simple',
                  padding: { top: 16, bottom: 16 },
                  fontFamily: "'JetBrains Mono', 'Cascadia Code', 'Fira Code', Consolas, monospace",
                  fontLigatures: !activeTab.isLargeFile,
                  lineNumbers: 'on',
                  renderWhitespace: activeTab.isLargeFile ? 'none' : 'selection',
                  tabSize: 2,
                  cursorBlinking: 'smooth',
                  smoothScrolling: false,
                  renderValidationDecorations: activeTab.isLargeFile ? 'off' : 'on',
                  renderLineHighlight: activeTab.isLargeFile ? 'none' : 'all',
                  guides: {
                    indentation: !activeTab.isLargeFile,
                    bracketPairs: false,
                  },
                  quickSuggestions: !activeTab.isLargeFile,
                }}
              />
            </div>
          </Panel>
          <PanelResizeHandle className="w-1 hover:bg-primary/50 transition-colors cursor-col-resize" />
          <Panel defaultSize={50} minSize={20} maxSize={80}>
            <div className="h-full overflow-auto p-6">
              <MarkdownPreview content={activeTab.content} />
            </div>
          </Panel>
        </PanelGroup>
      )}
    </div>
  );
};
