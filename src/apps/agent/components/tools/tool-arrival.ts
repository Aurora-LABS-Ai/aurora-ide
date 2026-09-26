/**
 * Agent Window — how tool calls arrive on screen (pure timing).
 *
 * Transcript → "Smooth tool arrival". A fast model sends its parallel calls
 * within a few milliseconds of each other, so without pacing a batch of five
 * cards appears in one frame. The stagger below lets them in one after another
 * instead: each new step is given the next free slot, `ARRIVAL_STEP_MS` after
 * the previous one, and never waits longer than `ARRIVAL_MAX_DELAY_MS` however
 * large the batch is.
 *
 * Only the drawing is delayed. The calls themselves run, finish and report
 * exactly when they would have; nothing here touches the stream.
 */

/** Gap between two steps that arrive together. */
export const ARRIVAL_STEP_MS = 40;

/** Longest any one step waits for its slot. 11 is the largest batch seen in
 *  real sessions; at 40ms apart that would be 440ms, which reads as lag. */
export const ARRIVAL_MAX_DELAY_MS = 240;

/** How long a finished run stays open after something lands below it, before
 *  it folds to its summary line. */
export const RUN_LINGER_MS = 600;

export interface ArrivalStagger {
  /** The delay, in ms, for a step first drawn at `now`. */
  next(now: number): number;
}

/**
 * One stagger per tool run. Slots are handed out in call order, so the delay a
 * step gets depends only on how recently the previous step was scheduled: a
 * call that arrives on its own, well after the last one, gets no delay at all.
 */
export function createArrivalStagger(
  stepMs: number = ARRIVAL_STEP_MS,
  maxDelayMs: number = ARRIVAL_MAX_DELAY_MS,
): ArrivalStagger {
  let lastSlot = Number.NEGATIVE_INFINITY;
  return {
    next(now: number): number {
      const slot = Math.min(Math.max(now, lastSlot + stepMs), now + maxDelayMs);
      lastSlot = slot;
      return slot - now;
    },
  };
}
