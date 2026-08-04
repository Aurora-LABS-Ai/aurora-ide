/**
 * Agent Window — workspace file index (adapter / inbound channel).
 *
 * The agent window is a separate OS window and does NOT mount the IDE explorer,
 * so `useWorkspaceStore.files` is empty here. To power `@`-file mentions we build
 * our OWN flat file list by walking `read_directory` from the project root (the
 * Rust command already skips `.git`, `node_modules`, `target`, `dist`, `.pnpm`).
 * Cached per root; bounded in depth + count so a huge repo can't stall the UI.
 */

import { readDirectory, type FileEntry } from "../../lib/tauri";

export interface MentionFile {
  name: string;
  /** Absolute path (for "Open in IDE" / reading). */
  path: string;
  /** Path relative to the project root (for display + matching). */
  rel: string;
}

const MAX_FILES = 6000;
const MAX_DEPTH = 10;

const cache = new Map<string, MentionFile[]>();
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

async function walk(root: string): Promise<MentionFile[]> {
  const out: MentionFile[] = [];
  const queue: Array<{ path: string; depth: number }> = [{ path: root, depth: 0 }];
  while (queue.length > 0 && out.length < MAX_FILES) {
    const { path, depth } = queue.shift()!;
    let entries: FileEntry[] = [];
    try {
      entries = await readDirectory(path, { includeHidden: false });
    } catch {
      continue; // unreadable dir — skip, keep going
    }
    for (const e of entries) {
      if (e.is_dir) {
        if (depth < MAX_DEPTH) queue.push({ path: e.path, depth: depth + 1 });
      } else if (e.is_file) {
        out.push({ name: e.name, path: e.path, rel: relativize(root, e.path) });
        if (out.length >= MAX_FILES) break;
      }
    }
  }
  return out;
}

/** Load (and cache) the project's file list. Concurrent calls share one walk. */
export async function loadFileIndex(root: string | null): Promise<MentionFile[]> {
  if (!root) return [];
  const hit = cache.get(root);
  if (hit) return hit;
  const pending = inflight.get(root);
  if (pending) return pending;

  const p = walk(root)
    .then((files) => {
      cache.set(root, files);
      inflight.delete(root);
      return files;
    })
    .catch((err) => {
      inflight.delete(root);
      console.warn("[agent-window] file index walk failed:", err);
      return [];
    });
  inflight.set(root, p);
  return p;
}

/** Drop the cache (call after the agent writes/creates/deletes files). */
export function invalidateFileIndex(root?: string): void {
  if (root) cache.delete(root);
  else cache.clear();
}

/**
 * Rank files against a query. Ordering: filename prefix > filename substring >
 * path substring; shorter paths win ties. Returns at most `limit`.
 */
export function rankFiles(files: MentionFile[], query: string, limit = 8): MentionFile[] {
  const q = query.trim().toLowerCase();
  if (!q) {
    return [...files].sort((a, b) => a.rel.length - b.rel.length).slice(0, limit);
  }
  const scored: Array<{ f: MentionFile; score: number }> = [];
  for (const f of files) {
    const name = f.name.toLowerCase();
    const rel = f.rel.toLowerCase();
    let score = -1;
    if (name.startsWith(q)) score = 0;
    else if (name.includes(q)) score = 1;
    else if (rel.includes(q)) score = 2;
    if (score >= 0) scored.push({ f, score });
  }
  scored.sort((a, b) => a.score - b.score || a.f.rel.length - b.f.rel.length);
  return scored.slice(0, limit).map((s) => s.f);
}
