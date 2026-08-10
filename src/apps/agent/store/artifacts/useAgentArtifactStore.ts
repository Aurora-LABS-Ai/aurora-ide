import { create } from "zustand";

import {
  listThreadArtifacts,
  presentThreadArtifact,
  selectThreadArtifact,
  type PresentArtifactInput,
  type ThreadArtifactBundle,
} from "@/apps/agent/services/artifacts/agent-artifacts";

interface AgentArtifactState {
  bundles: Record<string, ThreadArtifactBundle | undefined>;
  loadingByThread: Record<string, boolean | undefined>;
  errorsByThread: Record<string, string | undefined>;
  /**
   * Which document the Canvas shows when the workspace ALSO has a plan. Lives
   * here, not in CanvasPanel state, because the flip has to survive the panel
   * mounting: `present` runs before the tab opens, and a freshly presented
   * artifact hidden behind the plan is an artifact the user cannot find (the
   * plan "outranks by default" rule buried every new diagram in a planned
   * project). Presenting or explicitly selecting an artifact claims the
   * canvas; the toggle in the panel writes it back.
   */
  canvasSource: "plan" | "artifact";
  setCanvasSource: (source: "plan" | "artifact") => void;
  loadThread: (threadId: string) => Promise<ThreadArtifactBundle>;
  present: (threadId: string, input: PresentArtifactInput) => Promise<ThreadArtifactBundle>;
  select: (
    threadId: string,
    artifactId: string,
    versionTag: string,
  ) => Promise<ThreadArtifactBundle>;
  clearThread: (threadId: string) => void;
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export const useAgentArtifactStore = create<AgentArtifactState>((set) => ({
  bundles: {},
  loadingByThread: {},
  errorsByThread: {},
  // A plan is the standing work, so it keeps the canvas until an artifact
  // event claims it.
  canvasSource: "plan",
  setCanvasSource: (canvasSource) => set({ canvasSource }),

  loadThread: async (threadId) => {
    set((state) => ({
      loadingByThread: { ...state.loadingByThread, [threadId]: true },
      errorsByThread: { ...state.errorsByThread, [threadId]: undefined },
    }));
    try {
      const bundle = await listThreadArtifacts(threadId);
      set((state) => ({
        bundles: { ...state.bundles, [threadId]: bundle },
        loadingByThread: { ...state.loadingByThread, [threadId]: false },
      }));
      return bundle;
    } catch (error) {
      set((state) => ({
        loadingByThread: { ...state.loadingByThread, [threadId]: false },
        errorsByThread: { ...state.errorsByThread, [threadId]: errorMessage(error) },
      }));
      throw error;
    }
  },

  present: async (threadId, input) => {
    try {
      const bundle = await presentThreadArtifact(threadId, input);
      set((state) => ({
        bundles: { ...state.bundles, [threadId]: bundle },
        errorsByThread: { ...state.errorsByThread, [threadId]: undefined },
        // The agent just put something on the canvas — showing anything else
        // (the plan) would hide the very thing the tool result says is there.
        canvasSource: "artifact",
      }));
      return bundle;
    } catch (error) {
      set((state) => ({
        errorsByThread: { ...state.errorsByThread, [threadId]: errorMessage(error) },
      }));
      throw error;
    }
  },

  select: async (threadId, artifactId, versionTag) => {
    try {
      const bundle = await selectThreadArtifact(threadId, artifactId, versionTag);
      set((state) => ({
        bundles: { ...state.bundles, [threadId]: bundle },
        errorsByThread: { ...state.errorsByThread, [threadId]: undefined },
        // Selecting an artifact IS choosing to look at artifacts.
        canvasSource: "artifact",
      }));
      return bundle;
    } catch (error) {
      set((state) => ({
        errorsByThread: { ...state.errorsByThread, [threadId]: errorMessage(error) },
      }));
      throw error;
    }
  },

  clearThread: (threadId) =>
    set((state) => {
      const bundles = { ...state.bundles };
      const loadingByThread = { ...state.loadingByThread };
      const errorsByThread = { ...state.errorsByThread };
      delete bundles[threadId];
      delete loadingByThread[threadId];
      delete errorsByThread[threadId];
      return { bundles, loadingByThread, errorsByThread };
    }),
}));
