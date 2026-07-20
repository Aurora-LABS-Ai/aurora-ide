import { create } from "zustand";

import {
  listThreadArtifacts,
  presentThreadArtifact,
  selectThreadArtifact,
  type PresentArtifactInput,
  type ThreadArtifactBundle,
} from "../../services/agent-artifacts";

interface AgentArtifactState {
  bundles: Record<string, ThreadArtifactBundle | undefined>;
  loadingByThread: Record<string, boolean | undefined>;
  errorsByThread: Record<string, string | undefined>;
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
