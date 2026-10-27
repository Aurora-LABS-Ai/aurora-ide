/**
 * Agent Window — the pinned question slides away going down, comes back going
 * up [hook].
 *
 * With Transcript → Work cards on, each question is pinned to the top of the
 * transcript (the sticky-user treatment, `11-transcript-bubbles.css`), but it
 * does not stay there: as the view moves DOWN — the reader scrolling, or the
 * transcript following a reply as it is written — the pinned question slides up
 * out of view; the moment the reader scrolls UP it slides back (Alvan,
 * 2026-10-25).
 *
 * WHAT COUNTS AS MOVING. Only travel that is someone going somewhere:
 *   - the reader scrolling (wheel, touch, keys, the scrollbar) — down or up;
 *   - the transcript following the reply while the turn runs — down only.
 * Everything else that moves `scrollTop` is layout, not travel, and is
 * ignored: a work card or a step opening and the browser's anchoring keeping
 * the view steady, the turn-end quick-reply bar re-sticking to the bottom, a
 * card folding and the end of the page coming up, a resize.
 *
 * THE CASES, decided with Alvan's "every edge case" (2026-10-25):
 *   - a new question → shown, at the top (the caller jumps there and resets);
 *   - the turn finishes → shown again, as the heading of the answer just
 *     finished, until the reader scrolls down;
 *   - scrolled to the very top → shown;
 *   - keyboard focus moving into a hidden question → shown;
 *   - a question still in the flow of the page (its section's top is on
 *     screen) is never moved — only the one actually pinned is, and only once
 *     its own place has gone past the top edge (`questionPast`): hidden any
 *     earlier it left a hole where it had been (2026-10-26);
 *   - a step folding pulls the view up and the question's place comes back
 *     over the top edge: it is simply there, in the flow, with no slide in;
 *     only the reader scrolling brings it back with a slide (2026-10-26). The
 *     page is NOT held at its tallest height for this: that left empty room
 *     under the reply as tall as whatever folded, and the follow glided into
 *     it — a blank window once a running card closed (Alvan, 2026-10-26).
 *
 * Which question is pinned is read from the page, not tracked: the section at
 * the scroller's top edge (one hit-test) holds it, and only while that section
 * has scrolled past the top. The state is an attribute written straight onto
 * that element, so scrolling never re-renders React.
 */

import { useCallback, useEffect, useRef } from "react";

/** Downward travel, accumulated, before the question leaves: a nudge of the
 *  wheel or the follow catching up one line does not throw it out. */
export const HIDE_AFTER_PX = 24;
/** Upward travel, accumulated, before it comes back: any deliberate scroll up. */
export const SHOW_AFTER_PX = 8;
/** How long after a wheel tick, touch, key or scrollbar press scrolling still
 *  counts as the reader's. Longer than one frame of momentum scrolling's gaps. */
export const READER_WINDOW_MS = 300;

export type HeadroomState = "shown" | "hidden";

/** The next state from one step of travel. Pure, for tests. */
export function nextHeadroom(
  state: HeadroomState,
  travel: { down: number; up: number },
  scrollTop: number,
): HeadroomState {
  if (scrollTop <= 0) return "shown";
  if (travel.up >= SHOW_AFTER_PX) return "shown";
  if (travel.down >= HIDE_AFTER_PX) return "hidden";
  return state;
}

/**
 * Whether a change of `scrollTop` by `delta` is travel. Pure, for tests.
 * Down counts for the reader and for the follow of a running turn; up counts
 * for the reader only (a running turn never scrolls the view up by itself — an
 * upward change then is the end of the page coming up as something shrank).
 */
export function countsAsTravel(delta: number, readerActive: boolean, streaming: boolean): boolean {
  if (delta === 0) return false;
  if (readerActive) return true;
  return delta > 0 && streaming;
}

/**
 * Whether a pinned question's own place in the page has scrolled fully past
 * the top edge, so that sliding it away reveals the reply under it and not the
 * empty room it left. Pure, for tests.
 *
 * The question opens its section, so its place starts at the section's top
 * and is `height` tall. Hidden any earlier, it left a hole of its own height
 * at the top of the view (Alvan, 2026-10-26: "top area stays empty").
 */
export function questionPast(sectionTop: number, height: number, edgeTop: number): boolean {
  return sectionTop + height <= edgeTop;
}

export interface TopQuestion {
  el: HTMLElement;
  /** Its place in the page is fully above the top edge (`questionPast`). Only
   *  then may it be hidden; before that it is simply at the top, in flow. */
  past: boolean;
}

/** The question at the top edge of `scroller` (its section has scrolled past
 *  the edge, so the question is pinned there), or `null` when the section at
 *  the edge is still in flow. */
export function pinnedQuestion(scroller: HTMLElement): TopQuestion | null {
  const box = scroller.getBoundingClientRect();
  if (box.width === 0 || box.height === 0 || typeof document.elementFromPoint !== "function") return null;
  const hit = document.elementFromPoint(box.left + box.width / 2, box.top + 1);
  const section = hit?.closest<HTMLElement>(".agw-section");
  if (!section || !scroller.contains(section)) return null;
  const sectionTop = section.getBoundingClientRect().top;
  if (sectionTop >= box.top) return null;
  const el = section.querySelector<HTMLElement>(":scope > [data-uturn]");
  if (!el) return null;
  return { el, past: questionPast(sectionTop, el.offsetHeight, box.top) };
}

/** Keys that scroll a focused scroller. */
const SCROLL_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "]);

export interface QuestionHeadroom {
  /** Show the question and count travel from where the view is now. For a
   *  jump the transcript makes on its own (a new question pinned to the top). */
  reset: () => void;
}

export function useQuestionHeadroom(
  scrollerRef: React.RefObject<HTMLElement | null>,
  enabled: boolean,
  /** The open chat's turn is running: the follow's travel down counts. */
  streaming: boolean,
  /**
   * Changes whenever the scroller may have been created or replaced — the open
   * chat's id. The transcript's scroller does not exist on the home screen, so
   * listeners attached at start found nothing and were never attached again:
   * the question stayed pinned in every state (Alvan, 2026-10-25).
   */
  attachKey: string | null,
): QuestionHeadroom {
  const state = useRef<HeadroomState>("shown");
  const lastTop = useRef(0);
  const travel = useRef({ down: 0, up: 0 });
  const marked = useRef<HTMLElement | null>(null);
  const readerAt = useRef(-Infinity);
  const streamingRef = useRef(streaming);

  const apply = useCallback((scroller: HTMLElement, byReader = true) => {
    const pinned = pinnedQuestion(scroller);
    // A question whose place is still at the top edge is left where it is:
    // the attribute is written only once its place has gone past the edge.
    const target = pinned?.past ? pinned.el : null;
    const released = marked.current;
    if (released && released !== target) {
      // Released by the page moving under the view (a fold), not by the
      // reader: it is back in its place, so it does not slide in.
      const snap = !byReader && released.getAttribute("data-headroom") === "hidden";
      if (snap) released.setAttribute("data-headroom-snap", "");
      released.removeAttribute("data-headroom");
      if (snap) window.requestAnimationFrame(() => released.removeAttribute("data-headroom-snap"));
    }
    marked.current = target;
    if (target && target.getAttribute("data-headroom") !== state.current) {
      target.setAttribute("data-headroom", state.current);
    }
    // The top edge dissolves when the reply runs into it with no question
    // shown there (`.agw-transcript-topfade`).
    const questionShown = pinned !== null && (!pinned.past || state.current === "shown");
    scroller.toggleAttribute("data-top-fade", scroller.scrollTop > 0 && !questionShown);
  }, []);

  const reset = useCallback(() => {
    state.current = "shown";
    travel.current = { down: 0, up: 0 };
    const scroller = scrollerRef.current;
    if (!scroller) return;
    lastTop.current = scroller.scrollTop;
    apply(scroller);
  }, [scrollerRef, apply]);

  // The turn finishing brings the question back over its answer.
  useEffect(() => {
    const wasStreaming = streamingRef.current;
    streamingRef.current = streaming;
    if (enabled && wasStreaming && !streaming) reset();
  }, [enabled, streaming, reset]);

  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!enabled || !scroller) return;
    lastTop.current = scroller.scrollTop;
    let frame: number | null = null;

    const reader = () => {
      readerAt.current = performance.now();
    };
    const onKey = (event: KeyboardEvent) => {
      if (SCROLL_KEYS.has(event.key)) reader();
    };
    // A press on the scrollbar, not on the content: clicking a card is not
    // scrolling, and the anchoring shift it causes must not count.
    const onPointer = (event: PointerEvent) => {
      if (event.offsetX >= scroller.clientWidth) reader();
    };
    // Focus landing inside a question that is out of view brings it back.
    const onFocus = (event: FocusEvent) => {
      const question = (event.target as Element | null)?.closest?.("[data-uturn]");
      if (question && question === marked.current && state.current === "hidden") reset();
    };

    const onScroll = () => {
      if (frame !== null) return;
      // One read per frame, however many scroll events it carried.
      frame = window.requestAnimationFrame(() => {
        frame = null;
        const top = scroller.scrollTop;
        const delta = top - lastTop.current;
        lastTop.current = top;
        const readerActive = performance.now() - readerAt.current < READER_WINDOW_MS;
        if (countsAsTravel(delta, readerActive, streamingRef.current)) {
          // Travel counts in one direction; turning round starts the count again.
          travel.current =
            delta > 0 ? { down: travel.current.down + delta, up: 0 } : { down: 0, up: travel.current.up - delta };
        }
        const next = nextHeadroom(state.current, travel.current, top);
        if (next !== state.current) {
          state.current = next;
          travel.current = { down: 0, up: 0 };
        }
        apply(scroller, readerActive);
      });
    };

    scroller.addEventListener("scroll", onScroll, { passive: true });
    scroller.addEventListener("wheel", reader, { passive: true });
    scroller.addEventListener("touchstart", reader, { passive: true });
    scroller.addEventListener("touchmove", reader, { passive: true });
    scroller.addEventListener("keydown", onKey);
    scroller.addEventListener("pointerdown", onPointer);
    scroller.addEventListener("focusin", onFocus);
    apply(scroller);
    return () => {
      scroller.removeEventListener("scroll", onScroll);
      scroller.removeEventListener("wheel", reader);
      scroller.removeEventListener("touchstart", reader);
      scroller.removeEventListener("touchmove", reader);
      scroller.removeEventListener("keydown", onKey);
      scroller.removeEventListener("pointerdown", onPointer);
      scroller.removeEventListener("focusin", onFocus);
      if (frame !== null) window.cancelAnimationFrame(frame);
      scroller.removeAttribute("data-top-fade");
      marked.current?.removeAttribute("data-headroom");
      marked.current = null;
      state.current = "shown";
      travel.current = { down: 0, up: 0 };
    };
  }, [enabled, scrollerRef, apply, reset, attachKey]);

  return { reset };
}
