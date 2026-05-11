/**
 * Thin IPC wrappers around the Rust file cache.
 *
 * The Rust side ([`file_cache.rs`]) owns the only cache. It does:
 *   - LRU eviction (1k entries / 50MB)
 *   - mtime-validated reads (stale entries auto-evict on hit)
 *   - rayon-parallelised batch fan-out
 *   - `core.worktree`-style prefix invalidation for fs-watcher events
 *
 * The frontend used to keep its own LRU here as a "fast path", but that
 * cache had no mtime check, a 5-min TTL, and was the source of the
 * "stale @-mention / agent reads old content" class of bugs. It also
 * forced every caller through an extra in-process layer that did nothing
 * the Rust cache wasn't already doing better.
 *
 * Now: every read is a single IPC call. Repeated opens of the same file
 * stay fast because Rust serves from memory; staleness is impossible
 * because Rust re-stats on every hit; and the frontend never holds a
 * second copy of the bytes in JS heap.
 */
import { auroraInvoke, isAuroraRuntimeAvailable } from "./runtime";

/**
 * Content + on-disk metadata returned by `read_file_with_meta`. The editor
 * captures `mtime` when opening a tab so subsequent freshness checks can be
 * answered with a cheap `stat_file_mtime` call instead of re-reading.
 */
export interface FileMeta {
  content: string;
  mtime: number;
  size: number;
}

/**
 * Read file content (Rust-cached, mtime-validated).
 */
export async function readFileCached(path: string): Promise<string> {
  if (!isAuroraRuntimeAvailable()) {
    console.warn("readFileCached: Aurora runtime unavailable");
    return "";
  }
  return auroraInvoke<string>("read_file_content", { path });
}

/**
 * Read content + size + mtime in one round-trip. Use this on the editor
 * open path so the tab can record the canonical freshness stamp without a
 * separate stat call.
 */
export async function readFileWithMeta(path: string): Promise<FileMeta> {
  if (!isAuroraRuntimeAvailable()) {
    console.warn("readFileWithMeta: Aurora runtime unavailable");
    return { content: "", mtime: 0, size: 0 };
  }
  return auroraInvoke<FileMeta>("read_file_with_meta", { path });
}

/**
 * Cheap freshness probe — returns the current disk mtime as a unix
 * timestamp. Used to decide whether an already-mounted tab needs to refresh
 * its content. Returns `0` if the file is missing or stat fails.
 */
export async function statFileMtime(path: string): Promise<number> {
  if (!isAuroraRuntimeAvailable()) {
    return 0;
  }
  try {
    return await auroraInvoke<number>("stat_file_mtime", { path });
  } catch (err) {
    console.warn("statFileMtime failed:", err);
    return 0;
  }
}

/**
 * Read multiple files in a single IPC call. Rust fans the disk reads out
 * across rayon's global pool, so cold reads complete in roughly the time of
 * the slowest single file rather than the sum.
 */
export async function readFilesBatch(
  paths: string[],
): Promise<Map<string, string>> {
  if (!isAuroraRuntimeAvailable()) {
    console.warn("readFilesBatch: Aurora runtime unavailable");
    return new Map();
  }
  if (paths.length === 0) {
    return new Map();
  }

  const batchResults = await auroraInvoke<
    Record<string, { Ok?: string; Err?: string }>
  >("read_files_batch", { paths });

  const out = new Map<string, string>();
  for (const [path, result] of Object.entries(batchResults)) {
    if (result.Ok !== undefined) {
      out.set(path, result.Ok);
    } else if (result.Err) {
      console.warn(`Failed to read file ${path}:`, result.Err);
    }
  }
  return out;
}

/**
 * Fire-and-forget batch read. The Rust cache absorbs the results, so
 * subsequent foreground reads of the same paths are served from memory.
 * Used to warm sibling files when the user opens one file in a folder.
 */
export function preloadFiles(paths: string[]): void {
  if (!isAuroraRuntimeAvailable() || paths.length === 0) return;

  // Background warm-up; we don't care about the bytes here, just the
  // side-effect of priming Rust's cache.
  void readFilesBatch(paths).catch((err) => {
    console.warn("Background preload failed:", err);
  });
}

/**
 * Invalidate one path or every cached path under a prefix. Routed straight
 * to the Rust cache — no in-process bookkeeping to keep in sync.
 */
export function invalidateFileCache(
  path: string,
  isPrefix: boolean = false,
): void {
  if (!isAuroraRuntimeAvailable()) return;
  void auroraInvoke("invalidate_file_cache", { path, isPrefix }).catch((err) => {
    console.warn("Failed to invalidate Rust file cache:", err);
  });
}

/**
 * Diagnostic helper. Returns Rust cache occupancy as `(entries, totalBytes)`.
 */
export async function getCacheStats(): Promise<{ entries: number; size: number }> {
  if (!isAuroraRuntimeAvailable()) return { entries: 0, size: 0 };
  try {
    const [entries, size] = await auroraInvoke<[number, number]>("get_cache_stats");
    return { entries, size };
  } catch (err) {
    console.warn("getCacheStats failed:", err);
    return { entries: 0, size: 0 };
  }
}
