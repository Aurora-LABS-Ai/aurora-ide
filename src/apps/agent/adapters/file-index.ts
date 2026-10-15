/**
 * Agent Window — workspace file index (adapter / inbound channel).
 *
 * The agent window is a separate OS window and does NOT mount the IDE explorer,
 * so `useWorkspaceStore.files` is empty here. `@`-file mentions and the Files
 * panel get their own flat list from `explorer_list_files`, which walks the
 * project once in Rust (honouring `.gitignore`, keeping dot-folders such as
 * `.knowledge`, skipping `.git` and `node_modules`) and answers in tens of
 * milliseconds. It replaced a frontend walk that called `read_directory` once
 * per folder and stopped at 6,000 files: hundreds of round trips before the
 * picker could show anything, and files past the cap could never be found.
 *
 * Cached per root. A change on disk marks the cache STALE rather than dropping
 * it: the picker keeps showing the last list while a fresh one loads, instead
 * of going empty after every turn.
 */

import { auroraInvoke } from "@/kernel/lib/ipc/runtime";

export interface MentionFile {
  name: string;
  /** Absolute path (for "Open in IDE" / reading). */
  path: string;
  /** Path relative to the project root, always with `/` (for display + matching). */
  rel: string;
  /** A folder rather than a file (the `@` picker offers both). Absent = file. */
  kind?: "folder";
}

interface FileList {
  files: string[];
  truncated: boolean;
}

const cache = new Map<string, MentionFile[]>();
const stale = new Set<string>();
const inflight = new Map<string, Promise<MentionFile[]>>();

/**
 * Path as written relative to the project root, or the absolute path unchanged
 * when it falls outside that root. Shared with the composer so a file mention
 * reads the same whether it was picked from `@` or dragged in.
 */
export function relativize(root: string, path: string): string {
  const r = root.replace(/[/\\]+$/, "");
  if (path.startsWith(r)) return path.slice(r.length).replace(/^[/\\]+/, "");
  return path;
}

/** `rel` (always `/`) joined onto `root` with the root's own separator. */
function absolute(root: string, rel: string): string {
  const sep = root.includes("\\") ? "\\" : "/";
  return `${root.replace(/[/\\]+$/, "")}${sep}${rel.split("/").join(sep)}`;
}

function toMentionFiles(root: string, list: FileList): MentionFile[] {
  if (list.truncated) {
    console.warn(
      `[agent-window] file index for ${root} stopped at ${list.files.length} files; the rest cannot be @-mentioned`,
    );
  }
  return list.files.map((rel) => ({
    name: rel.slice(rel.lastIndexOf("/") + 1),
    path: absolute(root, rel),
    rel,
  }));
}

/**
 * Load (and cache) the project's file list. Concurrent calls share one walk. A
 * fresh cache answers at once; a stale one is replaced by a new walk.
 */
export async function loadFileIndex(root: string | null): Promise<MentionFile[]> {
  if (!root) return [];
  const hit = cache.get(root);
  if (hit && !stale.has(root)) return hit;
  const pending = inflight.get(root);
  if (pending) return pending;

  const p = auroraInvoke<FileList>("explorer_list_files", { root })
    .then((list) => {
      const files = toMentionFiles(root, list);
      cache.set(root, files);
      stale.delete(root);
      inflight.delete(root);
      return files;
    })
    .catch((err) => {
      inflight.delete(root);
      console.warn("[agent-window] file index failed:", err);
      // A failed refresh keeps the last good list rather than emptying the picker.
      return cache.get(root) ?? [];
    });
  inflight.set(root, p);
  return p;
}

/** The project's file list needs reloading before it is trusted again. */
export function isFileIndexStale(root: string | null): boolean {
  return !!root && (stale.has(root) || !cache.has(root));
}

/**
 * Mark the cache stale (call after the agent writes/creates/deletes files).
 * The old list stays readable until the next load replaces it.
 */
export function invalidateFileIndex(root?: string): void {
  if (root) {
    if (cache.has(root)) stale.add(root);
  } else {
    for (const key of cache.keys()) stale.add(key);
  }
}

/** How a file matched a query; lower is better. */
const EXACT_NAME = 0;
const NAME_PREFIX = 1;
const NAME_CONTAINS = 2;
const FOLDER_PREFIX = 3;
const PATH_CONTAINS = 4;
const NAME_LETTERS = 5;
const PATH_LETTERS = 6;

/**
 * How spread out a typed path's letters may be across a whole path, per
 * letter. Only used when the query has a `/` in it.
 */
const PATH_LETTERS_SPREAD = 3;

/**
 * Whether `query`'s characters appear in `text` in order. Returns how spread
 * out they are — smaller is a tighter match — or -1 when they do not all
 * appear. Any position counts; used only for a typed path.
 */
function lettersInOrder(text: string, query: string): number {
  let at = -1;
  let first = -1;
  for (const ch of query) {
    at = text.indexOf(ch, at + 1);
    if (at < 0) return -1;
    if (first < 0) first = at;
  }
  return at - first;
}

/** A position where a word starts in a file name: its start, after `-` `_`
 *  `.` or a space, or a capital following a lower-case letter (camelCase). */
function startsWord(name: string, i: number): boolean {
  if (i === 0) return true;
  const prev = name[i - 1];
  const ch = name[i];
  if ("-_. ".includes(prev)) return true;
  return ch !== ch.toLowerCase() && prev === prev.toLowerCase() && prev !== prev.toUpperCase();
}

/**
 * Whether `query`'s letters spell out the file NAME the way people abbreviate
 * it: each letter either starts a word or follows the previous match directly
 * (`agcomp` → **A**g**Comp**oser, `qom` → **Q**uick**O**pen**M**odal).
 * Returns the positions of the matched letters, or `null`.
 *
 * Letters found anywhere in order matched almost every long name on this
 * repository: `agcomp` returned `aurora-light-complete.json` (the `g` of
 * li*g*ht) and, through the path, `components/files/review.ts`, burying the
 * one file it meant.
 */
function lettersAtWords(name: string, query: string): number[] | null {
  const lower = name.toLowerCase();
  // The first letter that fits is not always the one that lets the rest fit
  // (`file-index.ts` must take the `t` of `.ts`, not of `test`), so every
  // valid position is tried; a (letter, position) that led nowhere once is
  // not tried again. Names are short, so this stays tiny.
  const dead = new Set<number>();
  const walk = (qi: number, prev: number): number[] | null => {
    if (qi === query.length) return [];
    const key = qi * 4096 + prev + 1;
    if (dead.has(key)) return null;
    for (let i = prev + 1; i < lower.length; i++) {
      if (lower[i] !== query[qi]) continue;
      const follows = prev >= 0 && i === prev + 1;
      if (!follows && !startsWord(name, i)) continue;
      const rest = walk(qi + 1, i);
      if (rest) return [i, ...rest];
    }
    dead.add(key);
    return null;
  };
  return walk(0, -1);
}

/** Positions `from`..`from + length` — a run of matched letters. */
function run(from: number, length: number): number[] {
  return Array.from({ length }, (_, k) => from + k);
}

/** A ranked file and which letters of its NAME matched, for highlighting. */
export interface RankedFile {
  file: MentionFile;
  matches: number[];
}

/**
 * Rank files against a query, best first, at most `limit`.
 *
 * Order: exact file name, file name starting with the query, file name
 * containing it, a folder on the path starting with it, the path containing
 * it, then the query as an abbreviation of the name (`agcomp`).
 * A query with `/` or `\` is matched against the whole path (`composer/Agent`),
 * where letters close together in order also count.
 * Ties go to the tighter letter match, then the shorter path.
 */
export function rankFiles(files: MentionFile[], query: string, limit = 50): MentionFile[] {
  return rankFilesWithMatches(files, query, limit).map((r) => r.file);
}

/** [`rankFiles`], with the matched letters of each name for highlighting. */
export function rankFilesWithMatches(
  files: MentionFile[],
  query: string,
  limit = 50,
): RankedFile[] {
  const q = query.trim().toLowerCase().replace(/\\/g, "/").replace(/^\.\//, "");
  if (!q) {
    return [...files]
      .sort((a, b) => a.rel.length - b.rel.length)
      .slice(0, limit)
      .map((file) => ({ file, matches: [] }));
  }
  const pathQuery = q.includes("/");
  const scored: Array<{ f: MentionFile; score: number; spread: number; matches: number[] }> = [];
  for (const f of files) {
    const name = f.name.toLowerCase();
    const rel = f.rel.toLowerCase();
    let score = -1;
    let spread = 0;
    let matches: number[] = [];
    if (pathQuery) {
      if (rel.endsWith(q)) score = NAME_PREFIX;
      else if (rel.includes(q)) score = PATH_CONTAINS;
      else {
        spread = lettersInOrder(rel, q.replace(/\//g, ""));
        if (spread >= 0 && spread <= q.length * PATH_LETTERS_SPREAD) score = PATH_LETTERS;
      }
      // Light up the part of the name the last path segment typed.
      const last = q.slice(q.lastIndexOf("/") + 1);
      const at = last ? name.indexOf(last) : -1;
      if (at >= 0) matches = run(at, last.length);
    } else if (name === q) {
      score = EXACT_NAME;
      matches = run(0, q.length);
    } else if (name.startsWith(q)) {
      score = NAME_PREFIX;
      matches = run(0, q.length);
    } else if (name.includes(q)) {
      score = NAME_CONTAINS;
      matches = run(name.indexOf(q), q.length);
    } else if (rel.split("/").some((part) => part.startsWith(q))) score = FOLDER_PREFIX;
    else if (rel.includes(q)) score = PATH_CONTAINS;
    else {
      const letters = lettersAtWords(f.name, q);
      if (letters) {
        score = NAME_LETTERS;
        spread = letters[letters.length - 1] - letters[0];
        matches = letters;
      }
    }
    if (score >= 0) scored.push({ f, score, spread, matches });
  }
  scored.sort(
    (a, b) => a.score - b.score || a.spread - b.spread || a.f.rel.length - b.f.rel.length,
  );
  return scored.slice(0, limit).map((s) => ({ file: s.f, matches: s.matches }));
}

const folderCache = new WeakMap<MentionFile[], MentionFile[]>();

/**
 * Every folder that holds a file in `files`, as mention entries
 * (`kind: "folder"`). Derived from the file list rather than walked again, and
 * remembered per list, so it is computed once per refresh.
 */
export function folderIndex(files: MentionFile[], root: string | null): MentionFile[] {
  const hit = folderCache.get(files);
  if (hit) return hit;
  const seen = new Set<string>();
  for (const f of files) {
    const parts = f.rel.split("/");
    for (let i = 1; i < parts.length; i++) seen.add(parts.slice(0, i).join("/"));
  }
  const folders = [...seen].map((rel) => ({
    name: rel.slice(rel.lastIndexOf("/") + 1),
    path: root ? absolute(root, rel) : rel,
    rel,
    kind: "folder" as const,
  }));
  folderCache.set(files, folders);
  return folders;
}
