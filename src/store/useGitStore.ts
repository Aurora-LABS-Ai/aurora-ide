import { create } from 'zustand';
import { gitService, type GitStatus, type GitBranch, type GitCommit } from '../services/git';

interface GitState {
  // Loading states
  isLoading: boolean;
  isInitialized: boolean;
  isGitRepo: boolean;

  // Git data
  status: GitStatus | null;
  branches: GitBranch[];
  currentBranch: string;
  commits: GitCommit[];

  // UI state
  expandedSections: Set<string>;
  selectedFiles: Set<string>;
  commitMessage: string;

  // Actions
  initialize: (workspacePath: string) => Promise<void>;
  refresh: () => Promise<void>;
  loadStatus: () => Promise<void>;
  loadBranches: () => Promise<void>;
  loadCommits: (limit?: number) => Promise<void>;

  // Git operations
  stageFile: (filePath: string) => Promise<void>;
  unstageFile: (filePath: string) => Promise<void>;
  stageAll: () => Promise<void>;
  unstageAll: () => Promise<void>;
  discardChanges: (filePath: string) => Promise<void>;
  commit: (message: string) => Promise<void>;
  checkout: (branch: string) => Promise<void>;
  createBranch: (name: string) => Promise<void>;
  pull: () => Promise<void>;
  push: () => Promise<void>;

  // UI actions
  toggleSection: (section: string) => void;
  setCommitMessage: (message: string) => void;
  selectFile: (filePath: string) => void;
  clearSelection: () => void;
  reset: () => void;
}

let currentWorkspacePath: string | null = null;

export const useGitStore = create<GitState>((set, get) => ({
  // Initial state
  isLoading: false,
  isInitialized: false,
  isGitRepo: false,
  status: null,
  branches: [],
  currentBranch: '',
  commits: [],
  expandedSections: new Set(['staged', 'changes']),
  selectedFiles: new Set(),
  commitMessage: '',

  initialize: async (workspacePath: string) => {
    currentWorkspacePath = workspacePath;
    set({ isLoading: true });

    try {
      const isRepo = await gitService.isGitRepository(workspacePath);
      set({ isGitRepo: isRepo, isInitialized: true });

      if (isRepo) {
        await get().refresh();
      }
    } catch (error) {
      console.error('Failed to initialize git:', error);
      set({ isGitRepo: false, isInitialized: true });
    } finally {
      set({ isLoading: false });
    }
  },

  refresh: async () => {
    if (!currentWorkspacePath || !get().isGitRepo) return;

    set({ isLoading: true });
    try {
      await Promise.all([
        get().loadStatus(),
        get().loadBranches(),
        get().loadCommits(50),
      ]);
    } finally {
      set({ isLoading: false });
    }
  },

  loadStatus: async () => {
    if (!currentWorkspacePath) return;
    try {
      const status = await gitService.getStatus(currentWorkspacePath);
      set({ status });
    } catch (error) {
      console.error('Failed to load git status:', error);
    }
  },

  loadBranches: async () => {
    if (!currentWorkspacePath) return;
    try {
      const result = await gitService.getBranches(currentWorkspacePath);
      set({
        branches: result.branches,
        currentBranch: result.current,
      });
    } catch (error) {
      console.error('Failed to load branches:', error);
    }
  },

  loadCommits: async (limit = 50) => {
    if (!currentWorkspacePath) return;
    try {
      const commits = await gitService.getCommits(currentWorkspacePath, limit);
      set({ commits });
    } catch (error) {
      console.error('Failed to load commits:', error);
    }
  },

  stageFile: async (filePath: string) => {
    if (!currentWorkspacePath) return;
    try {
      await gitService.stageFile(currentWorkspacePath, filePath);
      await get().loadStatus();
    } catch (error) {
      console.error('Failed to stage file:', error);
      throw error;
    }
  },

  unstageFile: async (filePath: string) => {
    if (!currentWorkspacePath) return;
    try {
      await gitService.unstageFile(currentWorkspacePath, filePath);
      await get().loadStatus();
    } catch (error) {
      console.error('Failed to unstage file:', error);
      throw error;
    }
  },

  stageAll: async () => {
    if (!currentWorkspacePath) return;
    try {
      await gitService.stageAll(currentWorkspacePath);
      await get().loadStatus();
    } catch (error) {
      console.error('Failed to stage all:', error);
      throw error;
    }
  },

  unstageAll: async () => {
    if (!currentWorkspacePath) return;
    try {
      await gitService.unstageAll(currentWorkspacePath);
      await get().loadStatus();
    } catch (error) {
      console.error('Failed to unstage all:', error);
      throw error;
    }
  },

  discardChanges: async (filePath: string) => {
    if (!currentWorkspacePath) return;
    try {
      await gitService.discardChanges(currentWorkspacePath, filePath);
      await get().loadStatus();
    } catch (error) {
      console.error('Failed to discard changes:', error);
      throw error;
    }
  },

  commit: async (message: string) => {
    if (!currentWorkspacePath || !message.trim()) return;
    try {
      await gitService.commit(currentWorkspacePath, message);
      set({ commitMessage: '' });
      await get().refresh();
    } catch (error) {
      console.error('Failed to commit:', error);
      throw error;
    }
  },

  checkout: async (branch: string) => {
    if (!currentWorkspacePath) return;
    try {
      await gitService.checkout(currentWorkspacePath, branch);
      await get().refresh();
    } catch (error) {
      console.error('Failed to checkout:', error);
      throw error;
    }
  },

  createBranch: async (name: string) => {
    if (!currentWorkspacePath || !name.trim()) return;
    try {
      await gitService.createBranch(currentWorkspacePath, name);
      await get().loadBranches();
    } catch (error) {
      console.error('Failed to create branch:', error);
      throw error;
    }
  },

  pull: async () => {
    if (!currentWorkspacePath) return;
    try {
      await gitService.pull(currentWorkspacePath);
      await get().refresh();
    } catch (error) {
      console.error('Failed to pull:', error);
      throw error;
    }
  },

  push: async () => {
    if (!currentWorkspacePath) return;
    try {
      await gitService.push(currentWorkspacePath);
      await get().refresh();
    } catch (error) {
      console.error('Failed to push:', error);
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
    set({
      isLoading: false,
      isInitialized: false,
      isGitRepo: false,
      status: null,
      branches: [],
      currentBranch: '',
      commits: [],
      expandedSections: new Set(['staged', 'changes']),
      selectedFiles: new Set(),
      commitMessage: '',
    });
  },
}));
