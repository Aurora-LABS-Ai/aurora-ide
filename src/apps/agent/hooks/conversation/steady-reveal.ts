/**
 * Agent Window — steady streaming reveal (pure).
 *
 * Transcript → Text streaming → "Steady". The eased reveal in
 * `useSmoothReveal` closes a fixed share of the remaining gap every frame, so a
 * burst still reads as a burst: it surges, then crawls to a stop, then the next
 * one surges. This plays the stream back instead.
 *
 * Every time more text arrives, its length and arrival time are recorded. The
 * screen then shows the length the stream had `STEADY_DELAY_MS` ago,
 * interpolated between arrivals. A burst that lands after a 150ms pause is
 * spread across those 150ms, so the text moves at the rate the model actually
 * produced it, evenly, a fifth of a second behind.
 *
 * A pause LONGER than the delay is a real pause: nothing arrived, so nothing is
 * shown. The burst after it plays out over at most `STEADY_DELAY_MS`, starting
 * the moment it lands, rather than partly jumping in to make up lost time.
 */

/** How far behind the stream the reveal runs. Covers the gaps real providers
 *  leave between bursts (70–310ms measured), so most bursts are spread fully. */
export const STEADY_DELAY_MS = 200;

interface Sample {
  /** When this length is due on screen, minus the delay. */
  t: number;
  len: number;
}

export interface SteadyTrack {
  samples: Sample[];
}

/** A track whose text is already fully on screen at `now`. */
export function createSteadyTrack(now: number, len: number): SteadyTrack {
  return { samples: [{ t: now - STEADY_DELAY_MS, len }] };
}

/** Record that the stream is `len` characters long at `now`. */
export function recordArrival(track: SteadyTrack, now: number, len: number): void {
  const last = track.samples[track.samples.length - 1];
  if (len <= last.len) return;
  // After a pause longer than the delay, start this burst from where the
  // screen is NOW instead of interpolating across the whole pause, part of
  // which is already in the past.
  if (last.t < now - STEADY_DELAY_MS) {
    track.samples.push({ t: now - STEADY_DELAY_MS, len: last.len });
  }
  track.samples.push({ t: now, len });
}

/**
 * How many characters belong on screen at `now`. Drops samples that are fully
 * in the past, so the track stays a handful of entries long however long the
 * reply is.
 */
export function steadyLength(track: SteadyTrack, now: number): number {
  const at = now - STEADY_DELAY_MS;
  const { samples } = track;
  let i = 0;
  while (i + 1 < samples.length && samples[i + 1].t <= at) i += 1;
  if (i > 0) samples.splice(0, i);
  const from = samples[0];
  const to = samples[1];
  if (!to || at <= from.t) return from.len;
  const progress = (at - from.t) / (to.t - from.t);
  return Math.floor(from.len + (to.len - from.len) * progress);
}

/** True once everything recorded has been played out. */
export function steadyDone(track: SteadyTrack, now: number): boolean {
  const last = track.samples[track.samples.length - 1];
  return last.t <= now - STEADY_DELAY_MS;
}
