/**
 * The last lines of a running command, as a terminal would show them.
 * Used by `ShellLiveTail`.
 */

import { stripAnsi } from "@/apps/agent/components/tool-views/ansi";

/**
 * How long a command runs before its tail opens. Most commands finish sooner,
 * so they stay one row: a tail that opened on their first line closed again
 * about 100 ms later and jerked the bottom-pinned transcript twice (probe
 * round 2, aurora-shell-live-output-designs.html: 11 height changes in one
 * turn, 3 with this delay).
 */
export const TAIL_APPEARS_AFTER_MS = 1_500;

/** The tail's open and close, matched to a tool group folding (ToolGroup). */
export const TAIL_MOTION_S = 0.18;

/**
 * Milliseconds until a command started at `startedAt` is due its tail, 0 once
 * it is. A command with no start time counts from `fallbackStart`, the moment
 * its card first saw it running.
 */
export function tailDueInMs(
  startedAt: number | undefined,
  fallbackStart: number,
  now: number,
): number {
  const start = startedAt ?? fallbackStart;
  return Math.max(0, start + TAIL_APPEARS_AFTER_MS - now);
}

/** Lines kept. The top one sits under the fade, so four read clearly. */
const TAIL_LINES = 5;
/** Only the end of the buffer can hold the last lines; never split all of it. */
const TAIL_SCAN_CHARS = 4_000;

/**
 * A carriage return without a newline is a progress bar redrawing its line, so
 * only the text after the last `\r` on each line is what a terminal shows.
 * Colours are dropped: the strip is a glance, and the full view keeps them.
 */
export function tailLines(output: string, count = TAIL_LINES): string[] {
  const lines = stripAnsi(output.length > TAIL_SCAN_CHARS ? output.slice(-TAIL_SCAN_CHARS) : output)
    .replace(/\r\n/g, "\n")
    .replace(/\n+$/, "")
    .split("\n")
    .map((line) => line.slice(line.lastIndexOf("\r") + 1));
  return lines.slice(-count);
}
