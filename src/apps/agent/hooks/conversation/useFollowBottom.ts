/**
 * Agent Window — keep a bounded, growing box pinned to its newest row [hook].
 *
 * Shared by the two places in the transcript where a run of tool rows is put in
 * a fixed-height box that scrolls inside itself: a grouped tool run
 * (`.agw-tool-group-body`) and a long MCP server lane
 * (`.agw-mcp-lane-rows[data-scroll]`). Both cap at 400px so one run can never
 * push the rest of the message off screen.
 *
 * WHAT THIS FIXES. The cap worked and nothing moved it. Past roughly the sixth
 * row the box stopped growing and every row after that landed below its fold
 * while the box sat at the top — so the one row actually running was the one
 * you could not see, and the reader had to scroll a box by hand to watch work
 * they were already watching. It compounds: once the box stops growing, the
 * transcript below it stops growing too, so `useAgentAutoScroll` sees no height
 * change and has nothing to follow either. The whole view goes still during the
 * busiest part of a turn.
 *
 * THE RULES, same as `ShellStreamView`'s follow and for the same reasons:
 *
 *   - Chase the bottom only while something in the box is RUNNING. A finished
 *     run reopened from history must show its FIRST row — that is where reading
 *     starts — and an idle box must never move under someone.
 *   - Scrolling up releases the chase; scrolling back to the bottom re-arms it.
 *     A reader who went to look at row two is not asking to be dragged back.
 *
 * Reading that release from the `scroll` event is safe HERE, even though the
 * transcript's own auto-scroll goes out of its way not to (see
 * `useAgentAutoScroll`: "a scroll event is not reader intent"). That hook
 * glides to the bottom with a per-frame lerp, so its own travel fires scroll
 * events from halfway up and reads as someone scrolling away from the live
 * edge. This one jumps straight to the bottom, so the event it causes measures
 * a distance of zero and can only ever re-arm.
 */

import { useCallback, useLayoutEffect, useRef } from "react";

/**
 * Distance from the bottom still counted as reading the live edge. The same 40
 * the live shell body uses, which here is under one row's height — so the last
 * row being all but fully visible still counts as following it.
 */
const FOLLOW_THRESHOLD_PX = 40;

/** The glide's time constant: each frame closes this share of what is left
 *  (about 90% of the way in 200ms). */
const GLIDE_TAU_MS = 90;
/** The glide never moves faster than this, about 11px a frame, so a burst
 *  (a long sentence and two calls in the same 100ms) is travelled, not jumped. */
const GLIDE_MAX_PX_PER_MS = 0.7;

export interface FollowBottomOptions {
  /**
   * Move to the newest row instead of jumping there when the CONTENT grows.
   * When the box itself resizes (a height animation the owner runs), the pin
   * stays instant, or the newest row would trail the edge it is animating.
   * A reader scrolling up mid-glide stops it and stops following.
   */
  glide?: boolean;
}

export interface FollowBottom {
  /** Attach to the element that carries `overflow-y: auto`. */
  ref: React.RefObject<HTMLDivElement>;
  /** Attach to the same element's `onScroll`. */
  onScroll: () => void;
  /** Follow again from now on, wherever the reader had scrolled to. */
  rearm: () => void;
  /** Stop following until the reader scrolls back to the bottom. */
  release: () => void;
  /** Put the box at its bottom now, if it is following. For an owner that
   *  resizes the box outside a render (a height animation). */
  pin: () => void;
  /**
   * Content of this height was removed ABOVE the view (a window dropping its
   * oldest rows): move the box up by it so what is on screen stays where it
   * is, then carry on to the newest row. Without this the rows on screen
   * jump up by the removed height in one frame.
   */
  compensate: (removedPx: number) => void;
}

/**
 * @param active whether the box currently holds work in flight. Pass `false`
 *   and the box is left exactly where the reader put it.
 * @param content the element holding the rows, when the owner re-renders far
 *   more often than the box changes size (a work card re-renders on every
 *   streamed word). The box is then pinned whenever the content or the box
 *   itself RESIZES, from a ResizeObserver, instead of after every render: no
 *   layout read per word, and growth that happens without the owner rendering
 *   (text revealing itself, a row opening on its own) is still followed.
 */
export function useFollowBottom(
  active: boolean,
  content?: React.RefObject<HTMLElement | null>,
  { glide = false }: FollowBottomOptions = {},
): FollowBottom {
  const ref = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  // Where the box was last seen, by a scroll event or by our own pin.
  const lastTop = useRef(0);
  const observed = content !== undefined;
  // The running glide, if any, and the time of its previous frame.
  const glideFrame = useRef<number | null>(null);
  const glideLast = useRef<number | null>(null);

  const stopGlide = useCallback(() => {
    if (glideFrame.current !== null) cancelAnimationFrame(glideFrame.current);
    glideFrame.current = null;
    glideLast.current = null;
  }, []);

  const pin = useCallback(() => {
    stopGlide();
    const el = ref.current;
    if (!el || !following.current) return;
    const target = el.scrollHeight - el.clientHeight;
    // A box whose content fits has nothing to pin, and writing a value it is
    // already at would fire a scroll event for no reason.
    if (target > 0 && el.scrollTop !== target) el.scrollTop = target;
    lastTop.current = el.scrollTop;
  }, [stopGlide]);

  // One loop at a time; each frame reads the target afresh, so growth that
  // lands mid-glide only extends it.
  const glideToBottom = useCallback(() => {
    if (glideFrame.current !== null || typeof requestAnimationFrame !== "function") return;
    const step = (now: number) => {
      glideFrame.current = null;
      const el = ref.current;
      if (!el || !following.current) return stopGlide();
      const target = el.scrollHeight - el.clientHeight;
      const gap = target - el.scrollTop;
      // Arrived. Checked first: content shrinking above (the window dropping
      // its oldest row, a thought folding) clamps `scrollTop` DOWN onto the
      // new bottom, which is not a reader leaving.
      if (gap <= 1) {
        if (target > 0 && gap > 0) el.scrollTop = target;
        lastTop.current = el.scrollTop;
        return stopGlide();
      }
      // Moved up since our last write and not at the bottom: a reader. Let go.
      if (el.scrollTop < lastTop.current - 1) {
        following.current = false;
        return stopGlide();
      }
      const dt = Math.min(64, now - (glideLast.current ?? now - 16));
      glideLast.current = now;
      // At least a whole pixel, or a rounding scroll position never arrives.
      const move = Math.max(1, Math.min(gap * (1 - Math.exp(-dt / GLIDE_TAU_MS)), GLIDE_MAX_PX_PER_MS * dt));
      el.scrollTop = Math.min(target, el.scrollTop + move);
      lastTop.current = el.scrollTop;
      glideFrame.current = requestAnimationFrame(step);
    };
    glideFrame.current = requestAnimationFrame(step);
  }, [stopGlide]);

  // ResizeObserver mode. Its callback runs after layout and before paint, so
  // the pin lands in the frame the growth is painted in.
  useLayoutEffect(() => {
    const el = ref.current;
    const rows = content?.current;
    if (!observed || !active || !el || !rows || typeof ResizeObserver === "undefined") return;
    pin();
    const observer = new ResizeObserver((entries) => {
      // The box resizing is the owner's own animation: stay on its edge.
      if (!glide || entries.some((entry) => entry.target === el)) pin();
      else glideToBottom();
    });
    observer.observe(rows);
    observer.observe(el);
    return () => {
      observer.disconnect();
      stopGlide();
    };
  }, [observed, active, content, pin, glide, glideToBottom, stopGlide]);

  // Deliberately no dependency list. The box grows when a row is APPENDED and
  // when a row already on screen lands its result and changes height, and both
  // are ordinary re-renders of the owner — there is no single value to key on
  // that covers both. This is not per-token work: `ToolGroup` is memoized on
  // the identity of every call it holds, so a frame of pure text does not reach
  // it. Layout effect, not effect, so the pin lands in the same frame the row
  // was painted in and the box never shows a torn position.
  useLayoutEffect(() => {
    if (!observed && active) pin();
  });

  // Only a move UP releases the chase. A scroll event arrives a frame after
  // the scroll that caused it, so the event from our own pin can be read after
  // the content has grown again: "54px from the bottom" with nobody touching
  // anything, which turned following off on a work card the moment it opened
  // (measured 2026-10-16). Growth never moves `scrollTop`; a reader scrolling
  // up always lowers it.
  const onScroll = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const top = el.scrollTop;
    const distance = el.scrollHeight - top - el.clientHeight;
    if (distance <= FOLLOW_THRESHOLD_PX) following.current = true;
    else if (top < lastTop.current - 1) following.current = false;
    lastTop.current = top;
  }, []);

  const rearm = useCallback(() => {
    following.current = true;
  }, []);

  const release = useCallback(() => {
    following.current = false;
  }, []);

  const compensate = useCallback(
    (removedPx: number) => {
      const el = ref.current;
      if (!el || removedPx <= 0) return;
      stopGlide();
      el.scrollTop = Math.max(0, el.scrollTop - removedPx);
      lastTop.current = el.scrollTop;
      if (!following.current) return;
      if (glide) glideToBottom();
      else pin();
    },
    [glide, glideToBottom, pin, stopGlide],
  );

  return { ref, onScroll, rearm, release, pin, compensate };
}
