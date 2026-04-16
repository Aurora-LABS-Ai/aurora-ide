import { useCallback, useEffect } from "react";

import { copyToClipboard, deletePath, isTauri } from "../lib/tauri";
import { useEditorStore } from "../store/useEditorStore";
import { useWorkspaceStore } from "../store/useWorkspaceStore";

interface UseExplorerKeyboardProps {
  onNewFile: (parentId: string) => void;
  onNewFolder: (parentId: string) => void;
  onRename: (nodeId: string) => void;
}

/**
 * Hook that handles keyboard shortcuts for the file explorer
 */
export const useExplorerKeyboard = ({
  onRename,
  onNewFile,
  onNewFolder,
}: UseExplorerKeyboardProps) => {
  const { selectedFileId, files, rootPath } = useWorkspaceStore();
  const { closeTab } = useEditorStore();

  // Find parent folder of selected file
  const findParentFolder = useCallback((nodeId: string): string | null => {
    const findParent = (nodes: typeof files, parentId: string | null): string | null => {
      for (const node of nodes) {
        if (node.id === nodeId) {
          return parentId;
        }
        if (node.children) {
          const found = findParent(node.children, node.id);
          if (found !== undefined) return found;
        }
      }
      return null;
    };
    return findParent(files, rootPath);
  }, [files, rootPath]);

  // Find node by ID
  const findNode = useCallback((nodeId: string) => {
    const find = (nodes: typeof files): typeof files[0] | null => {
      for (const node of nodes) {
        if (node.id === nodeId) return node;
        if (node.children) {
          const found = find(node.children);
          if (found) return found;
        }
      }
      return null;
    };
    return find(files);
  }, [files]);

  const handleKeyDown = useCallback(async (e: KeyboardEvent) => {
    // Only handle if explorer is focused (or no specific element is focused)
    const target = e.target as HTMLElement;
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') {
      return;
    }

    if (!selectedFileId) return;

    const node = findNode(selectedFileId);
    if (!node) return;

    switch (e.key) {
      case 'Delete':
      {
        e.preventDefault();
        if (!isTauri()) return;
        const confirmed = window.confirm(`Are you sure you want to delete "${node.name}"?`);
        if (confirmed) {
          try {
            await deletePath(node.path || node.id);
            // File is intentionally deleted, so skip unsaved close warning.
            closeTab(node.id, { skipUnsavedWarning: true });
          } catch (err) {
            console.error('Failed to delete:', err);
            alert(`Failed to delete: ${err}`);
          }
        }
        break;
      }

      case 'F2':
        e.preventDefault();
        onRename(selectedFileId);
        break;

      case 'c':
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          const path = node.path || node.id;
          await copyToClipboard(path);
        }
        break;

      case 'n':
      {
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          const isFolder = node.type === 'folder';
          const parentId = isFolder ? node.id : findParentFolder(node.id) || rootPath;
          if (e.shiftKey) {
            onNewFolder(parentId);
          } else {
            onNewFile(parentId);
          }
        }
        break;
      }

      case 'Enter':
        // Enter key is handled by TreeNode click
        break;
    }
  }, [selectedFileId, findNode, findParentFolder, onRename, onNewFile, onNewFolder, closeTab, rootPath]);

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [handleKeyDown]);

  return null;
};
