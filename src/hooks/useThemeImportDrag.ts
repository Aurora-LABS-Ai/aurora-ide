/**
 * Hook to handle Tauri's native drag-drop events for theme import
 */

import { useEffect, useRef, useState } from 'react';
import { isTauri, readFileContent } from '../lib/tauri';
import { useThemeStore } from '../store/useThemeStore';

export const useThemeImportDrag = () => {
    const { importTheme } = useThemeStore();
    const [isDragging, setIsDragging] = useState(false);
    // Track if we are over the valid zone
    const isOverZoneRef = useRef(false);

    useEffect(() => {
        if (!isTauri()) return;

        let cleanup: (() => void) | undefined;

        const setupDragDrop = async () => {
            try {
                const { getCurrentWindow } = await import('@tauri-apps/api/window');
                const currentWindow = getCurrentWindow();

                const unlisten = await currentWindow.onDragDropEvent(async (event) => {
                    if (event.payload.type === 'over') {
                        const { x, y } = event.payload.position;
                        const element = document.elementFromPoint(x, y);

                        if (element) {
                            // Check if over the theme settings tab container
                            const dropZone = element.closest('[data-theme-drop-zone]');

                            if (dropZone) {
                                if (!isOverZoneRef.current) {
                                    isOverZoneRef.current = true;
                                    setIsDragging(true);
                                }
                            } else {
                                if (isOverZoneRef.current) {
                                    isOverZoneRef.current = false;
                                    setIsDragging(false);
                                }
                            }
                        }
                    } else if (event.payload.type === 'drop') {
                        const paths = event.payload.paths;

                        // Only proceed if we were over the zone
                        if (isOverZoneRef.current && paths && paths.length > 0) {
                            for (const filePath of paths) {
                                if (filePath.toLowerCase().endsWith('.json')) {
                                    try {
                                        const content = await readFileContent(filePath);
                                        const json = JSON.parse(content);
                                        await importTheme(json);
                                    } catch (err) {
                                        console.error(`Failed to import theme from ${filePath}:`, err);
                                    }
                                }
                            }
                        }

                        // Reset state
                        isOverZoneRef.current = false;
                        setIsDragging(false);
                    } else if (event.payload.type === 'leave') {
                        isOverZoneRef.current = false;
                        setIsDragging(false);
                    }
                });

                cleanup = unlisten;
            } catch (err) {
                console.error('Failed to setup theme drag-drop:', err);
            }
        };

        setupDragDrop();

        return () => {
            cleanup?.();
        };
    }, [importTheme]);

    return { isDragging };
};
