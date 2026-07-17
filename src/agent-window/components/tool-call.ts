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
 * Infer a tool's status. `isActivelyStreaming` distinguishes a tool that is
 * genuinely in flight (turn streaming) from a stale one left "running" by a
 * previous session — the IDE treats the latter as failed.
 */
export function toolStatus(call: ToolCall, isActivelyStreaming = false): ToolStatus {
  const r = call.result;
  if (r == null || r === "") return isActivelyStreaming ? "running" : "failed";
  if (/^\s*\[(error|rejected)\]/i.test(r)) return "failed";
  return "done";
}
