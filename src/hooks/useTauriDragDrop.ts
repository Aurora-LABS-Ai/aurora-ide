/**
 * Hook to handle Tauri's native drag-drop events for external files
 */
import { useEffect, useRef } from "react";

import { dispatchAttachmentDrop } from "../lib/attachment-events";
import { getFilename, getLanguageFromExtension, joinPath } from "../lib/file-utils";
import { copyPath, isTauri, readFileContent } from "../lib/tauri";
import { useEditorStore } from "../store/useEditorStore";
import { useWorkspaceStore } from "../store/useWorkspaceStore";

export const useTauriDragDrop = () => {
  const { rootPath, expandFolder, refreshDirectory } = useWorkspaceStore();
  const { openFile } = useEditorStore();
  const dropTargetRef = useRef<{ type: 'folder' | 'editor' | 'root' | 'attachment'; path: string } | null>(null);

  useEffect(() => {
    if (!isTauri()) return;

    let cleanup: (() => void) | undefined;

    const setupDragDrop = async () => {
      const clearFolderHighlights = () => {
        document.querySelectorAll('[data-folder-path]').forEach(el => {
          el.classList.remove('bg-primary/20', 'ring-1', 'ring-primary/50');
        });
      };

      const resolveDropTarget = (x: number, y: number) => {
        const element = document.elementFromPoint(x, y);
        if (!element) return null;

        const folderRow = element.closest('[data-folder-path]') as HTMLElement | null;
        if (folderRow) {
          const folderPath = folderRow.dataset.folderPath;
          if (folderPath) {
            return { type: 'folder' as const, path: folderPath };
          }
        }

        if (element.closest('[data-attachment-drop-zone]')) {
          return { type: 'attachment' as const, path: '' };
        }

        if (element.closest('[data-editor-panel]')) {
          return { type: 'editor' as const, path: '' };
        }

        if (rootPath && element.closest('[data-explorer-panel], [data-explorer-content]')) {
          return { type: 'root' as const, path: rootPath };
        }

        return null;
      };

      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        const currentWindow = getCurrentWindow();

        const unlisten = await currentWindow.onDragDropEvent(async (event) => {
          if (event.payload.type === 'over') {
            const { x, y } = event.payload.position;
            clearFolderHighlights();

            const target = resolveDropTarget(x, y);
            dropTargetRef.current = target;

            if (target?.type === 'folder') {
              const folderSelector = `[data-folder-path="${CSS.escape(target.path)}"]`;
              document.querySelector(folderSelector)?.classList.add('bg-primary/20', 'ring-1', 'ring-primary/50');
            }
          } else if (event.payload.type === 'drop') {
            const paths = event.payload.paths;
            const payloadWithPosition = event.payload as { position?: { x: number; y: number } };
            const liveTarget = payloadWithPosition.position
              ? resolveDropTarget(payloadWithPosition.position.x, payloadWithPosition.position.y)
              : null;
            const target = liveTarget ?? dropTargetRef.current;

            clearFolderHighlights();

            if (!paths || paths.length === 0) return;

            if (target?.type === 'attachment') {
              dispatchAttachmentDrop(paths);
            } else if (target?.type === 'editor') {
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
            clearFolderHighlights();
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
  }, [rootPath, expandFolder, refreshDirectory, openFile]);
};
