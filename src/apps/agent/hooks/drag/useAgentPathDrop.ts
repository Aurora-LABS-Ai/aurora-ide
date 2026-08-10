/**
 * Agent Window — in-window path drag: the DROP ZONE side.
 *
 * Deliberately mirrors `useAgentExternalDrop`'s shape (same arguments, same
 * `isDragOver` return) so a surface can accept a file the same way whether it
 * came from the OS file manager or from this window's own Files panel. The two
 * hooks are separate because the transports have nothing in common: the OS path
 * arrives on a Tauri window event with physical-pixel coordinates, this one on a
 * DOM event already addressed to the element.
 *
 * Marks the element as a zone itself, so the attribute the coordinator hit-tests
 * and the listener that receives the drop can never be wired to different nodes.
 */

import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";

import {
  PATH_DRAG_LEAVE_EVENT,
  PATH_DRAG_OVER_EVENT,
  PATH_DROP_EVENT,
  PATH_DROP_ZONE_ATTR,
  type PathDropDetail,
  type PathDropHandler,
} from "@/apps/agent/lib/path-drag";

export function useAgentPathDrop(
  targetRef: RefObject<HTMLElement | null>,
  onPaths: PathDropHandler,
): boolean {
  const [isDragOver, setIsDragOver] = useState(false);
  // Keep the latest callback without re-registering the zone every render. The
  // effect that reads it can only run after this one has committed, so the
  // handler never fires against a stale closure.
  const onPathsRef = useRef(onPaths);
  useEffect(() => {
    onPathsRef.current = onPaths;
  }, [onPaths]);

  useEffect(() => {
    const el = targetRef.current;
    if (!el) return;

    el.setAttribute(PATH_DROP_ZONE_ATTR, "");

    const onOver = () => setIsDragOver(true);
    const onLeave = () => setIsDragOver(false);
    const onDrop = (e: Event) => {
      setIsDragOver(false);
      const detail = (e as CustomEvent<PathDropDetail>).detail;
      const paths = detail?.paths ?? [];
      if (paths.length === 0) return;
      try {
        onPathsRef.current(paths, { isDir: detail?.isDir });
      } catch (err) {
        console.error("[agent-window] path drop handler failed:", err);
      }
    };

    el.addEventListener(PATH_DRAG_OVER_EVENT, onOver);
    el.addEventListener(PATH_DRAG_LEAVE_EVENT, onLeave);
    el.addEventListener(PATH_DROP_EVENT, onDrop);

    return () => {
      el.removeAttribute(PATH_DROP_ZONE_ATTR);
      el.removeEventListener(PATH_DRAG_OVER_EVENT, onOver);
      el.removeEventListener(PATH_DRAG_LEAVE_EVENT, onLeave);
      el.removeEventListener(PATH_DROP_EVENT, onDrop);
    };
  }, [targetRef]);

  return isDragOver;
}
