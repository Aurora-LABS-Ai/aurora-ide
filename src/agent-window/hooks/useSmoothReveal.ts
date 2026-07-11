/**
 * Agent Window — smooth streaming reveal [hook].
 *
 * The model's tokens arrive in BURSTS (network + batching), so rendering the raw
 * accumulated text makes the transcript lurch forward in chunks — the "cartoon /
 * lightweight" feel. This hook decouples the visual reveal from the arrival
 * cadence: it holds a `shown` string that eases toward the real `target` a few
 * characters per frame, so text flows in at a steady, weighty pace no matter how
 * chunky the underlying stream is.
 *
 *   - faster when far behind (never lets a big burst stall the reveal),
 *   - gentle as it catches up (the eased tail is what reads as "smooth"),
 *   - snaps to full the moment streaming ends (no trailing lag),
 *   - honours `prefers-reduced-motion` (returns the target verbatim).
 */

import { useEffect, useRef, useState } from "react";

const prefersReducedMotion = (): boolean =>
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export function useSmoothReveal(target: string, active: boolean): string {
  const reduce = prefersReducedMotion();
  // Initialise to whatever text is ALREADY present, not "". A fresh streaming
  // message mounts empty and then eases as tokens arrive (smooth). But when you
  // re-open a chat whose turn has been running in the background, the message
  // mounts with a large backlog — re-revealing that from zero is the "dumps all
  // at once / janky catch-up" feel. Seeding `shown` with the current target
  // shows the backlog instantly and eases ONLY the tokens that arrive from here.
  const [shown, setShown] = useState(target);
  const targetRef = useRef(target);
  const shownLenRef = useRef(target.length);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    targetRef.current = target;

    // Not streaming (or reduced motion): show everything immediately.
    if (!active || reduce) {
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      shownLenRef.current = target.length;
      // eslint-disable-next-line react-hooks/set-state-in-effect -- show full text when not animating
      setShown(target);
      return;
    }

    // Streaming content only ever grows, so a shorter target means the content
    // was swapped (thread switch / retry) — resync from the start.
    if (shownLenRef.current > target.length) {
      shownLenRef.current = 0;
    }

    if (rafRef.current != null) return; // a loop is already converging

    const step = () => {
      const tgt = targetRef.current;
      const cur = shownLenRef.current;
      if (cur >= tgt.length) {
        rafRef.current = null;
        return;
      }
      const remaining = tgt.length - cur;
      // Ease-out: big steps when far behind, ~2 chars/frame at the tail.
      const advance = Math.max(2, Math.round(remaining * 0.2));
      const next = Math.min(tgt.length, cur + advance);
      shownLenRef.current = next;
      setShown(tgt.slice(0, next));
      rafRef.current = requestAnimationFrame(step);
    };
    rafRef.current = requestAnimationFrame(step);
    // The loop reads targetRef, so subsequent target updates need no restart.
  }, [target, active, reduce]);

  // Cancel any in-flight frame on unmount.
  useEffect(
    () => () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    },
    [],
  );

  return shown;
}
