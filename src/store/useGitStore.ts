import { create } from "zustand";

import {
  type GitBranch,
  type GitCommit,
  type GitStatus,
  gitService,
} from "../services/git";

interface GitState {
  branches: GitBranch[];
  checkout: (branch: string) => Promise<void>;
  clearSelection: () => void;
  commit: (message: string) => Promise<void>;
  commitMessage: string;
  commits: GitCommit[];
  createBranch: (name: string) => Promise<void>;
  currentBranch: string;
  discardChanges: (filePath: string) => Promise<void>;

  // UI state
  expandedSections: Set<string>;

  // Actions
  initialize: (workspacePath: string) => Promise<void>;
  isGitRepo: boolean;
  isInitialized: boolean;

  // Loading states
  isLoading: boolean;
  loadBranches: () => Promise<void>;
  loadCommits: (limit?: number) => Promise<void>;
  loadStatus: () => Promise<void>;
  pull: () => Promise<void>;
  push: () => Promise<void>;
  refresh: () => Promise<void>;
  reset: () => void;
  selectFile: (filePath: string) => void;
  selectedFiles: Set<string>;
  setCommitMessage: (message: string) => void;
  stageAll: () => Promise<void>;

  // Git operations
  stageFile: (filePath: string) => Promise<void>;

  // Git data
  status: GitStatus | null;

  // UI actions
  toggleSection: (section: string) => void;
  unstageAll: () => Promise<void>;
  unstageFile: (filePath: string) => Promise<void>;
}

let currentWorkspacePath: string | null = null;
let gitRequestToken = 0;

export const useGitStore = create<GitState>((set, get) => ({
  // Initial state
  isLoading: false,
  isInitialized: false,
  isGitRepo: false,
  status: null,
  branches: [],
  currentBranch: "",
  commits: [],
  expandedSections: new Set(["staged", "changes"]),
  selectedFiles: new Set(),
  commitMessage: "",

  initialize: async (workspacePath: string) => {
    currentWorkspacePath = workspacePath;
    const requestToken = ++gitRequestToken;

    set({
      isLoading: true,
      isInitialized: false,
      isGitRepo: false,
      status: null,
      branches: [],
      currentBranch: "",
      commits: [],
      selectedFiles: new Set(),
      commitMessage: "",
    });

    try {
      const isRepo = await gitService.isGitRepository(workspacePath);

      if (
        requestToken !== gitRequestToken ||
        currentWorkspacePath !== workspacePath
      ) {
        return;
      }

      set({
        isGitRepo: isRepo,
        isInitialized: true,
        status: null,
        branches: isRepo ? get().branches : [],
        currentBranch: isRepo ? get().currentBranch : "",
        commits: isRepo ? get().commits : [],
      });

      if (isRepo) {
        await get().refresh();
      } else {
        set({
          status: null,
          branches: [],
          currentBranch: "",
          commits: [],
          selectedFiles: new Set(),
        });
      }
    } catch (error) {
      if (
        requestToken !== gitRequestToken ||
        currentWorkspacePath !== workspacePath
      ) {
        return;
      }

      console.error("Failed to initialize git:", error);
      set({
        isGitRepo: false,
        isInitialized: true,
        status: null,
        branches: [],
        currentBranch: "",
        commits: [],
        selectedFiles: new Set(),
      });
    } finally {
      if (
        requestToken === gitRequestToken &&
        currentWorkspacePath === workspacePath
      ) {
        set({ isLoading: false });
      }
    }
  },

  refresh: async () => {
    const workspacePath = currentWorkspacePath;
    if (!workspacePath || !get().isGitRepo) return;

    const requestToken = gitRequestToken;
    set({ isLoading: true });
    try {
      await Promise.all([
        get().loadStatus(),
        get().loadBranches(),
        get().loadCommits(50),
      ]);
    } finally {
      if (
        requestToken === gitRequestToken &&
        currentWorkspacePath === workspacePath
      ) {
        set({ isLoading: false });
      }
    }
  },

  loadStatus: async () => {
    const workspacePath = currentWorkspacePath;
    const requestToken = gitRequestToken;
    if (!workspacePath) return;

    try {
      const status = await gitService.getStatus(workspacePath);
      if (
        requestToken !== gitRequestToken ||
        currentWorkspacePath !== workspacePath
      ) {
        return;
      }
      set({ status });
    } catch (error) {
      if (
        requestToken !== gitRequestToken ||
        currentWorkspacePath !== workspacePath
      ) {
        return;
      }
      console.error("Failed to load git status:", error);
      set({ status: null });
    }
  },

  loadBranches: async () => {
    const workspacePath = currentWorkspacePath;
    const requestToken = gitRequestToken;
    if (!workspacePath) return;

    try {
      const result = await gitService.getBranches(workspacePath);
      if (
        requestToken !== gitRequestToken ||
        currentWorkspacePath !== workspacePath
      ) {
        return;
      }
      set({
        branches: result.branches,
        currentBranch: result.current,
      });
    } catch (error) {
      if (
        requestToken !== gitRequestToken ||
        currentWorkspacePath !== workspacePath
      ) {
        return;
      }
      console.error("Failed to load branches:", error);
      set({
        branches: [],
        currentBranch: "",
      });
    }
  },

  loadCommits: async (limit = 50) => {
    const workspacePath = currentWorkspacePath;
    const requestToken = gitRequestToken;
    if (!workspacePath) return;

    try {
      const commits = await gitService.getCommits(workspacePath, limit);
      if (
        requestToken !== gitRequestToken ||
        currentWorkspacePath !== workspacePath
      ) {
        return;
      }
      set({ commits });
    } catch (error) {
      if (
        requestToken !== gitRequestToken ||
        currentWorkspacePath !== workspacePath
      ) {
        return;
      }
      console.error("Failed to load commits:", error);
      set({ commits: [] });
    }
  },

  stageFile: async (filePath: string) => {
    if (!currentWorkspacePath) return;
    try {
      await gitService.stageFile(currentWorkspacePath, filePath);
      await get().loadStatus();
    } catch (error) {
      console.error("Failed to stage file:", error);
      throw error;
    }
  },

  unstageFile: async (filePath: string) => {
    if (!currentWorkspacePath) return;
    try {
      await gitService.unstageFile(currentWorkspacePath, filePath);
      await get().loadStatus();
    } catch (error) {
      console.error("Failed to unstage file:", error);
      throw error;
    }
  },

  stageAll: async () => {
    if (!currentWorkspacePath) return;
    try {
      await gitService.stageAll(currentWorkspacePath);
      await get().loadStatus();
    } catch (error) {
      console.error("Failed to stage all:", error);
      throw error;
    }
  },

  unstageAll: async () => {
    if (!currentWorkspacePath) return;
    try {
      await gitService.unstageAll(currentWorkspacePath);
      await get().loadStatus();
    } catch (error) {
      console.error("Failed to unstage all:", error);
      throw error;
    }
  },

  discardChanges: async (filePath: string) => {
    if (!currentWorkspacePath) return;
    try {
      await gitService.discardChanges(currentWorkspacePath, filePath);
      await get().loadStatus();
    } catch (error) {
      console.error("Failed to discard changes:", error);
      throw error;
    }
  },

  commit: async (message: string) => {
    if (!currentWorkspacePath || !message.trim()) return;
    try {
      await gitService.commit(currentWorkspacePath, message);
      set({ commitMessage: "" });
      await get().refresh();
    } catch (error) {
      console.error("Failed to commit:", error);
      throw error;
    }
  },

  checkout: async (branch: string) => {
    if (!currentWorkspacePath) return;
    try {
      await gitService.checkout(currentWorkspacePath, branch);
      await get().refresh();
    } catch (error) {
      console.error("Failed to checkout:", error);
      throw error;
    }
  },

  createBranch: async (name: string) => {
    if (!currentWorkspacePath || !name.trim()) return;
    try {
      await gitService.createBranch(currentWorkspacePath, name);
      await get().loadBranches();
    } catch (error) {
      console.error("Failed to create branch:", error);
      throw error;
    }
  },

  pull: async () => {
    if (!currentWorkspacePath) return;
    try {
      await gitService.pull(currentWorkspacePath);
      await get().refresh();
    } catch (error) {
      console.error("Failed to pull:", error);
      throw error;
    }
  },

  push: async () => {
    if (!currentWorkspacePath) return;
    try {
      await gitService.push(currentWorkspacePath);
      await get().refresh();
    } catch (error) {
      console.error("Failed to push:", error);
      throw error;
    }
  },

  toggleSection: (section: string) => {
    set((state) => {
      const newExpanded = new Set(state.expandedSections);
      if (newExpanded.has(section)) {
        newExpanded.delete(section);
      } else {
        newExpanded.add(section);
      }
      return { expandedSections: newExpanded };
    });
  },

  setCommitMessage: (message: string) => {
    set({ commitMessage: message });
  },

  selectFile: (filePath: string) => {
    set((state) => {
      const newSelected = new Set(state.selectedFiles);
      if (newSelected.has(filePath)) {
        newSelected.delete(filePath);
      } else {
        newSelected.add(filePath);
      }
      return { selectedFiles: newSelected };
    });
  },

  clearSelection: () => {
    set({ selectedFiles: new Set() });
  },

  reset: () => {
    currentWorkspacePath = null;
    gitRequestToken += 1;
    set({
      isLoading: false,
      isInitialized: false,
      isGitRepo: false,
      status: null,
      branches: [],
      currentBranch: "",
      commits: [],
      expandedSections: new Set(["staged", "changes"]),
      selectedFiles: new Set(),
      commitMessage: "",
    });
  },
}));
