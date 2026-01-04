/**
 * Hook to handle internal drag-drop using mouse events
 * Works alongside Tauri's native drag-drop for external files
 */
import { useEffect } from "react";

import { getFilename, getLanguageFromExtension, isChildPath, joinPath } from "../lib/file-utils";
import { isTauri, readFileContent, renamePath } from "../lib/tauri";
import { useDragStore } from "../store/useDragStore";
import { useEditorStore } from "../store/useEditorStore";
import { useWorkspaceStore } from "../store/useWorkspaceStore";

export const useInternalDrag = () => {
  const { rootPath, refreshDirectory, expandFolder } = useWorkspaceStore();
  const { openFile } = useEditorStore();

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      // Update mouse position (this also checks threshold for pending drags)
      useDragStore.getState().updateMouse(e.clientX, e.clientY);

      // Get fresh state after updateMouse (it may have started dragging)
      const state = useDragStore.getState();
      if (!state.isDragging) return;

      // Find drop target
      const element = document.elementFromPoint(e.clientX, e.clientY);
      if (!element) {
        state.setDropTarget(null, null);
        return;
      }

      // Check for folder
      const folderRow = element.closest('[data-folder-path]') as HTMLElement;
      if (folderRow) {
        const folderPath = folderRow.dataset.folderPath;
        if (folderPath && folderPath !== state.draggedPath) {
          // Don't allow dropping into own child
          if (!isChildPath(state.draggedPath!, folderPath)) {
            state.setDropTarget(folderPath, 'folder');
            return;
          }
        }
      }

      // Check for editor
      const editorPanel = element.closest('[data-editor-panel]');
      if (editorPanel) {
        state.setDropTarget(null, 'editor');
        return;
      }

      // Check for explorer root
      const explorerContent = element.closest('[data-explorer-content]');
      if (explorerContent && rootPath) {
        state.setDropTarget(rootPath, 'root');
        return;
      }

      state.setDropTarget(null, null);
    };

    const handleMouseUp = async (_e: MouseEvent) => {
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
            await refreshDirectory();
          }
        } else if (dropTargetType === 'root' && dropTargetPath) {
          // Move to root
          const sourceParent = draggedPath.substring(0, draggedPath.lastIndexOf(draggedPath.includes('\\') ? '\\' : '/'));
          if (sourceParent !== dropTargetPath) {
            const filename = getFilename(draggedPath);
            const newPath = joinPath(dropTargetPath, filename);
            await renamePath(draggedPath, newPath);
            await refreshDirectory();
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
  }, [rootPath, refreshDirectory, expandFolder, openFile]);
};
