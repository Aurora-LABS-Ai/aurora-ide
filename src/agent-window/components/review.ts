/**
 * Agent Window — changed-files collector (leaf, non-component).
 *
 * Walks the open thread's transcript and aggregates every file the agent
 * modified into a per-file change set the Review panel renders. A file edited
 * several times in the conversation collapses to ONE entry: the diff runs from
 * its FIRST recorded original to its LATEST content, so the panel shows the net
 * change, not a pile of intermediate hunks.
 *
 * Only modify tools that emit full `oldContent`/`newContent` (parsed into
 * `diff`) contribute — an edit the backend capped on size is skipped here and
 * remains visible inline as a stats summary on its tool card.
 */

import type { DbMessage } from "../../services/thread-service";
import { buildTurns } from "./timeline";
import { computeDiff } from "./tool-views/diff";
import { parseToolResult } from "./tool-views/tool-result";

export interface FileChange {
  path: string;
  /** Absolute path, when the tool reported it (for "Open in IDE"). */
  fullPath?: string;
  fileName: string;
  oldText: string;
  newText: string;
  added: number;
  removed: number;
  /** How many tool calls touched this file. */
  edits: number;
}

/** Which slice of the conversation the Review panel diffs. */
export type ReviewScope = "all" | "lastTurn";

const MODIFY_TOOLS = new Set([
  // Current tools.
  "file_write",
  "file_edit",
  // Legacy names — kept so historical threads still render their diffs.
  "file_create",
  "file_patch",
  "search_replace",
  "multi_search_replace",
]);

function baseName(p: string): string {
  return p.split(/[/\\]/).filter(Boolean).pop() || p;
}

export function collectFileChanges(
  messages: DbMessage[],
  scope: ReviewScope = "all",
): FileChange[] {
  const order: string[] = [];
  const acc = new Map<
    string,
    { oldText: string; newText: string; edits: number; fullPath?: string }
  >();

  // "all" diffs every assistant turn; "lastTurn" only the most recent one.
  const assistantTurns = buildTurns(messages).filter((t) => t.role === "assistant");
  const scoped = scope === "lastTurn" ? assistantTurns.slice(-1) : assistantTurns;

  for (const turn of scoped) {
    for (const ev of turn.events) {
      if (ev.kind !== "tool") continue;
      const call = ev.call;
      if (!MODIFY_TOOLS.has(call.name)) continue;

      let args: Record<string, unknown> = {};
      try {
        const v = JSON.parse(call.arguments || "{}");
        if (v && typeof v === "object") args = v as Record<string, unknown>;
      } catch {
        /* keep empty */
      }

      const parsed = parseToolResult(call.name, args, call.result);

      // A single call may touch one file (`diff`) or several (`diffs`, from a
      // multi-file file_edit). Normalise to a list and fold each into the set.
      const fileDiffs = parsed.diffs ?? (parsed.diff ? [parsed.diff] : []);
      if (fileDiffs.length === 0) continue;

      for (const d of fileDiffs) {
        const path =
          d.path ||
          (args.path as string) ||
          (args.file_path as string) ||
          "";
        if (!path) continue;

        const existing = acc.get(path);
        if (existing) {
          existing.newText = d.newText; // keep the latest content
          existing.edits += 1;
          if (d.fullPath) existing.fullPath = d.fullPath;
        } else {
          acc.set(path, {
            oldText: d.oldText, // keep the earliest original
            newText: d.newText,
            edits: 1,
            fullPath: d.fullPath,
          });
          order.push(path);
        }
      }
    }
  }

  return order.map((path) => {
    const e = acc.get(path)!;
    const { added, removed } = computeDiff(e.oldText, e.newText);
    return {
      path,
      fullPath: e.fullPath,
      fileName: baseName(path),
      oldText: e.oldText,
      newText: e.newText,
      added,
      removed,
      edits: e.edits,
    };
  });
}
