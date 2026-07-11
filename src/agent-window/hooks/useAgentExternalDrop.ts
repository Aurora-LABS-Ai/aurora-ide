/**
 * Agent Window — external (OS) file drop onto the composer.
 *
 * In a Tauri webview, files dragged from the OS file manager (Windows Explorer,
 * Finder) do NOT arrive through the browser's HTML5 `drop`/`dataTransfer` — they
 * come via Tauri's window-level `onDragDropEvent` with absolute paths. This hook
 * subscribes to that event, hit-tests the drop position against the composer
 * element, and hands the absolute paths to the caller (which classifies them
 * into image attachments vs. `@path` file mentions).
 *
 * The reported position is in PHYSICAL pixels; we divide by `devicePixelRatio`
 * to compare against the composer's CSS-pixel bounding rect.
 */

import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";

import { isTauri } from "../../lib/tauri";

export function useAgentExternalDrop(
  targetRef: RefObject<HTMLElement | null>,
  onPaths: (paths: string[]) => void,
): boolean {
  const [isDragOver, setIsDragOver] = useState(false);
  // Keep the latest callback without resubscribing the (async) listener.
  const onPathsRef = useRef(onPaths);
  onPathsRef.current = onPaths;

  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: (() => void) | undefined;
    let disposed = false;

    const inTarget = (x: number, y: number): boolean => {
      const el = targetRef.current;
      if (!el) return false;
      const dpr = window.devicePixelRatio || 1;
      const lx = x / dpr;
      const ly = y / dpr;
      const r = el.getBoundingClientRect();
      return lx >= r.left && lx <= r.right && ly >= r.top && ly <= r.bottom;
    };

    void (async () => {
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        const win = getCurrentWindow();
        const off = await win.onDragDropEvent((event) => {
          const p = event.payload;
          if (p.type === "over") {
            setIsDragOver(inTarget(p.position.x, p.position.y));
          } else if (p.type === "drop") {
            const pos = (p as { position?: { x: number; y: number } }).position;
            const hit = pos ? inTarget(pos.x, pos.y) : false;
            setIsDragOver(false);
            if (hit && Array.isArray(p.paths) && p.paths.length > 0) {
              onPathsRef.current(p.paths);
            }
          } else {
            setIsDragOver(false);
          }
        });
        if (disposed) off();
        else unlisten = off;
      } catch (err) {
        console.warn("[agent-window] external drop listener failed:", err);
      }
    })();

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [targetRef]);

  return isDragOver;
}
