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

/**
 * TreeNode Component
 * Orchestrator component for file/folder tree nodes
 * Uses sub-components for rendering and hooks for logic
 */

import React, { useState, useCallback } from 'react';
import type { FileNode } from '../../types';
import { useWorkspaceStore, loadFileContent } from '../../store/useWorkspaceStore';
import { useEditorStore } from '../../store/useEditorStore';
import { useTerminalStore } from '../../store/useTerminalStore';
import { ContextMenu } from '../ui/ContextMenu';
import { createFile, createFolder, deletePath, renamePath, isTauri, revealInExplorer } from '../../lib/tauri';
import { getLanguageFromExtension, joinPath } from '../../lib/file-utils';
import {
  TreeNodeRow,
  TreeNodeRenameInput,
  TreeNodeCreateInput,
  useTreeNodeContextMenu,
} from './tree-node';
import { DeleteConfirmDialog } from '../chat/DeleteConfirmDialog';

// Track the latest file load request to prevent stale async updates
let latestLoadRequestId = 0;

// ============================================
// TYPES
// ============================================

interface TreeNodeProps {
  node: FileNode;
  level: number;
  renameTargetId?: string | null;
  onRenameComplete?: () => void;
  onRenameStart?: (nodeId: string) => void;
  isCreating?: { type: 'file' | 'folder'; parentId: string } | null;
  createInputValue?: string;
  onCreateInputChange?: (value: string) => void;
  onCreateSubmit?: () => void;
  onCreateCancel?: () => void;
}

// ============================================
// COMPONENT
// ============================================

export const TreeNode: React.FC<TreeNodeProps> = ({
  node,
  level,
  renameTargetId,
  onRenameComplete,
  onRenameStart,
  isCreating: parentIsCreating,
  createInputValue: parentCreateValue = '',
  onCreateInputChange,
  onCreateSubmit,
  onCreateCancel,
}) => {
  // Store hooks
  const { expandedFolders, toggleFolder, expandFolder, selectedFileId, selectFile, refreshDirectory, rootPath } = useWorkspaceStore();
  const { openFile } = useEditorStore();

  // Local state
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [localIsCreating, setLocalIsCreating] = useState<'file' | 'folder' | null>(null);
  const [localInputValue, setLocalInputValue] = useState('');
  const [renameValue, setRenameValue] = useState(node.name);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);

  // Derived state
  const isRenaming = renameTargetId === node.id;
  const isCreatingHere = parentIsCreating && parentIsCreating.parentId === node.id;
  const isCreating = localIsCreating || (isCreatingHere ? parentIsCreating.type : null);
  const inputValue = isCreatingHere ? parentCreateValue : localInputValue;
  const isExpanded = expandedFolders.has(node.id);
  const isSelected = selectedFileId === node.id;
  const isFolder = node.type === 'folder';
  const nodePath = node.path || node.id;

  // ============================================
  // HANDLERS
  // ============================================

  const handleClick = useCallback(async () => {
    if (isFolder) {
      toggleFolder(node.id);
    } else {
      // Select file immediately for visual feedback
      selectFile(node.id);

      // Track this request to prevent stale async updates
      const requestId = ++latestLoadRequestId;
      const fileId = node.id;

      // Check if file is already open in a tab
      const { tabs } = useEditorStore.getState();
      const existingTab = tabs.find(t => t.id === fileId);
      
      if (existingTab) {
        // Tab already exists, just activate it
        useEditorStore.getState().setActiveTab(fileId);
        return;
      }

      // Open immediately with loading state
      openFile(fileId, node.name, '', node.language, true);

      try {
        const content = await loadFileContent(nodePath);

        // Ignore stale responses (user clicked another file)
        if (requestId !== latestLoadRequestId) {
          return;
        }

        // Replace loading state with actual content
        openFile(fileId, node.name, content, node.language, false);
      } catch (err) {
        // Ignore stale error responses
        if (requestId !== latestLoadRequestId) {
          return;
        }

        console.error('Failed to load file:', err);
        const message = err instanceof Error ? err.message : String(err);
        // Open with error message
        openFile(fileId, node.name, `// Failed to load file: ${message}`, node.language, false);
      }
    }
  }, [isFolder, node.id, node.name, node.language, nodePath, toggleFolder, selectFile, openFile]);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    selectFile(node.id);
    setContextMenu({ x: e.clientX, y: e.clientY });
  }, [node.id, selectFile]);

  // --- CREATE HANDLERS ---
  const handleNewFile = useCallback(() => {
    if (!isExpanded) expandFolder(node.id);
    setLocalIsCreating('file');
    setLocalInputValue('');
  }, [isExpanded, expandFolder, node.id]);

  const handleNewFolder = useCallback(() => {
    if (!isExpanded) expandFolder(node.id);
    setLocalIsCreating('folder');
    setLocalInputValue('');
  }, [isExpanded, expandFolder, node.id]);

  const handleCreateSubmit = useCallback(async () => {
    if (isCreatingHere && onCreateSubmit) {
      onCreateSubmit();
      return;
    }

    if (!localInputValue.trim()) {
      setLocalIsCreating(null);
      return;
    }

    if (!isTauri()) {
      setLocalIsCreating(null);
      return;
    }

    const newPath = joinPath(nodePath, localInputValue.trim());

    try {
      if (localIsCreating === 'file') {
        await createFile(newPath);
        // Open the new file
        selectFile(newPath);
        openFile(newPath, localInputValue.trim(), '', getLanguageFromExtension(localInputValue.trim()));
      } else {
        await createFolder(newPath);
      }
      expandFolder(node.id);
      await refreshDirectory();
    } catch (err) {
      console.error('Failed to create:', err);
      alert(`Failed to create: ${err}`);
    }

    setLocalIsCreating(null);
    setLocalInputValue('');
  }, [isCreatingHere, onCreateSubmit, localInputValue, localIsCreating, nodePath, node.id, expandFolder, selectFile, openFile, refreshDirectory]);

  const handleCreateCancel = useCallback(() => {
    if (isCreatingHere && onCreateCancel) {
      onCreateCancel();
    } else {
      setLocalIsCreating(null);
      setLocalInputValue('');
    }
  }, [isCreatingHere, onCreateCancel]);

  // --- RENAME HANDLERS ---
  const handleRenameStart = useCallback(() => {
    setRenameValue(node.name);
    onRenameStart?.(node.id);
  }, [node.name, node.id, onRenameStart]);

  const handleRenameSubmit = useCallback(async () => {
    if (!renameValue.trim() || renameValue === node.name) {
      onRenameComplete?.();
      return;
    }

    if (!isTauri()) {
      onRenameComplete?.();
      return;
    }

    const parentPath = nodePath.substring(0, nodePath.lastIndexOf(nodePath.includes('\\') ? '\\' : '/'));
    const newPath = joinPath(parentPath, renameValue.trim());

    try {
      await renamePath(nodePath, newPath);
      await refreshDirectory();
    } catch (err) {
      console.error('Failed to rename:', err);
      alert(`Failed to rename: ${err}`);
    }

    onRenameComplete?.();
  }, [renameValue, node.name, nodePath, refreshDirectory, onRenameComplete]);

  // --- DELETE HANDLER ---
  const handleDelete = useCallback(() => {
    if (!isTauri()) return;
    setShowDeleteDialog(true);
  }, []);

  const handleConfirmDelete = useCallback(async () => {
    setShowDeleteDialog(false);
    try {
      await deletePath(nodePath);
      await refreshDirectory();
    } catch (err) {
      console.error('Failed to delete:', err);
      alert(`Failed to delete: ${err}`);
    }
  }, [nodePath, refreshDirectory]);

  const handleCancelDelete = useCallback(() => {
    setShowDeleteDialog(false);
  }, []);

  // --- CLIPBOARD HANDLERS ---
  const handleCopyPath = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(nodePath);
    } catch {
      console.error('Failed to copy path');
    }
  }, [nodePath]);

  const handleCopyRelativePath = useCallback(async () => {
    let relativePath = nodePath;
    if (rootPath && nodePath.startsWith(rootPath)) {
      relativePath = nodePath.slice(rootPath.length);
      if (relativePath.startsWith('/') || relativePath.startsWith('\\')) {
        relativePath = relativePath.slice(1);
      }
    }
    try {
      await navigator.clipboard.writeText(relativePath);
    } catch {
      console.error('Failed to copy relative path');
    }
  }, [nodePath, rootPath]);

  const handleCopyName = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(node.name);
    } catch {
      console.error('Failed to copy name');
    }
  }, [node.name]);

  // --- TERMINAL/EXPLORER HANDLERS ---
  const handleRevealInExplorer = useCallback(async () => {
    if (!isTauri()) return;
    try {
      await revealInExplorer(nodePath);
    } catch (err) {
      console.error('Failed to reveal in explorer:', err);
    }
  }, [nodePath]);

  const handleOpenInTerminal = useCallback(() => {
    const terminalStore = useTerminalStore.getState();
    terminalStore.createSession(nodePath);
    terminalStore.openTerminal();
  }, [nodePath]);

  // ============================================
  // CONTEXT MENU
  // ============================================

  const contextMenuItems = useTreeNodeContextMenu({
    isFolder,
    onNewFile: handleNewFile,
    onNewFolder: handleNewFolder,
    onRename: handleRenameStart,
    onDelete: handleDelete,
    onCopyPath: handleCopyPath,
    onCopyRelativePath: handleCopyRelativePath,
    onCopyName: handleCopyName,
    onRevealInExplorer: handleRevealInExplorer,
    onOpenInTerminal: handleOpenInTerminal,
  });

  // ============================================
  // RENDER
  // ============================================

  return (
    <div>
      {/* Rename Mode */}
      {isRenaming ? (
        <TreeNodeRenameInput
          name={node.name}
          value={renameValue}
          isFolder={isFolder}
          level={level}
          path={nodePath}
          onChange={setRenameValue}
          onSubmit={handleRenameSubmit}
          onCancel={() => onRenameComplete?.()}
        />
      ) : (
        /* Normal Row */
        <TreeNodeRow
          name={node.name}
          path={nodePath}
          isFolder={isFolder}
          isExpanded={isExpanded}
          isSelected={isSelected}
          level={level}
          onClick={handleClick}
          onContextMenu={handleContextMenu}
        />
      )}

      {/* Folder Children */}
      {isFolder && isExpanded && (
        <>
          {/* Create Input */}
          {isCreating && (
            <TreeNodeCreateInput
              type={isCreating}
              value={inputValue}
              level={level}
              parentPath={nodePath}
              onChange={isCreatingHere ? (onCreateInputChange || (() => { })) : setLocalInputValue}
              onSubmit={handleCreateSubmit}
              onCancel={handleCreateCancel}
            />
          )}

          {/* Child Nodes */}
          {node.children?.map(child => (
            <TreeNode
              key={child.id}
              node={child}
              level={level + 1}
              renameTargetId={renameTargetId}
              onRenameComplete={onRenameComplete}
              onRenameStart={onRenameStart}
              isCreating={parentIsCreating}
              createInputValue={parentCreateValue}
              onCreateInputChange={onCreateInputChange}
              onCreateSubmit={onCreateSubmit}
              onCreateCancel={onCreateCancel}
            />
          ))}
        </>
      )}

      {/* Context Menu */}
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={contextMenuItems}
          onClose={() => setContextMenu(null)}
        />
      )}

      {/* Delete Confirmation Dialog */}
      <DeleteConfirmDialog
        isOpen={showDeleteDialog}
        itemName={node.name}
        itemType={isFolder ? 'folder' : 'file'}
        onConfirm={handleConfirmDelete}
        onCancel={handleCancelDelete}
      />
    </div>
  );
};
