/**
 * Agent Window — Review selection store (feature state).
 *
 * Tiny cross-component channel: which changed file the Review panel should focus
 * (expand + scroll to). The list of changes itself is derived from the open
 * thread's transcript (see `review.ts`); this store only holds the selection so a
 * click on a file in a tool card can drive the panel in the right dock.
 */

import { create } from "zustand";

interface AgentReviewState {
  /** Workspace-relative (or absolute) path of the focused change, or null. */
  selectedPath: string | null;
  setSelectedPath: (path: string | null) => void;
}

export const useAgentReviewStore = create<AgentReviewState>((set) => ({
  selectedPath: null,
  setSelectedPath: (path) => set({ selectedPath: path }),
}));
