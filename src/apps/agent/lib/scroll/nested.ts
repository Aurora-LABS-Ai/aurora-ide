/**
 * Agent Window — who a wheel belongs to [helper].
 *
 * The rule for every box in the transcript, the browser's own: the innermost
 * box under the pointer that can still move that way scrolls; at its end the
 * wheel passes outward. A script that takes the wheel for a box (the running
 * work card, `work-log/pin.ts`) must first leave it to anything inside that
 * box which can still move: an expanded tool output, a long code block. The
 * running card taking every wheel froze the tool outputs inside it (Alvan,
 * 2026-10-27, "it scrolls the main work card rather than the tool expanded").
 */

const SCROLLS = new Set(["auto", "scroll", "overlay"]);

/**
 * Whether a scrollable box between `target` and `boundary` (both excluded)
 * can still move by `deltaY`. Then the wheel is that box's, not the caller's.
 */
export function innerScrollerTakes(target: EventTarget | null, boundary: Element, deltaY: number): boolean {
  if (deltaY === 0) return false;
  let el = target instanceof Element ? target : null;
  while (el && el !== boundary) {
    if (el instanceof HTMLElement && el.scrollHeight - el.clientHeight > 1 && SCROLLS.has(getComputedStyle(el).overflowY)) {
      const room = deltaY < 0 ? el.scrollTop : el.scrollHeight - el.clientHeight - el.scrollTop;
      if (room > 0.5) return true;
    }
    el = el.parentElement;
  }
  return false;
}
