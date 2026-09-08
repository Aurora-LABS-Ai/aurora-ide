/**
 * Agent Window — tool-call contract + status (leaf, non-component).
 *
 * Kept out of `ToolCallCard.tsx` so that file only exports a component (Fast
 * Refresh rule) and so `ToolGroup` can share the status helper without a
 * component import cycle.
 */

import { mcpServerIdForCard } from "./mcp-card";

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
  /** Epoch ms the call started executing. Set on the runtime's execution-start
   *  event and pushed forward by any approval wait, so a live clock reading
   *  `Date.now() - startedAt` lands on the same number `durationMs` will.
   *
   *  Why a card needs one at all: a spinner is identical at second 3 and second
   *  300. A `pnpm lint` that prints nothing until it finishes gave the reader
   *  no way to tell work from a hang, which is exactly the moment they need to
   *  know. Live only — absent on anything reloaded from history, the same as
   *  `durationMs`. */
  startedAt?: number;
}

export type ToolStatus = "running" | "done" | "failed";

/**
 * The tools that move the checklist. `TaskList` is not one of them — it reads,
 * changes nothing, and never reaches the transcript at all (`isSilentToolCall`).
 */
export const CHECKLIST_TOOL_NAMES: ReadonlySet<string> = new Set([
  "TaskCreate",
  "TaskUpdate",
]);

export const isChecklistCall = (call: ToolCall): boolean =>
  CHECKLIST_TOOL_NAMES.has(call.name);

/**
 * Split a run of tool calls into the STEPS the transcript draws.
 *
 * A step is one call, with two exceptions, both of which are runs the model
 * makes because the tool shape asks it to and which a reader sees as one thing:
 *
 * **Consecutive checklist calls.** Laying out a five-task plan is five
 * `TaskCreate` calls in a single message. Drawn one card per call it wrote five
 * near-identical rows and a counter climbing `0/1 … 0/5` while nothing had been
 * done. The list itself is not the transcript's to show: it lives in the header
 * indicator. The transcript says a checklist moved and stops.
 *
 * **Consecutive calls to the same MCP server.** Connecting to a server and then
 * asking it three things is one conversation with one outside party, and the
 * server's name is the same on all three rows. Grouped, the lane names it once
 * in a header and each line spends its width on the operation and the outcome
 * instead. A call to a DIFFERENT server, or any non-MCP call in between, ends
 * the run — so the grouping never reorders anything or implies an adjacency the
 * turn did not have.
 *
 * Everything else passes through as a run of one, so the caller has a single
 * shape to render and the group's own "N calls" header keeps counting real
 * calls.
 */
export const groupToolRuns = (tools: ToolCall[]): ToolCall[][] => {
  const runs: ToolCall[][] = [];
  // Resolving a server id walks the server list, so each call is asked once and
  // the answer is carried to the next iteration's comparison.
  let previousServerId: string | null = null;
  for (const call of tools) {
    const previous = runs[runs.length - 1];
    const serverId = mcpServerIdForCard(call);
    if (previous) {
      if (isChecklistCall(call) && isChecklistCall(previous[0])) {
        previous.push(call);
        previousServerId = null;
        continue;
      }
      if (serverId !== null && serverId === previousServerId) {
        previous.push(call);
        continue;
      }
    }
    runs.push([call]);
    previousServerId = serverId;
  }
  return runs;
};

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
 * edit an unread file, an exact-text match that found nothing. Only the
 * sentinel prefixes used to be checked, so every one of those rendered with a
 * green check and a "done" count. A card that claims success over its own error
 * message is worse than no card.
 *
 * Strictly TOP-LEVEL. Per-item `success` flags are a different statement: one
 * unreadable path inside a 10-file read is a partial result, not a failed call,
 * and the multi-file view reports it per row.
 *
 * **A command that ran and exited non-zero is NOT one of these.** That question
 * — did the tool do its job — is not the same question as whether the command
 * it ran was happy. `shell_execute`'s job is to run a command and report what
 * it printed with its exit code; `ls /nope` exiting 2 IS that job done, and the
 * 2 is the answer. Calling it a failed call marked one deliberate probe with a
 * red ✗ on the row, a red ✗ in the result header, and a failure in the enclosing
 * group's "2 done ✗" count — three alarms for a command that behaved exactly as
 * asked. It is the same distinction `grep` already makes: no matches is an
 * answer, not a broken search.
 *
 * A completed run always carries a numeric `exitCode`. Aurora failing to run
 * one at all (bad cwd, unknown shell, spawn error) carries `error` and no exit
 * code, and a killed-on-timeout run reports `exitCode: null` — both still read
 * as failures here, because in neither case did the command produce an answer.
 */
export function resultReportsFailure(result: string): boolean {
  const trimmed = result.trimStart();
  if (!trimmed.startsWith("{")) return false;
  // Cheap reject before any parse — most results never mention success at all.
  if (!trimmed.includes('"success"')) return false;
  if (trimmed.length > MAX_FAILURE_SCAN) return false;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return false;
    }
    const record = parsed as Record<string, unknown>;
    if (record.success !== false) return false;
    // It ran, and it told us how it ended. The outcome belongs in the row's
    // summary ("exit 2"), not in its status.
    if (typeof record.exitCode === "number") return false;
    return true;
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
