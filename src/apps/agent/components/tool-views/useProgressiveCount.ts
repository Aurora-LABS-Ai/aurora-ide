/**
 * Agent Window — draw a long list in two steps [hook].
 *
 * A code or diff box shows about fifteen lines (it is height-capped), but it
 * used to build every line of the file the moment its card opened, under the
 * opening motion. This returns how many to draw: the first `first` at once,
 * all of them once the motion has run. The box's height does not change
 * between the two, so nothing moves; only its scroll range grows.
 */

import { useEffect, useState } from "react";

/** Long enough for a card's opening motion (0.22–0.3 s) to finish. */
const REST_AFTER_MS = 320;

export function useProgressiveCount(total: number, first = 80): number {
  // Not seeded from `total`: a view whose lines arrive a moment later (colours
  // landing) starts at 0 and would count as "all shown" before it had any.
  const [all, setAll] = useState(false);
  useEffect(() => {
    if (all || total <= first) return; // nothing held back yet
    const timer = window.setTimeout(() => setAll(true), REST_AFTER_MS);
    return () => window.clearTimeout(timer);
  }, [all, total, first]);
  return all ? total : Math.min(total, first);
}
