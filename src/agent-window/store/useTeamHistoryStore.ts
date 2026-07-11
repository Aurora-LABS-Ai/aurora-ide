/**
 * Agent Window — team-history index (cross-project) [store].
 *
 * A tiny, read-only cache answering one question the left rail asks per row:
 * "has this chat (or project) ever run a team?". The durable answer lives in
 * each project's brain — every team run stamps its origin chat id onto the
 * channel log (`meta.originThreadId`) — so we read the distinct origin ids per
 * project (via `team_origin_threads`) and fold them into one union.
 *
 * The rail spans MANY projects, so this store is keyed globally (not scoped to
 * the active project like {@link useTeamStore}). It's a derived index, never a
 * source of truth: {@link TeamHistoryState.refresh} recomputes it from disk.
 * Refresh is coalesced so the rail can call it freely (mount, project-list
 * change, team phase transition) without hammering the backend.
 *
 * Intentionally NOT persisted — it's cheap to rebuild and must never drift from
 * the on-disk brains.
 */

import { create } from "zustand";

import { isAuroraRuntimeAvailable } from "../../lib/runtime";
import { getOriginThreads } from "../../services/team-client";

interface TeamHistoryState {
  /** Chat/thread id → true when that chat has dispatched a team run (any project). */
  threadIds: Record<string, true>;
  /** Project root → true when the project has any team run. */
  projects: Record<string, true>;
  /**
   * Rebuild the index from the given project roots' brains. Coalesces an
   * identical in-flight rebuild; safe to call on every relevant rail change.
   * Best-effort — a project whose read fails contributes nothing (no throw).
   */
  refresh: (roots: string[]) => Promise<void>;
}

/** Coalesce identical concurrent rebuilds (same root set) into one round-trip. */
let inFlight: Promise<void> | null = null;
let inFlightKey = "";

export const useTeamHistoryStore = create<TeamHistoryState>((set) => ({
  threadIds: {},
  projects: {},
  refresh: async (roots) => {
    if (!isAuroraRuntimeAvailable()) return;

    const clean = Array.from(
      new Set(roots.filter((r): r is string => typeof r === "string" && r.trim() !== "")),
    );
    if (clean.length === 0) {
      set({ threadIds: {}, projects: {} });
      return;
    }

    const key = [...clean].sort().join("|");
    if (inFlight && key === inFlightKey) return inFlight;
    inFlightKey = key;

    inFlight = (async () => {
      const results = await Promise.all(
        clean.map(async (root) => {
          try {
            return { root, ids: await getOriginThreads(root) };
          } catch {
            return { root, ids: [] as string[] };
          }
        }),
      );

      const threadIds: Record<string, true> = {};
      const projects: Record<string, true> = {};
      for (const { root, ids } of results) {
        if (ids.length === 0) continue;
        projects[root] = true;
        for (const id of ids) {
          if (id) threadIds[id] = true;
        }
      }
      set({ threadIds, projects });
    })().finally(() => {
      inFlight = null;
    });

    return inFlight;
  },
}));
