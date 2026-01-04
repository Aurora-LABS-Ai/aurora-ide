/**
 * Hook to handle Tauri's native drag-drop events for external files
 */
import { useEffect, useRef } from "react";

import { getFilename, getLanguageFromExtension, joinPath } from "../lib/file-utils";
import { copyPath, isTauri, readFileContent } from "../lib/tauri";
import { useEditorStore } from "../store/useEditorStore";
import { useWorkspaceStore } from "../store/useWorkspaceStore";

export const useTauriDragDrop = () => {
  const { rootPath, refreshDirectory, expandFolder } = useWorkspaceStore();
  const { openFile } = useEditorStore();
  const dropTargetRef = useRef<{ type: 'folder' | 'editor' | 'root'; path: string } | null>(null);

  useEffect(() => {
    if (!isTauri()) return;

    let cleanup: (() => void) | undefined;

    const setupDragDrop = async () => {
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        const currentWindow = getCurrentWindow();

        const unlisten = await currentWindow.onDragDropEvent(async (event) => {
          if (event.payload.type === 'over') {
            // Find what element is at the drop position
            const { x, y } = event.payload.position;
            const element = document.elementFromPoint(x, y);

            if (element) {
              // Check if over a folder in the tree
              const folderRow = element.closest('[data-folder-path]') as HTMLElement;
              if (folderRow) {
                const folderPath = folderRow.dataset.folderPath;
                if (folderPath) {
                  dropTargetRef.current = { type: 'folder', path: folderPath };
                  folderRow.classList.add('bg-primary/20', 'ring-1', 'ring-primary/50');
                  return;
                }
              }

              // Check if over the editor panel
              const editorPanel = element.closest('[data-editor-panel]');
              if (editorPanel) {
                dropTargetRef.current = { type: 'editor', path: '' };
                return;
              }

              // Check if over the file explorer content area
              const explorerContent = element.closest('[data-explorer-content]');
              if (explorerContent && rootPath) {
                dropTargetRef.current = { type: 'root', path: rootPath };
                return;
              }
            }
          } else if (event.payload.type === 'drop') {
            const paths = event.payload.paths;
            const target = dropTargetRef.current;

            // Clear visual feedback
            document.querySelectorAll('[data-folder-path]').forEach(el => {
              el.classList.remove('bg-primary/20', 'ring-1', 'ring-primary/50');
            });

            if (!paths || paths.length === 0) return;

            if (target?.type === 'editor') {
              // Open files in editor
              for (const filePath of paths) {
                try {
                  const content = await readFileContent(filePath);
                  const filename = getFilename(filePath);
                  const language = getLanguageFromExtension(filename);
                  openFile(filePath, filename, content, language);
                } catch (err) {
                  console.error('Failed to open file:', err);
                }
              }
            } else if (target?.type === 'folder' || target?.type === 'root') {
              // Copy external files to folder
              const targetPath = target.path;
              for (const filePath of paths) {
                try {
                  const filename = getFilename(filePath);
                  const newPath = joinPath(targetPath, filename);
                  await copyPath(filePath, newPath);
                } catch (err) {
                  console.error('Failed to copy file:', err);
                }
              }
              if (target.type === 'folder') {
                expandFolder(target.path);
              }
              await refreshDirectory();
            }

            dropTargetRef.current = null;
          } else if (event.payload.type === 'leave') {
            // Clear visual feedback
            document.querySelectorAll('[data-folder-path]').forEach(el => {
              el.classList.remove('bg-primary/20', 'ring-1', 'ring-primary/50');
            });
            dropTargetRef.current = null;
          }
        });

        cleanup = unlisten;
      } catch (err) {
        console.error('Failed to setup Tauri drag-drop:', err);
      }
    };

    setupDragDrop();

    return () => {
      cleanup?.();
    };
  }, [rootPath, refreshDirectory, expandFolder, openFile]);
};
