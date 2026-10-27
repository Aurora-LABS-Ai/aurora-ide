/**
 * Agent Window — Files tab tree state (feature state).
 *
 * Backs the right dock's "Files" surface: a LAZY workspace tree (folders load
 * their children only when first expanded, so a huge repo never blocks the UI)
 * plus the currently-selected file for the read-only viewer. The agent window is
 * a separate OS window and does NOT mount the IDE explorer, so this owns its own
 * filesystem reads via `read_directory` (the Rust command already skips `.git`,
 * `node_modules`, `target`, `dist`, `.pnpm`).
 *
 * State is keyed on the project root and reset when the window switches projects.
 * Not persisted — tree expansion is cheap to rebuild and stale caches across a
 * reopen would be worse than a fresh walk.
 */

import { create } from "zustand";
import { readDirectory, type FileEntry } from "@/kernel/lib/ipc/tauri";

/** The parent directory of a path, normalizing trailing + mixed separators. */
function parentDir(p: string): string {
  const norm = p.replace(/[/\\]+$/, "");
  const idx = Math.max(norm.lastIndexOf("/"), norm.lastIndexOf("\\"));
  return idx > 0 ? norm.slice(0, idx) : norm;
}

/** Folders first, then files, each natural-sorted (so `file2` < `file10`). */
function sortEntries(entries: FileEntry[]): FileEntry[] {
  return [...entries]
    .filter((e) => e.is_dir || e.is_file)
    .sort((a, b) => {
      if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
    });
}

export interface FilesView {
  query: string;
  scrollTop: number;
}

const EMPTY_VIEW: FilesView = { query: "", scrollTop: 0 };

/** One spelling per file for `fileStamp`: the watcher and a tab may differ in
 *  slash direction and (on Windows) letter case for the same file. */
export function fileStampKey(path: string): string {
  return path.replace(/\\/g, "/").toLowerCase();
}

/** Folders changed while their read was in flight: read again when it lands. */
const rereadWhenDone = new Set<string>();

interface AgentFilesState {
  /** The project the tree is bound to. */
  root: string | null;
  /** File chosen for the viewer (absolute path), or null while browsing. */
  selectedPath: string | null;
  /** dir path → expanded? */
  expanded: Record<string, boolean>;
  /** dir path → its (sorted) entries, once loaded. */
  childrenByDir: Record<string, FileEntry[]>;
  /** dir paths with a read in flight. */
  loading: Record<string, boolean>;
  /** dir paths whose read failed (unreadable / permission). */
  failed: Record<string, boolean>;
  /**
   * Where the user was, per project: the filter text and the scroll position.
   * The Files tab is rebuilt every time it becomes the active tab, and these
   * lived in it, so switching away and back reset you to the top with the
   * filter cleared. Kept per root like the Codex reference's file tree; kept
   * across project switches, so going back to a project restores it too.
   */
  view: Record<string, FilesView>;
  /** Merge into the view of `root`. */
  setView: (root: string, patch: Partial<FilesView>) => void;
  /**
   * How many times the watcher has reported each file changed, keyed by
   * `fileStampKey`. An open file tab reads it so it re-reads its file when the
   * agent (or anything else) writes it, instead of showing the old content.
   */
  fileStamp: Record<string, number>;

  /** Bind to a project root; resets the tree and loads the root level. */
  setRoot: (root: string | null) => void;
  /** Pick a file for the viewer (null returns to the tree). */
  select: (path: string | null) => void;
  /**
   * Read a directory's children into the cache. A no-op if already cached,
   * unless `fresh`: then it re-reads and REPLACES the listing when the read
   * lands, keeping the old one on screen meanwhile.
   */
  loadDir: (path: string, fresh?: boolean) => Promise<void>;
  /** Expand/collapse a folder, loading its children on first open. */
  toggleDir: (path: string) => void;
  /** Collapse every folder (keeps the cache). */
  collapseAll: () => void;
  /** Drop caches and re-read everything currently expanded + the root. */
  refresh: () => void;
  /**
   * React to a filesystem change (from the OS watcher): re-read only the
   * affected directories that are currently loaded. Untouched/collapsed dirs
   * are left alone so a busy repo doesn't trigger a full re-walk.
   */
  applyFsChange: (paths: string[]) => void;
}

export const useAgentFilesStore = create<AgentFilesState>((set, get) => ({
  root: null,
  selectedPath: null,
  expanded: {},
  childrenByDir: {},
  loading: {},
  failed: {},
  view: {},
  fileStamp: {},

  setView: (root, patch) =>
    set((prev) => {
      const current = prev.view[root] as FilesView | undefined;
      return {
        view: { ...prev.view, [root]: { ...(current ?? EMPTY_VIEW), ...patch } },
      };
    }),

  setRoot: (root) => {
    if (root === get().root) return;
    rereadWhenDone.clear();
    set({
      root,
      selectedPath: null,
      expanded: {},
      childrenByDir: {},
      loading: {},
      failed: {},
    });
    if (root) void get().loadDir(root);
  },

  select: (path) => set({ selectedPath: path }),

  loadDir: async (path, fresh = false) => {
    const s = get();
    if (s.loading[path]) {
      // A read is already out, and it may have started before this change:
      // read once more when it lands rather than trust it.
      if (fresh) rereadWhenDone.add(path);
      return;
    }
    if (s.childrenByDir[path] && !fresh) return;
    set((prev) => ({ loading: { ...prev.loading, [path]: true } }));
    try {
      const entries = await readDirectory(path, { includeHidden: true });
      set((prev) => {
        const failed = { ...prev.failed };
        delete failed[path];
        const loading = { ...prev.loading };
        delete loading[path];
        return {
          childrenByDir: { ...prev.childrenByDir, [path]: sortEntries(entries) },
          loading,
          failed,
        };
      });
    } catch (err) {
      console.warn("[agent-window] read dir failed:", path, err);
      set((prev) => {
        const loading = { ...prev.loading };
        delete loading[path];
        return { loading, failed: { ...prev.failed, [path]: true } };
      });
    }
    if (rereadWhenDone.delete(path)) void get().loadDir(path, true);
  },

  toggleDir: (path) => {
    const open = !get().expanded[path];
    set((prev) => ({ expanded: { ...prev.expanded, [path]: open } }));
    if (open) void get().loadDir(path);
  },

  collapseAll: () => set({ expanded: {} }),

  // Re-read what is on screen and swap each listing in as it lands. Nothing is
  // cleared first: clearing blanked the whole tree to "Loading…" and back.
  refresh: () => {
    const { root, expanded, loadDir } = get();
    const toReload = [root, ...Object.keys(expanded).filter((p) => expanded[p])].filter(
      (p): p is string => !!p,
    );
    for (const p of toReload) void loadDir(p, true);
  },

  applyFsChange: (paths) => {
    const { root, childrenByDir, loadDir } = get();
    if (!root) return;
    set((prev) => {
      const fileStamp = { ...prev.fileStamp };
      for (const p of paths) {
        const key = fileStampKey(p);
        fileStamp[key] = (fileStamp[key] ?? 0) + 1;
      }
      return { fileStamp };
    });
    const dirs = new Set<string>();
    for (const p of paths) {
      // The directory that GAINED/LOST this entry (a create/remove shows up as a
      // change to its parent). Refresh it only if we've actually loaded it.
      const parent = parentDir(p);
      if (parent === root || childrenByDir[parent] !== undefined) dirs.add(parent);
      // If the path itself is a directory we have open, its own listing may have
      // changed (e.g. a file dropped directly inside it).
      if (childrenByDir[p] !== undefined) dirs.add(p);
    }
    if (dirs.size === 0) return;
    // Re-read in place. This used to evict first, and an evicted folder
    // renders as empty until the read lands, so every agent edit made the open
    // folder blink.
    for (const d of dirs) void loadDir(d, true);
  },
}));
