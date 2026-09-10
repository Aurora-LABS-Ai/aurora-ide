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

export interface FollowBottom {
  /** Attach to the element that carries `overflow-y: auto`. */
  ref: React.RefObject<HTMLDivElement>;
  /** Attach to the same element's `onScroll`. */
  onScroll: () => void;
}

/**
 * @param active whether the box currently holds work in flight. Pass `false`
 *   and the box is left exactly where the reader put it.
 */
export function useFollowBottom(active: boolean): FollowBottom {
  const ref = useRef<HTMLDivElement>(null);
  const following = useRef(true);

  // Deliberately no dependency list. The box grows when a row is APPENDED and
  // when a row already on screen lands its result and changes height, and both
  // are ordinary re-renders of the owner — there is no single value to key on
  // that covers both. This is not per-token work: `ToolGroup` is memoized on
  // the identity of every call it holds, so a frame of pure text does not reach
  // it. Layout effect, not effect, so the pin lands in the same frame the row
  // was painted in and the box never shows a torn position.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !active || !following.current) return;
    const target = el.scrollHeight - el.clientHeight;
    // A box whose content fits has nothing to pin, and writing a value it is
    // already at would fire a scroll event for no reason.
    if (target > 0 && el.scrollTop !== target) el.scrollTop = target;
  });

  const onScroll = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    following.current = distance <= FOLLOW_THRESHOLD_PX;
  }, []);

  return { ref, onScroll };
}
