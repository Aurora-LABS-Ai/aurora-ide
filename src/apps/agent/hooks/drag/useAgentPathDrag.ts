/**
 * Agent Window — in-window path drag: the COORDINATOR.
 *
 * Mounted once per window. Owns the document-level pointer listeners, promotes a
 * pending press into a drag once it travels, hit-tests the pointer against drop
 * zones, and delivers the payload to the zone under the release.
 *
 * Hit-testing uses `elementFromPoint` + `closest()` rather than per-zone
 * `mouseenter`, so a zone that appears, moves, or scrolls mid-drag is still found
 * — and so the drag ghost must stay `pointer-events: none`, or it would be the
 * element under the cursor at every sample.
 */

import { useEffect } from "react";

import {
  PATH_DRAG_LEAVE_EVENT,
  PATH_DRAG_OVER_EVENT,
  PATH_DROP_EVENT,
  PATH_DROP_ZONE_ATTR,
  type PathDropDetail,
} from "@/apps/agent/lib/path-drag";
import { useAgentDragStore } from "@/apps/agent/store/ui/useAgentDragStore";

export function useAgentPathDrag(): void {
  useEffect(() => {
    // The zone currently highlighted. Held here (not in the store) because only
    // this hook and the zone itself care, and a store write per mousemove would
    // re-render every subscriber for a value nobody renders.
    let zone: HTMLElement | null = null;

    const setZone = (next: HTMLElement | null) => {
      if (next === zone) return;
      zone?.dispatchEvent(new CustomEvent(PATH_DRAG_LEAVE_EVENT));
      zone = next;
      zone?.dispatchEvent(new CustomEvent(PATH_DRAG_OVER_EVENT));
    };

    const onMouseMove = (e: MouseEvent) => {
      const store = useAgentDragStore.getState();
      store.moveTo(e.clientX, e.clientY);
      // `moveTo` may have just promoted the press into a drag, so re-read.
      if (!useAgentDragStore.getState().isDragging) return;
      const under = document.elementFromPoint(e.clientX, e.clientY);
      setZone(under?.closest<HTMLElement>(`[${PATH_DROP_ZONE_ATTR}]`) ?? null);
    };

    const onMouseUp = () => {
      const { isDragging, pendingPath, path, isDir, end } =
        useAgentDragStore.getState();
      // An ordinary click anywhere in the window: nothing staged, nothing to do.
      if (!isDragging && !pendingPath) return;
      const target = zone;
      setZone(null);
      end();
      if (isDragging && path && target) {
        target.dispatchEvent(
          new CustomEvent<PathDropDetail>(PATH_DROP_EVENT, {
            detail: { paths: [path], isDir },
          }),
        );
      }
    };

    const cancel = () => {
      setZone(null);
      useAgentDragStore.getState().end();
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") cancel();
    };

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
    document.addEventListener("keydown", onKeyDown);
    // Releasing outside the window never reaches `mouseup`; without this the
    // ghost would still be following the cursor when the user comes back.
    window.addEventListener("blur", cancel);

    return () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("blur", cancel);
      setZone(null);
    };
  }, []);
}
