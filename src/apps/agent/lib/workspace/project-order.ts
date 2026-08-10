/**
 * Agent Window — project list ordering (leaf, non-component).
 *
 * The single source of truth for "which projects exist, and in what order".
 *
 * The left rail owned this logic privately, and it is not simple: pinned
 * projects float above everything, three sort modes behave differently, and two
 * of them read per-project activity derived from the whole thread list. Anything
 * else that lists projects — the home screen's project switcher — has to produce
 * the SAME order or the two disagree in front of the user, so the ordering lives
 * here and both callers pass their inputs to it rather than reimplementing it.
 *
 * The sort mode and the pinned set are rail PREFERENCES kept in `localStorage`
 * (projects are not database rows), so the loaders live here too — a second
 * reader that guessed either key would silently order differently.
 */

import type { ThreadSummary } from "@/apps/agent/services/threads/thread-service";

export type ProjectSort = "recent" | "name" | "oldest";

export const SORT_LABEL: Record<ProjectSort, string> = {
  recent: "Recent",
  name: "Name",
  oldest: "Oldest",
};

export const SORT_ORDER: ProjectSort[] = ["recent", "name", "oldest"];

export const SORT_KEY = "agw-rail-project-sort";
export const PINNED_PROJECTS_KEY = "agw-rail-pinned-projects";

/** Last path segment — the compact project label. */
export function folderName(path: string | null): string {
  if (!path) return "No project";
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] || path;
}

/**
 * Everything above the folder, kept as context but visually subordinate.
 *
 * Elided from the LEFT — the segments nearest the project are the ones that
 * disambiguate it, so truncating the tail would strip exactly the part that
 * tells two same-named folders apart.
 */
export function compactParentPath(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  if (parts.length <= 1) return "";
  const parent = parts.slice(0, -1);
  const shown = parent.length > 2 ? ["…", ...parent.slice(-2)] : parent;
  return shown.join("/");
}

/** Pinned projects are a client-side rail preference (projects aren't DB rows). */
export function loadPinnedProjects(): string[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const raw = localStorage.getItem(PINNED_PROJECTS_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** The rail's current sort mode, defaulting to "recent". */
export function loadProjectSort(): ProjectSort {
  const saved = typeof localStorage !== "undefined" ? localStorage.getItem(SORT_KEY) : null;
  return saved && SORT_ORDER.includes(saved as ProjectSort) ? (saved as ProjectSort) : "recent";
}

export interface ProjectActivity {
  /** Newest `updatedAt` per project root. */
  latest: Map<string, string>;
  /** Oldest `createdAt` per project root. */
  earliest: Map<string, string>;
}

/**
 * Latest / earliest activity per project, from ALL chats rather than a filtered
 * view — the sort must not change while someone types in a search box.
 */
export function projectActivity(threads: ThreadSummary[]): ProjectActivity {
  const latest = new Map<string, string>();
  const earliest = new Map<string, string>();
  for (const thread of threads) {
    const root = thread.workspaceRoot;
    if (!root) continue;
    if (!latest.has(root) || thread.updatedAt > latest.get(root)!) {
      latest.set(root, thread.updatedAt);
    }
    if (!earliest.has(root) || thread.createdAt < earliest.get(root)!) {
      earliest.set(root, thread.createdAt);
    }
  }
  return { latest, earliest };
}

export interface OrderProjectsInput {
  /** Roots the store already knows about. */
  knownProjects: string[];
  /** Every thread (live ones folded in by the caller, if it has them). */
  threads: ThreadSummary[];
  /** The open project — always listed, even with no chats yet. */
  projectRoot: string | null;
  sortMode: ProjectSort;
  pinned: Set<string>;
  /** Precomputed activity, when the caller already has it. */
  activity?: ProjectActivity;
}

/**
 * Every known project root, ordered for display.
 *
 * Pinned first (in the active sort's order among themselves), then the rest by
 * the chosen mode. Projects with no chats sort last under `recent`, since they
 * have no activity to rank — falling back to name keeps that group stable
 * instead of letting `Map` iteration order decide.
 */
export function orderProjects(input: OrderProjectsInput): string[] {
  const { knownProjects, threads, projectRoot, sortMode, pinned } = input;
  const activity = input.activity ?? projectActivity(threads);

  const set = new Set(knownProjects);
  for (const thread of threads) {
    if (thread.workspaceRoot) set.add(thread.workspaceRoot);
  }
  if (projectRoot) set.add(projectRoot);

  return [...set].sort((a, b) => {
    // Pinned projects float to the top regardless of the active sort.
    const pa = pinned.has(a) ? 0 : 1;
    const pb = pinned.has(b) ? 0 : 1;
    if (pa !== pb) return pa - pb;
    if (sortMode === "name") return folderName(a).localeCompare(folderName(b));
    if (sortMode === "oldest") {
      return (activity.earliest.get(a) ?? "￿").localeCompare(
        activity.earliest.get(b) ?? "￿",
      );
    }
    // recent: newest activity first; projects without chats fall to the end.
    const la = activity.latest.get(a);
    const lb = activity.latest.get(b);
    if (la && lb) return lb.localeCompare(la);
    if (la) return -1;
    if (lb) return 1;
    return folderName(a).localeCompare(folderName(b));
  });
}
