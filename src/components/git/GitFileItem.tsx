/**
 * GitFileItem Component
 * Displays a single file in the git panel with Material icons and actions
 */

import React, { useCallback } from 'react';
import { Plus, Minus, Undo2 } from 'lucide-react';
import type { GitFileChange } from '../../services/git';
import { FileIcon } from '../explorer/FileIcons';
import { useEditorStore } from '../../store/useEditorStore';
import { useWorkspaceStore, loadFileContent } from '../../store/useWorkspaceStore';

interface GitFileItemProps {
  file: GitFileChange;
  onStage?: () => void;
  onUnstage?: () => void;
  onDiscard?: () => void;
}

const statusColors: Record<string, string> = {
  modified: 'var(--aurora-common-warning)',
  added: 'var(--aurora-common-success)',
  deleted: 'var(--aurora-common-error)',
  renamed: 'var(--aurora-common-info)',
  copied: 'var(--aurora-common-info)',
  untracked: 'var(--aurora-common-success)',
  conflicted: 'var(--aurora-common-error)',
};

const statusLabels: Record<string, string> = {
  modified: 'M',
  added: 'A',
  deleted: 'D',
  renamed: 'R',
  copied: 'C',
  untracked: 'U',
  conflicted: '!',
};

export const GitFileItem: React.FC<GitFileItemProps> = ({
  file,
  onStage,
  onUnstage,
  onDiscard,
}) => {
  const { openFile } = useEditorStore();
  const { rootPath, selectFile } = useWorkspaceStore();

  const fileName = file.path.split(/[/\\]/).pop() || file.path;
  const directory = file.path.substring(0, file.path.length - fileName.length - 1);
  const statusColor = statusColors[file.status] || 'var(--aurora-sidebar-foreground)';
  const statusLabel = statusLabels[file.status] || '?';

  // Build full path for the file
  const fullPath = rootPath
    ? `${rootPath}${rootPath.endsWith('/') || rootPath.endsWith('\\') ? '' : '/'}${file.path}`.replace(/\//g, '\\')
    : file.path;

  // Handle clicking on a file - open it in editor
  const handleClick = useCallback(async () => {
    // Don't open deleted files
    if (file.status === 'deleted') {
      return;
    }

    // Select file in workspace
    selectFile(fullPath);

    // Load content first, then open file - prevents "// Loading..." flash
    try {
      const content = await loadFileContent(fullPath);
      openFile(fullPath, fileName, content, undefined);
    } catch (err) {
      console.error('Failed to load file:', err);
      openFile(fullPath, fileName, `// Failed to load file: ${err}`, undefined);
    }
  }, [file.status, fullPath, fileName, selectFile, openFile]);

  const handleStage = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onStage?.();
  }, [onStage]);

  const handleUnstage = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onUnstage?.();
  }, [onUnstage]);

  const handleDiscard = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onDiscard?.();
  }, [onDiscard]);

  return (
    <div
      onClick={handleClick}
      className="group px-3 py-1.5 flex items-center gap-2 hover:bg-white/5 cursor-pointer transition-colors"
      title={file.path}
    >
      {/* Material File Icon */}
      <FileIcon
        name={fileName}
        path={fullPath}
        className="w-4 h-4 shrink-0"
      />

      {/* File Info */}
      <div className="flex-1 min-w-0 flex items-center gap-2">
        <span
          className="text-[13px] truncate"
          style={{ color: statusColor }}
        >
          {fileName}
        </span>
        {directory && (
          <span
            className="text-[11px] truncate"
            style={{ color: 'var(--aurora-sidebar-foreground)', opacity: 0.5 }}
          >
            {directory}
          </span>
        )}
      </div>

      {/* Actions (visible on hover) */}
      <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
        {onDiscard && file.status !== 'untracked' && (
          <button
            onClick={handleDiscard}
            className="p-1 rounded hover:bg-white/10 transition-colors"
            title="Discard Changes"
            style={{ color: 'var(--aurora-sidebar-foreground)' }}
          >
            <Undo2 className="w-3.5 h-3.5" />
          </button>
        )}
        {onStage && (
          <button
            onClick={handleStage}
            className="p-1 rounded hover:bg-white/10 transition-colors"
            title="Stage"
            style={{ color: 'var(--aurora-sidebar-foreground)' }}
          >
            <Plus className="w-3.5 h-3.5" />
          </button>
        )}
        {onUnstage && (
          <button
            onClick={handleUnstage}
            className="p-1 rounded hover:bg-white/10 transition-colors"
            title="Unstage"
            style={{ color: 'var(--aurora-sidebar-foreground)' }}
          >
            <Minus className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      {/* Status Badge */}
      <span
        className="text-[10px] font-bold w-4 text-center shrink-0"
        style={{ color: statusColor }}
        title={file.status}
      >
        {statusLabel}
      </span>
    </div>
  );
};

export default GitFileItem;
