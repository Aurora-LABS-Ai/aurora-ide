import React, { useMemo } from 'react';
import Editor, { loader } from '@monaco-editor/react';
import { useEditorStore } from '../../store/useEditorStore';
import { useSettingsStore } from '../../store/useSettingsStore';
import { convertFileSrc } from '@tauri-apps/api/core';
import { isTauri } from '../../lib/tauri';

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
  const { tabs, activeTabId, updateTabContent, fontSize } = useEditorStore();
  const { wrapMode } = useSettingsStore();

  const activeTab = tabs.find(t => t.id === activeTabId);

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
    <div className="flex-1 bg-editor overflow-hidden relative">
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
    </div>
  );
};
