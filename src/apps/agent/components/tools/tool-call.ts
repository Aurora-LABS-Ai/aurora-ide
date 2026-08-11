/**
 * Agent Window — tool-call contract + status (leaf, non-component).
 *
 * Kept out of `ToolCallCard.tsx` so that file only exports a component (Fast
 * Refresh rule) and so `ToolGroup` can share the status helper without a
 * component import cycle.
 */

export interface ToolCall {
  id: string;
  name: string;
  /** JSON-encoded argument object (provider format). */
  arguments: string;
  result?: string | null;
  /** Wall-clock execution time, measured live in the frontend between the
   *  runtime's execution-start and result events (approval wait excluded).
   *  Absent on calls reloaded from history — the JSONL doesn't persist it. */
  durationMs?: number;
}

export type ToolStatus = "running" | "done" | "failed";

export interface StreamedToolStringArgument {
  complete: boolean;
  value: string;
}

function decodeStringFragment(raw: string, start: number, end: number): string {
  let value = "";
  for (let i = start; i < end; i++) {
    const char = raw[i];
    if (char !== "\\") {
      value += char;
      continue;
    }
    const next = raw[i + 1];
    if (next === undefined) {
      value += "\\";
      continue;
    }
    const decoded =
      next === "n"
        ? "\n"
        : next === "t"
          ? "\t"
          : next === "r"
            ? "\r"
            : next === "b"
              ? "\b"
              : next === "f"
                ? "\f"
                : next === '"' || next === "\\" || next === "/"
                  ? next
                  : `\\${next}`;
    value += decoded;
    i++;
  }
  return value;
}

function visitPropertyValues(
  raw: string,
  keys: ReadonlySet<string>,
  visit: (key: string, valueStart: number) => void,
): void {
  let stringStart = -1;
  let escaped = false;
  for (let i = 0; i < raw.length; i++) {
    const char = raw[i];
    if (stringStart >= 0) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        let cursor = i + 1;
        while (/\s/.test(raw[cursor] ?? "")) cursor++;
        if (raw[cursor] === ":") {
          const key = decodeStringFragment(raw, stringStart + 1, i);
          cursor++;
          while (/\s/.test(raw[cursor] ?? "")) cursor++;
          if (keys.has(key)) visit(key, cursor);
        }
        stringStart = -1;
      }
    } else if (char === '"') {
      stringStart = i;
    }
  }
}

export function streamedToolStringArguments(
  raw: string,
  keys: readonly string[],
): Record<string, StreamedToolStringArgument[]> {
  const values: Record<string, StreamedToolStringArgument[]> = {};
  visitPropertyValues(raw, new Set(keys), (key, valueStart) => {
    if (raw[valueStart] !== '"') return;
    let escaped = false;
    for (let i = valueStart + 1; i < raw.length; i++) {
      const char = raw[i];
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        (values[key] ??= []).push({
          complete: true,
          value: decodeStringFragment(raw, valueStart + 1, i),
        });
        return;
      }
    }
    (values[key] ??= []).push({
      complete: false,
      value: decodeStringFragment(raw, valueStart + 1, raw.length),
    });
  });
  return values;
}

export function completedToolStringArrayArgument(raw: string, key: string): string[] {
  let values: string[] = [];
  visitPropertyValues(raw, new Set([key]), (_key, valueStart) => {
    if (raw[valueStart] !== "[") return;
    const close = raw.indexOf("]", valueStart + 1);
    const segment = raw.slice(valueStart + 1, close < 0 ? raw.length : close);
    values = Array.from(segment.matchAll(/"((?:\\.|[^"\\])*)"/g), (match) =>
      decodeStringFragment(match[1], 0, match[1].length),
    );
  });
  return values;
}

/**
 * Compact human duration for tool cards: "0.4s", "1.2s", "14s", "1m 12s".
 * Sub-10s keeps one decimal (that's where most tools live); minutes drop
 * the decimal entirely.
 */
export function formatToolDuration(ms: number): string {
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

/**
 * Upper bound on a payload we'll parse just to classify it. Every structured
 * refusal is small (an error, a path, a hint); results past this are content
 * dumps, and parsing megabytes on each render to learn nothing is not a trade
 * worth making. A failure larger than this degrades to the sentinel check.
 */
const MAX_FAILURE_SCAN = 256_000;

/**
 * Does this result say, in its own words, that the tool did not do the thing?
 *
 * Rust tools report failure as `{"success": false, "error": …}` — a refusal to
 * edit an unread file, an exact-text match that found nothing, a shell command
 * that exited non-zero. Only the sentinel prefixes used to be checked, so every
 * one of those rendered with a green check and a "done" count. A card that
 * claims success over its own error message is worse than no card.
 *
 * Strictly TOP-LEVEL. Per-item `success` flags are a different statement: one
 * unreadable path inside a 10-file read is a partial result, not a failed call,
 * and the multi-file view reports it per row.
 */
export function resultReportsFailure(result: string): boolean {
  const trimmed = result.trimStart();
  if (!trimmed.startsWith("{")) return false;
  // Cheap reject before any parse — most results never mention success at all.
  if (!trimmed.includes('"success"')) return false;
  if (trimmed.length > MAX_FAILURE_SCAN) return false;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      (parsed as Record<string, unknown>).success === false
    );
  } catch {
    // Truncated or malformed → not a claim of failure we can stand behind.
    return false;
  }
}

/**
 * Infer a tool's status. `isActivelyStreaming` distinguishes a tool that is
 * genuinely in flight (turn streaming) from a stale one left "running" by a
 * previous session — the IDE treats the latter as failed.
 */
export function toolStatus(call: ToolCall, isActivelyStreaming = false): ToolStatus {
  const r = call.result;
  if (r == null || r === "") return isActivelyStreaming ? "running" : "failed";
  if (/^\s*\[(error|rejected)\]/i.test(r)) return "failed";
  if (resultReportsFailure(r)) return "failed";
  return "done";
}
