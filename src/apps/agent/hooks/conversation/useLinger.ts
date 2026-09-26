/**
 * Agent Window — keep a flag true a little after it turns false [hook].
 *
 * Used by a tool run to stay open for a moment after it stops being the live
 * edge of the turn, so it does not fold the same instant the model starts
 * writing below it. `ms = 0` is a passthrough: the hook returns `active`.
 *
 * The switch from active to inactive is noticed during render (React's
 * "adjust state when a prop changes" pattern) rather than in an effect, so the
 * held value is already true on the very render where `active` went false and
 * there is no frame in which the run looks closed.
 */

import { useEffect, useState } from "react";

export function useLinger(active: boolean, ms: number): boolean {
  const [held, setHeld] = useState(false);
  const [wasActive, setWasActive] = useState(active);

  if (wasActive !== active) {
    setWasActive(active);
    setHeld(!active && ms > 0);
  }

  useEffect(() => {
    if (!held) return;
    const id = window.setTimeout(() => setHeld(false), ms);
    return () => window.clearTimeout(id);
  }, [held, ms]);

  return active || held;
}
