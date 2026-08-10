/**
 * Agent Window — the thing you're carrying [view].
 *
 * Follows the cursor while a file is dragged out of the Files panel. It is drawn
 * to look like the `@` pill the drop will produce — same accent tint, same icon,
 * same name — so the drag reads as moving ONE object rather than triggering an
 * effect: what is in your hand is what lands in the prompt.
 *
 * POSITIONING IS NOT REACT STATE. The store's x/y changes on every mousemove;
 * rendering that through React made the ghost visibly trail and stutter behind
 * the cursor — the exact opposite of "in hand". Instead the wrapper node is
 * moved with a direct `transform` write from a store subscription: zero
 * re-renders per frame, 1:1 with the pointer. React only mounts/unmounts the
 * ghost and picks its icon.
 *
 * Two layers on purpose: the OUTER div owns `transform: translate3d(...)` (the
 * per-frame write would clobber anything else on that property), the INNER pill
 * owns the pickup scale/tilt animation. No transition on the translate: easing
 * there reads as lag, not polish.
 */

import React from "react";

import { FileIcon, FolderIcon } from "@/kernel/ui/FileIcons";
import { useAgentDragStore } from "@/apps/agent/store/ui/useAgentDragStore";

/**
 * Where the pill sits relative to the cursor hotspot. The grabbing hand must
 * visibly HOLD the pill — a gap between hand and pill breaks the illusion of
 * carrying — so the pill's top-left tucks just under the fingers. It can sit
 * this close because the ghost is pointer-events:none and invisible to the
 * coordinator's elementFromPoint hit-testing.
 */
const CURSOR_GAP_X = 2;
const CURSOR_GAP_Y = 4;

export const AgentDragGhost: React.FC = () => {
  const isDragging = useAgentDragStore((s) => s.isDragging);
  const name = useAgentDragStore((s) => s.name);
  const path = useAgentDragStore((s) => s.path);
  const isDir = useAgentDragStore((s) => s.isDir);
  const posRef = React.useRef<HTMLDivElement | null>(null);

  React.useLayoutEffect(() => {
    if (!isDragging) return;
    const apply = (x: number, y: number) => {
      posRef.current?.style.setProperty(
        "transform",
        `translate3d(${x + CURSOR_GAP_X}px, ${y + CURSOR_GAP_Y}px, 0)`,
      );
    };
    // Place it BEFORE first paint — a ghost that spawns at 0,0 and jumps to
    // the cursor is exactly the flicker this component exists to avoid.
    const initial = useAgentDragStore.getState();
    apply(initial.x, initial.y);
    const unsubscribe = useAgentDragStore.subscribe((s) => apply(s.x, s.y));
    // The hand is closed for the whole drag, wherever the cursor wanders.
    document.body.setAttribute("data-agw-dragging", "");
    return () => {
      unsubscribe();
      document.body.removeAttribute("data-agw-dragging");
    };
  }, [isDragging]);

  if (!isDragging || !name || !path) return null;

  return (
    <div ref={posRef} className="agw-drag-ghost-pos" aria-hidden>
      <div className="agw-drag-ghost">
        {isDir ? (
          <FolderIcon name={name} path={path} open={false} className="agw-pill-ico" />
        ) : (
          <FileIcon name={name} path={path} className="agw-pill-ico" />
        )}
        <span className="agw-drag-ghost-name">{name}</span>
      </div>
    </div>
  );
};
