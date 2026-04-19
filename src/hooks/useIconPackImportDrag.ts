/**
 * Hook to handle Tauri native drag-drop events for Aurora icon-pack import.
 */
import { useEffect, useRef, useState } from "react";

import { isTauri, readFileContent } from "../lib/tauri";
import { useIconPackStore } from "../store/useIconPackStore";

export const useIconPackImportDrag = () => {
  const { importAuroraIconPack } = useIconPackStore();
  const [isDragging, setIsDragging] = useState(false);
  const isOverZoneRef = useRef(false);

  useEffect(() => {
    if (!isTauri()) return;

    let cleanup: (() => void) | undefined;

    const setupDragDrop = async () => {
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        const currentWindow = getCurrentWindow();

        const unlisten = await currentWindow.onDragDropEvent(async (event) => {
          if (event.payload.type === "over") {
            const { x, y } = event.payload.position;
            const element = document.elementFromPoint(x, y);
            const dropZone = element?.closest("[data-icon-pack-drop-zone]");

            if (dropZone && !isOverZoneRef.current) {
              isOverZoneRef.current = true;
              setIsDragging(true);
            } else if (!dropZone && isOverZoneRef.current) {
              isOverZoneRef.current = false;
              setIsDragging(false);
            }
            return;
          }

          if (event.payload.type === "drop") {
            const paths = event.payload.paths;
            if (isOverZoneRef.current && paths?.length) {
              for (const filePath of paths) {
                if (filePath.toLowerCase().endsWith(".aurora")) {
                  try {
                    const content = await readFileContent(filePath);
                    await importAuroraIconPack(content);
                  } catch (error) {
                    console.error(
                      `Failed to import Aurora icon pack from ${filePath}:`,
                      error,
                    );
                  }
                }
              }
            }

            isOverZoneRef.current = false;
            setIsDragging(false);
            return;
          }

          if (event.payload.type === "leave") {
            isOverZoneRef.current = false;
            setIsDragging(false);
          }
        });

        cleanup = unlisten;
      } catch (error) {
        console.error("Failed to setup Aurora icon pack drag-drop:", error);
      }
    };

    setupDragDrop();

    return () => cleanup?.();
  }, [importAuroraIconPack]);

  return { isDragging };
};
