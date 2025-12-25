import React from 'react';
import Editor, { loader } from '@monaco-editor/react';
import { useEditorStore } from '../../store/useEditorStore';

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

export const CodeEditor: React.FC = () => {
  const { tabs, activeTabId, updateTabContent, fontSize } = useEditorStore();
  
  const activeTab = tabs.find(t => t.id === activeTabId);

  if (!activeTab) {
    return (
      <div className="flex-1 flex items-center justify-center text-text-secondary bg-editor">
        <div className="text-center">
          <div className="text-6xl mb-4 opacity-10 font-light">A</div>
          <p className="text-sm">Select a file to start editing</p>
          <p className="text-xs mt-2 text-text-disabled">Ctrl+P to search files</p>
        </div>
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
