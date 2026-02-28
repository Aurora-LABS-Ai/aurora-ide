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

import React from 'react';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { TreeNode } from './TreeNode';
import { FileIcon, FolderIcon } from './FileIcons';
import type { FileNode } from '../../types';

interface FileTreeProps {
  files?: FileNode[];
  renameTargetId?: string | null;
  onRenameComplete?: () => void;
  onRenameStart?: (nodeId: string) => void;
  isCreating?: { type: 'file' | 'folder'; parentId: string } | null;
  createInputValue?: string;
  onCreateInputChange?: (value: string) => void;
  onCreateSubmit?: () => void;
  onCreateCancel?: () => void;
}

export const FileTree: React.FC<FileTreeProps> = ({
  files: propFiles,
  renameTargetId,
  onRenameComplete,
  onRenameStart,
  isCreating,
  createInputValue = '',
  onCreateInputChange,
  onCreateSubmit,
  onCreateCancel,
}) => {
  const storeFiles = useWorkspaceStore((state) => state.files);
  const rootPath = useWorkspaceStore((state) => state.rootPath);
  const files = propFiles || storeFiles;

  // Check if we're creating at root level
  const isCreatingAtRoot = isCreating && isCreating.parentId === rootPath;

  return (
    <div className="flex flex-col">
      {/* Show create input at root if creating at root */}
      {isCreatingAtRoot && (
        <CreateInput
          type={isCreating.type}
          value={createInputValue}
          onChange={onCreateInputChange}
          onSubmit={onCreateSubmit}
          onCancel={onCreateCancel}
          level={0}
        />
      )}
      {files.map(node => (
        <TreeNode
          key={node.id}
          node={node}
          level={0}
          renameTargetId={renameTargetId}
          onRenameComplete={onRenameComplete}
          onRenameStart={onRenameStart}
          isCreating={isCreating}
          createInputValue={createInputValue}
          onCreateInputChange={onCreateInputChange}
          onCreateSubmit={onCreateSubmit}
          onCreateCancel={onCreateCancel}
        />
      ))}
    </div>
  );
};

// Inline create input component
interface CreateInputProps {
  type: 'file' | 'folder';
  value: string;
  onChange?: (value: string) => void;
  onSubmit?: () => void;
  onCancel?: () => void;
  level: number;
}

const CreateInput: React.FC<CreateInputProps> = ({
  type,
  value,
  onChange,
  onSubmit,
  onCancel,
  level,
}) => {
  const inputRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      onSubmit?.();
    } else if (e.key === 'Escape') {
      onCancel?.();
    }
  };

  return (
    <div
      className="flex items-center gap-1 py-[2px] px-2"
      style={{ paddingLeft: `${level * 12 + 8}px` }}
    >
      <span className="w-4" />
      {/* Dynamic Material icon based on input value */}
      {type === 'folder' ? (
        <FolderIcon name={value || 'folder'} className="w-4 h-4" open={false} />
      ) : (
        <FileIcon name={value || ''} className="w-4 h-4" />
      )}
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={(e) => onChange?.(e.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={onSubmit}
        placeholder={type === 'file' ? 'filename.ext' : 'folder name'}
        className="flex-1 bg-input border border-primary rounded px-1.5 py-0.5 text-[13px] text-text-primary outline-none placeholder:text-text-disabled"
      />
    </div>
  );
};
