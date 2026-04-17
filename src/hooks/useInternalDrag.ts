/**
 * Hook to handle internal drag-drop using mouse events
 * Works alongside Tauri's native drag-drop for external files
 */
import { useEffect } from "react";

import { dispatchAttachmentDrop } from "../lib/attachment-events";
import { getFilename, getLanguageFromExtension, isChildPath, joinPath } from "../lib/file-utils";
import { isTauri, readFileContent, renamePath } from "../lib/tauri";
import { useDragStore } from "../store/useDragStore";
import { useEditorStore } from "../store/useEditorStore";
import { useWorkspaceStore } from "../store/useWorkspaceStore";

export const useInternalDrag = () => {
  const { rootPath, expandFolder } = useWorkspaceStore();
  const { openFile } = useEditorStore();

  useEffect(() => {
    type DropTarget = {
      path: string | null;
      type: 'folder' | 'root' | 'editor' | 'attachment' | null;
    };

    const resolveDropTarget = (
      element: Element | null,
      draggedPath: string | null,
    ): DropTarget => {
      if (!element) {
        return { path: null, type: null };
      }

      const folderRow = element.closest('[data-folder-path]') as HTMLElement | null;
      if (folderRow) {
        const folderPath = folderRow.dataset.folderPath;
        if (
          folderPath &&
          folderPath !== draggedPath &&
          draggedPath &&
          !isChildPath(draggedPath, folderPath)
        ) {
          return { path: folderPath, type: 'folder' as const };
        }
      }

      if (element.closest('[data-attachment-drop-zone]')) {
        return { path: null, type: 'attachment' as const };
      }

      if (element.closest('[data-editor-panel]')) {
        return { path: null, type: 'editor' as const };
      }

      if (rootPath && element.closest('[data-explorer-panel], [data-explorer-content]')) {
        return { path: rootPath, type: 'root' as const };
      }

      return { path: null, type: null };
    };

    const handleMouseMove = (e: MouseEvent) => {
      // Update mouse position (this also checks threshold for pending drags)
      useDragStore.getState().updateMouse(e.clientX, e.clientY);

      // Get fresh state after updateMouse (it may have started dragging)
      const state = useDragStore.getState();
      if (!state.isDragging) return;

      const element = document.elementFromPoint(e.clientX, e.clientY);
      const target = resolveDropTarget(element, state.draggedPath);
      state.setDropTarget(target.path, target.type);
    };

    const handleMouseUp = async () => {
      const state = useDragStore.getState();

      // If there's a pending drag that never started, just cancel it
      // This allows normal clicks to work
      if (state.pendingPath && !state.isDragging) {
        state.cancelDrag();
        return;
      }

      if (!state.isDragging || !state.draggedPath) {
        state.endDrag();
        return;
      }

      const { draggedPath, dropTargetPath, dropTargetType } = state;
      state.endDrag();

      if (dropTargetType === 'attachment') {
        dispatchAttachmentDrop([draggedPath]);
        return;
      }

      if (!isTauri()) return;

      try {
        if (dropTargetType === 'editor') {
          // Open file in editor
          const content = await readFileContent(draggedPath);
          const filename = getFilename(draggedPath);
          const language = getLanguageFromExtension(filename);
          openFile(draggedPath, filename, content, language);
        } else if (dropTargetType === 'folder' && dropTargetPath) {
          // Move to folder
          const filename = getFilename(draggedPath);
          const newPath = joinPath(dropTargetPath, filename);

          if (newPath !== draggedPath) {
            await renamePath(draggedPath, newPath);
            expandFolder(dropTargetPath);
          }
        } else if (dropTargetType === 'root' && dropTargetPath) {
          // Move to root
          const sourceParent = draggedPath.substring(0, draggedPath.lastIndexOf(draggedPath.includes('\\') ? '\\' : '/'));
          if (sourceParent !== dropTargetPath) {
            const filename = getFilename(draggedPath);
            const newPath = joinPath(dropTargetPath, filename);
            await renamePath(draggedPath, newPath);
          }
        }
      } catch (err) {
        console.error('Failed to complete drag operation:', err);
      }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        useDragStore.getState().cancelDrag();
      }
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [rootPath, expandFolder, openFile]);
};
