import React, { useMemo, useEffect } from 'react';
import Editor, { loader } from '@monaco-editor/react';
import { useEditorStore } from '../../store/useEditorStore';
import { useSettingsStore } from '../../store/useSettingsStore';
import { convertFileSrc } from '@tauri-apps/api/core';
import { isTauri } from '../../lib/tauri';
import { usePendingChangesStore } from '../../store/usePendingChangesStore';
import { Check, X, FileCode, ChevronLeft, ChevronRight } from 'lucide-react';
import ReactDiffViewer from 'react-diff-viewer-continued';

// Define custom theme before Monaco loads
loader.init().then((monaco) => {
  monaco.editor.defineTheme('aurora-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': '#1e1e1e',
      'editor.foreground': '#d4d4d4',
      'editorLineNumber.foreground': '#555555',
      'editorLineNumber.activeForeground': '#d4d4d4',
      'editor.selectionBackground': '#264f78',
      'editor.lineHighlightBackground': '#262626',
      'editorCursor.foreground': '#aeafad',
      'editorWidget.background': '#1e1e1e',
      'editorWidget.border': '#2b2b2b',
      'editorGutter.background': '#1e1e1e',
      'minimap.background': '#1e1e1e',
      'scrollbarSlider.background': '#42424266',
      'scrollbarSlider.hoverBackground': '#55555599',
      'scrollbarSlider.activeBackground': '#666666aa',
    }
  });
});

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg']);

export const CodeEditor: React.FC = () => {
  const { tabs, activeTabId, updateTabContent, fontSize, openFile, setActiveTab } = useEditorStore();
  const { wrapMode } = useSettingsStore();
  const {
    getPendingChanges,
    getSelectedChange,
    acceptChange,
    rejectChange,
    navigateChange,
    selectedChangeIndex
  } = usePendingChangesStore();

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

  // Auto-open the file for the selected change
  useEffect(() => {
    if (selectedChange && selectedChange.filePath) {
      const existingTab = tabs.find(t => t.path === selectedChange.filePath);
      if (existingTab) {
        // Just focus the existing tab
        if (activeTabId !== existingTab.id) {
          setActiveTab(existingTab.id);
        }
      } else {
        // Open the file in a new tab
        openFile(
          selectedChange.filePath,
          selectedChange.fileName,
          selectedChange.originalContent || '',
          undefined
        );
      }
    }
  }, [selectedChange?.id]); // Only re-run when selected change ID changes

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

  // Check if the current file has a pending change to show
  const showDiffForCurrentFile = selectedChange && selectedChange.filePath === activeTab.path;

  return (
    <div className="flex-1 bg-editor overflow-hidden relative flex flex-col">
      {/* Approval Header Overlay - Matches IDE Theme */}
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

      <div className={`flex-1 relative overflow-hidden ${selectedChange ? 'pt-12' : ''}`}>
        {showDiffForCurrentFile ? (
          <div className="h-full w-full overflow-auto bg-[#0d0d0d] scrollbar-thin">
            <ReactDiffViewer
              oldValue={selectedChange.originalContent || ''}
              newValue={selectedChange.content}
              splitView={false}
              useDarkTheme={true}
              hideLineNumbers={false}
              styles={{
                variables: {
                  dark: {
                    // Muted, readable diff colors matching IDE theme
                    diffViewerBackground: '#0d0d0d',
                    diffViewerColor: '#d4d4d4',
                    addedBackground: '#1e3a29',
                    addedColor: '#89d185',
                    removedBackground: '#3d2323',
                    removedColor: '#ce9178',
                    wordAddedBackground: '#2d4f3c',
                    wordRemovedBackground: '#5c3333',
                    addedGutterBackground: '#1a3324',
                    removedGutterBackground: '#3a2020',
                    gutterBackground: '#141414',
                    gutterColor: '#555555',
                    codeFoldBackground: '#1c1c1c',
                    codeFoldGutterBackground: '#1c1c1c',
                    emptyLineBackground: '#0d0d0d',
                  }
                },
                contentText: {
                  fontSize: '13px',
                  lineHeight: '20px',
                  fontFamily: "'JetBrains Mono', 'Cascadia Code', 'Fira Code', Consolas, monospace",
                },
                line: {
                  padding: '1px 0',
                }
              }}
            />
          </div>
        ) : (
          <Editor
            height="100%"
            path={activeTab.path}
            defaultLanguage={activeTab.language}
            language={activeTab.language}
            defaultValue={activeTab.content}
            value={activeTab.content}
            theme="aurora-dark"
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
        )}
      </div>
    </div>
  );
};
