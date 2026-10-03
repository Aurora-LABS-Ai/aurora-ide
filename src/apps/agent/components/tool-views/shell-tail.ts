/**
 * The last lines of a running command, as a terminal would show them.
 * Used by `ShellLiveTail`.
 */

import { stripAnsi } from "@/apps/agent/components/tool-views/ansi";

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
