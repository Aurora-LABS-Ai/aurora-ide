/**
 * Agent Window — what the composer's `@` picker lists, grouped (pure).
 *
 * Probe: Documents/aurora-mention-picker-designs.html, 02 "Grouped, what you
 * mean first" (Alvan's pick, 2026-10-12).
 *
 * A bare `@` used to list the shortest paths in the project — README, config
 * files — which is almost never what anyone means. The files someone is most
 * likely to name are the ones already in front of them, so a bare `@` leads
 * with those:
 *
 *   Open          files open in the dock
 *   In this chat  files this conversation read or changed, newest first
 *   Terminals     open terminal sessions
 *   Project       the project's top-level folders
 *
 * Once something is typed it is a search: Terminals (only when the query names
 * one), Files, then Folders, best first.
 */

import {
  folderIndex,
  rankFilesWithMatches,
  type MentionFile,
} from "@/apps/agent/adapters/file-index";
import type { TerminalSessionSummary } from "@/apps/agent/services/terminal/terminal-sessions";

export type MentionRow =
  | { kind: "file"; file: MentionFile; matches: number[] }
  | { kind: "folder"; file: MentionFile; matches: number[] }
  | { kind: "terminal"; session: TerminalSessionSummary };

export interface MentionGroup {
  label: string;
  rows: MentionRow[];
}

/** Files listed under "In this chat". */
const RECENT_LIMIT = 6;
/** Files listed once something is typed; the list scrolls. */
const FILE_LIMIT = 40;
/** Folders listed once something is typed — a few, after the files. */
const FOLDER_LIMIT = 8;

/** Argument fields a tool call names a file in. */
const PATH_FIELDS = ["path", "file_path", "paths", "target", "source", "destination"];

/**
 * The files this conversation's tool calls touched, newest first, as entries
 * of `files` (so only files that still exist are offered). Arguments are the
 * model's to shape, so this reads the usual fields and skips anything else.
 */
export function chatFiles(
  messages: ReadonlyArray<{ tool_calls?: ReadonlyArray<{ arguments: string }> | null }>,
  files: MentionFile[],
  root: string | null,
  limit = RECENT_LIMIT,
): MentionFile[] {
  if (files.length === 0) return [];
  const byRel = new Map(files.map((f) => [f.rel.toLowerCase(), f]));
  const rootNorm = root ? root.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase() : null;
  const toRel = (raw: string): string => {
    let p = raw.trim().replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
    if (rootNorm && p.startsWith(`${rootNorm}/`)) p = p.slice(rootNorm.length + 1);
    return p;
  };
  const out: MentionFile[] = [];
  const seen = new Set<string>();
  for (let m = messages.length - 1; m >= 0 && out.length < limit; m--) {
    const calls = messages[m].tool_calls ?? [];
    for (let c = calls.length - 1; c >= 0 && out.length < limit; c--) {
      let args: Record<string, unknown>;
      try {
        args = JSON.parse(calls[c].arguments) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (!args || typeof args !== "object") continue;
      for (const field of PATH_FIELDS) {
        const value = args[field];
        const candidates = Array.isArray(value) ? value : [value];
        for (const candidate of candidates) {
          if (typeof candidate !== "string" || !candidate.trim()) continue;
          const hit = byRel.get(toRel(candidate));
          if (hit && !seen.has(hit.rel)) {
            seen.add(hit.rel);
            out.push(hit);
          }
        }
      }
    }
  }
  return out;
}

/** The dock's open files, as entries of `files`. */
export function openFiles(paths: string[], files: MentionFile[], root: string | null): MentionFile[] {
  return chatFiles(
    [{ tool_calls: paths.map((path) => ({ arguments: JSON.stringify({ path }) })) }],
    files,
    root,
    paths.length,
  ).reverse();
}

function terminalMatches(session: TerminalSessionSummary, q: string): boolean {
  return (
    session.title.toLowerCase().includes(q) ||
    session.shell.toLowerCase().includes(q) ||
    "terminal".startsWith(q)
  );
}

/** The `@` picker's groups for `query`. Empty groups are left out. */
export function buildMentionGroups(input: {
  query: string;
  files: MentionFile[];
  root: string | null;
  open: MentionFile[];
  inChat: MentionFile[];
  terminals: TerminalSessionSummary[];
}): MentionGroup[] {
  const q = input.query.trim().toLowerCase();
  const groups: MentionGroup[] = [];
  const asFiles = (list: MentionFile[]): MentionRow[] =>
    list.map((file) => ({ kind: "file", file, matches: [] }));

  if (!q) {
    const open = input.open;
    const openRels = new Set(open.map((f) => f.rel));
    const inChat = input.inChat.filter((f) => !openRels.has(f.rel));
    if (open.length) groups.push({ label: "Open", rows: asFiles(open) });
    if (inChat.length) groups.push({ label: "In this chat", rows: asFiles(inChat) });
    if (input.terminals.length) {
      groups.push({
        label: "Terminals",
        rows: input.terminals.map((session) => ({ kind: "terminal", session })),
      });
    }
    const top = folderIndex(input.files, input.root)
      .filter((f) => !f.rel.includes("/"))
      .sort((a, b) => a.name.localeCompare(b.name));
    if (top.length) {
      groups.push({
        label: "Project",
        rows: top.map((file) => ({ kind: "folder", file, matches: [] })),
      });
    }
    return groups;
  }

  const terminals = input.terminals.filter((s) => terminalMatches(s, q));
  if (terminals.length) {
    groups.push({ label: "Terminals", rows: terminals.map((session) => ({ kind: "terminal", session })) });
  }
  const files = rankFilesWithMatches(input.files, q, FILE_LIMIT);
  if (files.length) {
    groups.push({
      label: "Files",
      rows: files.map(({ file, matches }) => ({ kind: "file", file, matches })),
    });
  }
  const folders = rankFilesWithMatches(folderIndex(input.files, input.root), q, FOLDER_LIMIT);
  if (folders.length) {
    groups.push({
      label: "Folders",
      rows: folders.map(({ file, matches }) => ({ kind: "folder", file, matches })),
    });
  }
  return groups;
}

/** Every row of `groups`, in order — what ↑ ↓ move through. */
export function flattenGroups(groups: MentionGroup[]): MentionRow[] {
  return groups.flatMap((g) => g.rows);
}
