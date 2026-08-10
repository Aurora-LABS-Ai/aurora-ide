/**
 * Agent Window — in-window path drag: the wire between a drag SOURCE (the Files
 * panel) and a drop ZONE (a composer).
 *
 * Routing is done with DOM CustomEvents dispatched ON the zone element rather
 * than a global emitter, because the window can host SEVERAL composers at once
 * (the main conversation plus any docked chat). A global "a file was dropped"
 * signal has no way to say *which* composer the pointer was over; an event
 * dispatched on the element itself carries that answer by construction.
 *
 * The zone attribute is stamped by `useAgentPathDrop`, never by hand, so a zone
 * and its listener can't drift apart.
 */

/** Marks an element as a drop zone. Hit-tested with `closest()` during a drag. */
export const PATH_DROP_ZONE_ATTR = "data-agw-path-drop";

/** Pointer entered the zone while dragging a path. */
export const PATH_DRAG_OVER_EVENT = "agw-path-dragover";

/** Pointer left the zone, or the drag ended. Always paired with an over. */
export const PATH_DRAG_LEAVE_EVENT = "agw-path-dragleave";

/** Released over the zone — carries the dragged paths. */
export const PATH_DROP_EVENT = "agw-path-drop";

/** Payload of {@link PATH_DROP_EVENT}. Absolute paths, as the panels hold them. */
export interface PathDropDetail {
  paths: string[];
  /**
   * The paths are directories. Known here because the panel knew it at press
   * time — an OS drop cannot say, and defaults to false.
   */
  isDir?: boolean;
}

/** What a drop zone receives. `meta` is absent for OS drops. */
export type PathDropHandler = (
  paths: string[],
  meta?: { isDir?: boolean },
) => void;
