/**
 * Agent Window — the one-line tally under a finished turn (pure).
 *
 * Transcript → "Turn summary". Counts what the turn DID from the calls it made:
 * distinct files changed with their line counts, commands run, and the tokens
 * the model generated. Only calls that succeeded count; a failed edit changed
 * nothing, and a rejected command never ran.
 *
 * Everything here is read from data the transcript already holds (the tool
 * calls and the usage on each message), so a reopened chat shows the same line
 * the live turn did.
 */

import { parseToolResult, isFileModifyTool } from "@/apps/agent/components/tool-views/tool-result";
import { toolStatus, type ToolCall } from "@/apps/agent/components/tools/tool-call";
import type { TimelineEvent } from "@/apps/agent/components/conversation/timeline";

/** Tools that run a command in a shell. */
const COMMAND_TOOLS: ReadonlySet<string> = new Set(["shell_execute", "shell_spawn"]);

export interface TurnSummary {
  /** Distinct files a successful edit or write touched. */
  files: number;
  added: number;
  removed: number;
  commands: number;
  /** Tokens generated across the turn; absent when no request reported any. */
  outputTokens?: number;
  outputTokensEstimated?: boolean;
}

function parseArgs(call: ToolCall): Record<string, unknown> {
  try {
    const v = JSON.parse(call.arguments || "{}");
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** One spelling per file: slashes unified, a leading `./` dropped. Windows
 *  paths are case-insensitive, so case is folded too. */
function normalizePath(path: string): string {
  return path.trim().replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
}

/** Every file a modify call names: its `path`, and each batch edit's own. */
function pathsOf(args: Record<string, unknown>): string[] {
  const top = typeof args.path === "string" ? args.path : typeof args.file_path === "string" ? args.file_path : null;
  const out: string[] = [];
  const edits = Array.isArray(args.edits) ? args.edits : [];
  for (const edit of edits) {
    const own = edit && typeof edit === "object" ? (edit as Record<string, unknown>).path : null;
    const path = typeof own === "string" && own ? own : top;
    if (path) out.push(path);
  }
  if (out.length === 0 && top) out.push(top);
  return out;
}

/**
 * The tally for one assistant turn, or `null` when the turn made no tool calls
 * at all: a reply that only talked has nothing to sum up.
 */
export function summarizeTurn(
  events: TimelineEvent[],
  outputTokens?: number,
  outputTokensEstimated?: boolean,
): TurnSummary | null {
  const files = new Set<string>();
  let added = 0;
  let removed = 0;
  let commands = 0;
  let madeCalls = false;

  for (const event of events) {
    if (event.kind !== "tool") continue;
    madeCalls = true;
    const call = event.call;
    if (toolStatus(call, false) !== "done") continue;
    if (COMMAND_TOOLS.has(call.name)) {
      commands += 1;
      continue;
    }
    if (!isFileModifyTool(call.name)) continue;
    const args = parseArgs(call);
    for (const path of pathsOf(args)) files.add(normalizePath(path));
    const stat = parseToolResult(call.name, args, call.result).stat;
    if (stat) {
      added += stat.added;
      removed += stat.removed;
    }
  }

  if (!madeCalls) return null;
  return {
    files: files.size,
    added,
    removed,
    commands,
    outputTokens,
    outputTokensEstimated: outputTokensEstimated || undefined,
  };
}

/** `1,503` / `12.4k` / `1.2M`: compact once it stops being readable whole. */
export function formatTokenCount(n: number): string {
  if (n < 10_000) return n.toLocaleString("en-US");
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 100_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}
