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

  /** Bind to a project root; resets the tree and loads the root level. */
  setRoot: (root: string | null) => void;
  /** Pick a file for the viewer (null returns to the tree). */
  select: (path: string | null) => void;
  /** Read a directory's children into the cache (no-op if already cached). */
  loadDir: (path: string) => Promise<void>;
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

  setRoot: (root) => {
    if (root === get().root) return;
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

  loadDir: async (path) => {
    const s = get();
    if (s.childrenByDir[path] || s.loading[path]) return;
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
  },

  toggleDir: (path) => {
    const open = !get().expanded[path];
    set((prev) => ({ expanded: { ...prev.expanded, [path]: open } }));
    if (open) void get().loadDir(path);
  },

  collapseAll: () => set({ expanded: {} }),

  refresh: () => {
    const { root, expanded, loadDir } = get();
    const toReload = [root, ...Object.keys(expanded).filter((p) => expanded[p])].filter(
      (p): p is string => !!p,
    );
    set({ childrenByDir: {}, failed: {}, loading: {} });
    for (const p of toReload) void loadDir(p);
  },

  applyFsChange: (paths) => {
    const { root, childrenByDir, loadDir } = get();
    if (!root) return;
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
    // Evict so `loadDir` re-reads instead of short-circuiting on the cache.
    set((prev) => {
      const next = { ...prev.childrenByDir };
      for (const d of dirs) delete next[d];
      return { childrenByDir: next };
    });
    for (const d of dirs) void loadDir(d);
  },
}));
