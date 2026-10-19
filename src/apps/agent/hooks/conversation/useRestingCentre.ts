import { useLayoutEffect, useRef, type RefObject } from "react";

/** The home scroller's top padding at rest, the same 32px it always had. */
export const HOME_TOP_PAD = 32;

/**
 * Centre a column in its scroller ONCE, at rest, then hold that top edge.
 *
 * The home screen used to centre the wordmark, project row, composer and
 * starters with `justify-content: center`. Centring is a live rule: every
 * line typed into the composer grew the column and moved the wordmark up by
 * half of it, until the editor hit its 200px cap and everything finally
 * stood still. That is what "the composer moves until it finds its place"
 * was.
 *
 * Now the column's height is read only while `resting` (the composer is
 * empty), the offset that centres THAT height is written as the scroller's
 * top padding, and typing leaves it alone: the heading stays, the composer
 * grows downward, only the starters move. The pane resizing re-centres the
 * resting height; so does the draft clearing, which brings the column back
 * to rest at a possibly different height (starters change wording).
 */
export function useRestingCentre(
  scrollerRef: RefObject<HTMLElement | null>,
  columnRef: RefObject<HTMLElement | null>,
  resting: boolean,
): void {
  const restingRef = useRef(resting);
  restingRef.current = resting;
  const restHeightRef = useRef<number | null>(null);

  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    const column = columnRef.current;
    if (!scroller || !column) return;

    const apply = () => {
      const restHeight = restHeightRef.current;
      if (restHeight === null) return;
      const padBottom = parseFloat(getComputedStyle(scroller).paddingBottom) || 0;
      const room = scroller.clientHeight - padBottom - HOME_TOP_PAD;
      const top = HOME_TOP_PAD + Math.max(0, (room - restHeight) / 2);
      scroller.style.paddingTop = `${Math.round(top)}px`;
    };
    const measure = () => {
      if (restingRef.current) restHeightRef.current = column.getBoundingClientRect().height;
      apply();
    };

    // Before first paint, so the group never flashes at the top.
    measure();
    const columnWatch = new ResizeObserver(measure);
    columnWatch.observe(column);
    const paneWatch = new ResizeObserver(apply);
    paneWatch.observe(scroller);
    return () => {
      columnWatch.disconnect();
      paneWatch.disconnect();
    };
  }, [scrollerRef, columnRef]);

  // Back to rest: the column may have settled at a new height.
  useLayoutEffect(() => {
    if (!resting) return;
    const scroller = scrollerRef.current;
    const column = columnRef.current;
    if (!scroller || !column) return;
    restHeightRef.current = column.getBoundingClientRect().height;
    const padBottom = parseFloat(getComputedStyle(scroller).paddingBottom) || 0;
    const room = scroller.clientHeight - padBottom - HOME_TOP_PAD;
    const top = HOME_TOP_PAD + Math.max(0, (room - restHeightRef.current) / 2);
    scroller.style.paddingTop = `${Math.round(top)}px`;
  }, [resting, scrollerRef, columnRef]);
}
