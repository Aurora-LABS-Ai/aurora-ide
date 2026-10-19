/**
 * Where the model menu opens and how tall it may be.
 *
 * The menu is absolutely positioned inside the composer, so what cuts it off
 * is not the window but the nearest ancestor that clips its overflow (the
 * rounded main panel, a scroller). Measuring against `window.innerHeight`
 * opened it downward into a panel that ended earlier and the bottom rows were
 * cut off (Alvan, 2026-10-16).
 */

export interface VerticalBounds {
  top: number;
  bottom: number;
}

/** Leaves a little air between the menu and the edge that clips it. */
const EDGE_MARGIN = 8;
/** Below this the head and search box alone would not fit. */
const MIN_MENU_HEIGHT = 160;
/**
 * Room below that is enough to open down. Down is the home screen's direction
 * (the composer sits mid-panel with the suggestions under it); up is only for
 * a composer docked low, as in a chat. Measured 2026-10-16 on the empty state:
 * 442px below, 484px above. Picking the larger side flipped it upward over the
 * wordmark.
 */
const ENOUGH_ROOM_BELOW = 320;

function clips(style: CSSStyleDeclaration): boolean {
  return [style.overflow, style.overflowX, style.overflowY].some(
    (v) => v === "hidden" || v === "auto" || v === "scroll" || v === "clip",
  );
}

export interface Bounds extends VerticalBounds {
  left: number;
  right: number;
}

/**
 * The visible area `el` can draw into: the window, narrowed by every ancestor
 * that clips overflow.
 */
export function visibleRect(el: Element | null, viewportWidth: number, viewportHeight: number): Bounds {
  let top = 0;
  let bottom = viewportHeight;
  let left = 0;
  let right = viewportWidth;
  for (let node = el?.parentElement ?? null; node; node = node.parentElement) {
    if (!clips(getComputedStyle(node))) continue;
    const rect = node.getBoundingClientRect();
    top = Math.max(top, rect.top);
    bottom = Math.min(bottom, rect.bottom);
    left = Math.max(left, rect.left);
    right = Math.min(right, rect.right);
  }
  return { top, bottom, left, right };
}

/** The vertical part of [`visibleRect`]. */
export function visibleBounds(el: Element | null, viewportHeight: number): VerticalBounds {
  const { top, bottom } = visibleRect(el, Number.POSITIVE_INFINITY, viewportHeight);
  return { top, bottom };
}

/** Space between the menu and the effort list beside it. */
const FLYOUT_GAP = 6;
/** The list's title line sits above its first choice; this lines the first
 *  choice up with the row it belongs to. */
const FLYOUT_TITLE_OFFSET = 30;

/**
 * Where a row's effort list goes: beside the menu on the right, or on the left
 * when the panel has no room there, lined up with its row and moved up or down
 * just enough to stay inside the panel. Viewport coordinates.
 */
export function placeFlyout(
  menu: Pick<Bounds, "left" | "right">,
  row: VerticalBounds,
  size: { width: number; height: number },
  bounds: Bounds,
): { left: number; top: number } {
  const onRight = menu.right + FLYOUT_GAP;
  const onLeft = menu.left - FLYOUT_GAP - size.width;
  const left =
    onRight + size.width <= bounds.right - EDGE_MARGIN
      ? onRight
      : onLeft >= bounds.left + EDGE_MARGIN
        ? onLeft
        : Math.max(bounds.left + EDGE_MARGIN, bounds.right - EDGE_MARGIN - size.width);
  const lowest = bounds.bottom - EDGE_MARGIN - size.height;
  const top = Math.max(bounds.top + EDGE_MARGIN, Math.min(row.top - FLYOUT_TITLE_OFFSET, lowest));
  return { left, top };
}

/**
 * Open down when there is room for a usable list there, else toward the
 * roomier side, and cap the height to what that side holds.
 */
export function placeMenu(
  trigger: VerticalBounds,
  bounds: VerticalBounds,
  maxHeight: number,
  gap: number,
): { placement: "up" | "down"; height: number } {
  const below = bounds.bottom - trigger.bottom - gap - EDGE_MARGIN;
  const above = trigger.top - bounds.top - gap - EDGE_MARGIN;
  const placement = below >= Math.min(maxHeight, ENOUGH_ROOM_BELOW) || below >= above ? "down" : "up";
  const room = placement === "down" ? below : above;
  return { placement, height: Math.max(MIN_MENU_HEIGHT, Math.min(maxHeight, Math.floor(room))) };
}
