import React, { useMemo, useEffect } from 'react';
import { DiffEditor, useMonaco } from '@monaco-editor/react';
import { Loader2, X } from 'lucide-react';

import { getMonacoThemeId, themeService } from '../../services/theme-service';
import { useThemeStore } from '../../store/useThemeStore';

interface GitDiffModalProps {
  error?: string | null;
  filePath: string;
  isLoading: boolean;
  isOpen: boolean;
  language: string;
  modified: string;
  oldPath?: string;
  onClose: () => void;
  original: string;
  staged: boolean;
  status: string;
}

const formatStatus = (status: string): string => {
  return status.charAt(0).toUpperCase() + status.slice(1);
};

export const GitDiffModal: React.FC<GitDiffModalProps> = ({
  error,
  filePath,
  isLoading,
  isOpen,
  language,
  modified,
  oldPath,
  onClose,
  original,
  staged,
  status,
}) => {
  const monaco = useMonaco();
  const { activeThemeId, themes } = useThemeStore();

  const activeTheme = useMemo(
    () => themes.find((theme) => theme.id === activeThemeId) || themes[0],
    [activeThemeId, themes]
  );

  useEffect(() => {
    if (!monaco || !activeTheme) return;
    const monacoTheme = themeService.getMonacoTheme(activeTheme);
    const monacoThemeId = getMonacoThemeId(activeTheme);
    monaco.editor.defineTheme(monacoThemeId, monacoTheme);
    monaco.editor.setTheme(monacoThemeId);
  }, [activeTheme, monaco]);

  if (!isOpen) {
    return null;
  }

  const displayPath = oldPath ? `${oldPath} -> ${filePath}` : filePath;
  const monacoThemeId = activeTheme ? getMonacoThemeId(activeTheme) : 'aurora-dark';

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center p-3 sm:p-4 backdrop-blur-[1px]"
      style={{
        background: 'color-mix(in srgb, var(--aurora-common-background) 62%, transparent)',
      }}
      onClick={onClose}
    >
      <div
        className="w-[min(1220px,95vw)] h-[min(86vh,900px)] border rounded-lg bg-sidebar flex flex-col overflow-hidden"
        style={{
          borderColor: 'color-mix(in srgb, var(--aurora-common-border) 82%, transparent)',
          boxShadow: '0 24px 72px color-mix(in srgb, var(--aurora-common-background) 20%, black 80%)',
        }}
        onClick={(event) => event.stopPropagation()}
      >
        <div
          className="px-3.5 py-2 border-b bg-panel-header/90 flex items-center justify-between gap-3"
          style={{ borderColor: 'color-mix(in srgb, var(--aurora-common-border) 75%, transparent)' }}
        >
          <div className="min-w-0">
            <p className="text-[10px] uppercase tracking-[0.08em] text-text-secondary">
              Split Diff • {staged ? 'Staged' : 'Unstaged'} • {formatStatus(status)}
            </p>
            <p className="text-[12px] font-medium text-text-primary truncate" title={displayPath}>
              {displayPath}
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-md hover:bg-input/50 transition-colors text-text-secondary hover:text-text-primary"
            title="Close diff view"
          >
            <X className="w-[15px] h-[15px]" />
          </button>
        </div>

        <div className="flex-1 min-h-0 bg-editor">
          {isLoading ? (
            <div className="h-full flex items-center justify-center">
              <div className="flex items-center gap-2 text-text-secondary">
                <Loader2 className="w-4 h-4 animate-spin" />
                <span className="text-sm">Loading diff...</span>
              </div>
            </div>
          ) : error ? (
            <div className="h-full flex items-center justify-center px-6">
              <p className="text-sm text-danger text-center">{error}</p>
            </div>
          ) : (
            <DiffEditor
              original={original}
              modified={modified}
              language={language || 'plaintext'}
              theme={monacoThemeId}
              options={{
                automaticLayout: true,
                contextmenu: true,
                fontFamily: "'JetBrains Mono', 'Cascadia Code', 'Fira Code', Consolas, monospace",
                fontSize: 13,
                minimap: { enabled: false },
                originalEditable: false,
                readOnly: true,
                renderSideBySide: true,
                scrollBeyondLastLine: false,
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
};

export default GitDiffModal;
