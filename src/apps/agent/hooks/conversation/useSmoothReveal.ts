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
 *
 * `pace` (Transcript → Text streaming) picks the curve. `eased` is the one
 * described above and the default. `steady` plays the stream back at the rate
 * it arrived, a fifth of a second late (`steady-reveal.ts`). `instant` shows
 * every token the frame it lands. All three snap to the full text when the
 * segment stops streaming.
 */

import { useEffect, useRef, useState } from "react";

import type { TranscriptTextPace } from "@/apps/agent/theme/appearance-prefs";
import {
  createSteadyTrack,
  recordArrival,
  steadyDone,
  steadyLength,
  type SteadyTrack,
} from "@/apps/agent/hooks/conversation/steady-reveal";

/** Fraction of the remaining gap to close per 60fps frame. */
const CATCH_UP_PER_FRAME = 0.2;
/** The frame this rate was tuned against, in ms. */
const REFERENCE_FRAME_MS = 1000 / 60;
/**
 * Longest gap between frames we will honour, in ms.
 *
 * A backgrounded tab, a GC pause or a slow paint can leave a several-hundred-
 * millisecond hole. Scaling the advance by that raw delta would dump the whole
 * backlog in one frame — the exact "dumps all at once" lurch the reveal exists
 * to prevent. Clamping trades a moment of extra lag for never lurching.
 */
const MAX_FRAME_MS = 100;

/**
 * Characters to reveal this frame, given how far behind we are and how long
 * the frame actually took.
 *
 * Time-based, not frame-based. The advance used to be a flat 20% of the
 * remaining gap PER FRAME, which silently tied reveal speed to frame rate: a
 * machine rendering at 30fps revealed text at half the speed of one at 60, and
 * a fast model — which is exactly when frames are most likely to drop — made
 * the text fall further behind the harder the UI worked. Now the same 20%-per-
 * 16.7ms curve is expressed as exponential decay over elapsed time, so the
 * reveal runs at one speed on every machine.
 *
 * Exported for tests: frame-rate independence is the property worth pinning,
 * and it cannot be observed through the hook without a real render loop.
 */
export function revealAdvance(remaining: number, elapsedMs: number): number {
  if (!Number.isFinite(remaining) || remaining <= 0) return 0;
  // A non-finite delta (first frame after a clock change, or a caller bug)
  // must fall back to the reference frame — `Math.min`/`Math.max` propagate
  // NaN, which would make the advance NaN and freeze the reveal permanently.
  const dt = Number.isFinite(elapsedMs)
    ? Math.min(Math.max(elapsedMs, 0), MAX_FRAME_MS)
    : REFERENCE_FRAME_MS;
  const fraction = 1 - Math.pow(1 - CATCH_UP_PER_FRAME, dt / REFERENCE_FRAME_MS);
  // Floor of 2 so the tail always finishes instead of asymptotically crawling.
  return Math.min(remaining, Math.max(2, Math.round(remaining * fraction)));
}

const prefersReducedMotion = (): boolean =>
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export function useSmoothReveal(
  target: string,
  active: boolean,
  pace: TranscriptTextPace = "eased",
): string {
  // Instant is reduced motion by choice: no curve, the target as it stands.
  const reduce = pace === "instant" || prefersReducedMotion();
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
  /** Timestamp of the previous reveal frame, so the advance can be timed. */
  const lastFrameRef = useRef<number | null>(null);
  /** Arrival record for `steady`. Rebuilt whenever the curve changes, so a
   *  switch mid-stream starts from what is on screen, not from the start. */
  const trackRef = useRef<SteadyTrack | null>(null);
  const trackPaceRef = useRef<TranscriptTextPace | null>(null);

  useEffect(() => {
    targetRef.current = target;

    // Not streaming (or reduced motion): show everything immediately.
    if (!active || reduce) {
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      shownLenRef.current = target.length;
      trackRef.current = null;
      // eslint-disable-next-line react-hooks/set-state-in-effect -- show full text when not animating
      setShown(target);
      return;
    }

    // Streaming content only ever grows, so a shorter target means the content
    // was swapped (thread switch / retry) — resync from the start.
    const swapped = shownLenRef.current > target.length;
    if (swapped) {
      shownLenRef.current = 0;
    }

    if (pace === "steady") {
      // `performance.now()` on both sides, never the rAF timestamp: arrivals are
      // stamped here, outside any frame, and the two clocks must be the same one.
      const now = performance.now();
      if (swapped || trackRef.current === null || trackPaceRef.current !== pace) {
        trackRef.current = createSteadyTrack(now, shownLenRef.current);
      }
      recordArrival(trackRef.current, now, target.length);
    }
    trackPaceRef.current = pace;

    if (rafRef.current != null) return; // a loop is already converging

    const step = (frameTime: number) => {
      const tgt = targetRef.current;
      const cur = shownLenRef.current;
      const track = trackPaceRef.current === "steady" ? trackRef.current : null;
      if (cur >= tgt.length) {
        rafRef.current = null;
        lastFrameRef.current = null;
        return;
      }
      let next: number;
      if (track) {
        const now = performance.now();
        // Never backwards: a resync or a switch of curve can leave the track
        // behind what is already drawn, and text must not un-type itself.
        next = Math.min(tgt.length, Math.max(cur, steadyLength(track, now)));
        if (next === cur && steadyDone(track, now)) {
          // Everything recorded is on screen; the next arrival restarts the loop.
          rafRef.current = null;
          lastFrameRef.current = null;
          return;
        }
      } else {
        // First frame of a run has no predecessor to measure against; assume
        // one reference frame rather than 0, which would advance by the floor.
        const elapsed =
          lastFrameRef.current === null ? REFERENCE_FRAME_MS : frameTime - lastFrameRef.current;
        lastFrameRef.current = frameTime;
        next = Math.min(tgt.length, cur + revealAdvance(tgt.length - cur, elapsed));
      }
      if (next !== cur) {
        shownLenRef.current = next;
        setShown(tgt.slice(0, next));
      }
      rafRef.current = requestAnimationFrame(step);
    };
    lastFrameRef.current = null;
    rafRef.current = requestAnimationFrame(step);
    // The loop reads targetRef, so subsequent target updates need no restart.
  }, [target, active, reduce, pace]);

  // Cancel any in-flight frame on unmount.
  //
  // Clearing the ref is not tidiness — `rafRef.current != null` is the guard
  // that says "a loop is already converging", so a cancelled frame that leaves
  // it set blocks every future loop from ever starting. In StrictMode React
  // runs mount → cleanup → mount again on the SAME instance, refs and all: the
  // scheduled frame was cancelled here, the ref still pointed at it, and the
  // re-run effect took the early return. The reveal died at whatever text had
  // landed in the first flush — one word — and stayed there until the segment
  // stopped being the streaming one and the not-active branch snapped it to
  // full. Which is exactly what it looked like: a word, then the tools, then
  // the whole paragraph at once when the model moved on.
  useEffect(
    () => () => {
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      lastFrameRef.current = null;
    },
    [],
  );

  return shown;
}
