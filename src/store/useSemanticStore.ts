import { create } from "zustand";

import { type ModelInfo, semanticService, setSemanticEventHandlers } from "../services/semantic";
import type { IndexProgress, SearchMode, SemanticIndex, SemanticSearchResult, SemanticSettings } from "../types/database";

interface SemanticState {
  allIndexes: SemanticIndex[];
  cancelIndexing: (indexId: string) => Promise<void>;
  clearSearchResults: () => void;

  // Current workspace index
  currentIndex: SemanticIndex | null;
  deleteIndex: (id: string, workspacePath: string) => Promise<void>;
  indexProgress: IndexProgress | null;
  indexesLoading: boolean;

  // Indexing state
  isIndexing: boolean;
  loadCurrentIndex: (workspacePath: string) => Promise<void>;
  loadIndexes: () => Promise<void>;

  // Actions
  loadSettings: () => Promise<void>;
  markIndexComplete: (indexId: string, stats: { documentCount: number; chunkCount: number; totalBytes: number }) => void;
  markIndexError: (indexId: string, error: string) => void;

  // Model info
  modelInfo: ModelInfo | null;
  modelValid: boolean;
  saveSettings: (settings: Partial<SemanticSettings>) => Promise<void>;
  search: (workspacePath: string, query: string) => Promise<void>;
  searchLoading: boolean;
  searchMode: SearchMode;

  // Search state
  searchQuery: string;
  searchResults: SemanticSearchResult[];
  setModelPath: (path: string | null) => Promise<void>;
  setSearchMode: (mode: SearchMode) => void;
  setSearchQuery: (query: string) => void;

  // Settings
  settings: SemanticSettings | null;
  settingsLoading: boolean;
  startIndexing: (workspacePath: string, workspaceName: string) => Promise<string | null>;
  updateIndexProgress: (progress: IndexProgress) => void;
  validateModelPath: (path: string) => Promise<boolean>;
}

export const useSemanticStore = create<SemanticState>((set, get) => ({
  // Initial state
  settings: null,
  settingsLoading: false,
  currentIndex: null,
  allIndexes: [],
  indexesLoading: false,
  isIndexing: false,
  indexProgress: null,
  searchQuery: '',
  searchResults: [],
  searchLoading: false,
  searchMode: 'hybrid',
  modelInfo: null,
  modelValid: false,

  // Load settings from database - no model validation (happens on Index)
  loadSettings: async () => {
    set({ settingsLoading: true });
    try {
      const settings = await semanticService.getSettings();
      set({ settings, settingsLoading: false, modelInfo: null, modelValid: false });
    } catch (error) {
      console.error('Failed to load semantic settings:', error);
      set({ settingsLoading: false });
    }
  },

  // Save settings
  saveSettings: async (updates) => {
    const { settings } = get();
    if (!settings) return;

    const newSettings: SemanticSettings = {
      ...settings,
      ...updates,
      updatedAt: new Date().toISOString(),
    };

    try {
      await semanticService.saveSettings(newSettings);
      set({ settings: newSettings });
    } catch (error) {
      console.error('Failed to save semantic settings:', error);
      throw error;
    }
  },

  // Set model path - just saves to DB, no validation (validation happens on Index)
  setModelPath: async (path) => {
    try {
      await semanticService.setModelPath(path);

      // Update local state
      const { settings } = get();
      if (settings) {
        set({
          settings: { ...settings, modelPath: path },
          // Clear model info - will be populated when indexing starts
          modelInfo: null,
          modelValid: false,
        });
      }
    } catch (error) {
      console.error('Failed to set model path:', error);
      throw error;
    }
  },

  // Validate model path - lightweight check (just filesystem)
  validateModelPath: async (path) => {
    try {
      const valid = await semanticService.validateModelPath(path);
      return valid;
    } catch (error) {
      console.error('Failed to validate model path:', error);
      return false;
    }
  },

  // Load all indexes
  loadIndexes: async () => {
    set({ indexesLoading: true });
    try {
      const allIndexes = await semanticService.getAllIndexes();
      set({ allIndexes, indexesLoading: false });
    } catch (error) {
      console.error('Failed to load semantic indexes:', error);
      set({ indexesLoading: false });
    }
  },

  // Load current workspace index
  loadCurrentIndex: async (workspacePath) => {
    try {
      const currentIndex = await semanticService.getIndexByPath(workspacePath);
      set({ currentIndex });
    } catch (error) {
      console.error('Failed to load current index:', error);
      set({ currentIndex: null });
    }
  },

  // Start indexing
  startIndexing: async (workspacePath, workspaceName) => {
    const { isIndexing } = get();
    if (isIndexing) {
      console.warn('Indexing already in progress');
      return null;
    }

    set({ isIndexing: true, indexProgress: null });

    try {
      const indexId = await semanticService.startIndexing(
        workspacePath,
        workspaceName,
        (progress) => {
          get().updateIndexProgress(progress);
        }
      );

      return indexId;
    } catch (error) {
      console.error('Failed to start indexing:', error);
      set({ isIndexing: false });
      return null;
    }
  },

  // Cancel indexing
  cancelIndexing: async (indexId) => {
    try {
      await semanticService.cancelIndexing(indexId);
      set({ isIndexing: false, indexProgress: null });
    } catch (error) {
      console.error('Failed to cancel indexing:', error);
    }
  },

  // Delete index
  deleteIndex: async (id, workspacePath) => {
    try {
      await semanticService.deleteIndex(id, workspacePath);

      // Update local state
      const { allIndexes, currentIndex } = get();
      set({
        allIndexes: allIndexes.filter((i) => i.id !== id),
        currentIndex: currentIndex?.id === id ? null : currentIndex,
      });
    } catch (error) {
      console.error('Failed to delete index:', error);
      throw error;
    }
  },

  // Search
  search: async (workspacePath, query) => {
    if (!query.trim()) {
      set({ searchResults: [], searchLoading: false });
      return;
    }

    set({ searchLoading: true, searchQuery: query });

    try {
      const { searchMode } = get();
      const results = await semanticService.search(workspacePath, query, {
        limit: 30,
        mode: searchMode,
      });
      set({ searchResults: results, searchLoading: false });
    } catch (error) {
      console.error('Search failed:', error);
      set({ searchResults: [], searchLoading: false });
    }
  },

  setSearchQuery: (query) => set({ searchQuery: query }),
  setSearchMode: (mode) => set({ searchMode: mode }),
  clearSearchResults: () => set({ searchResults: [], searchQuery: '' }),

  // Progress updates
  updateIndexProgress: (progress) => {
    set({ indexProgress: progress });

    // Update current index status if it matches
    const { currentIndex } = get();
    if (currentIndex && currentIndex.id === progress.workspaceId) {
      set({
        currentIndex: {
          ...currentIndex,
          status: progress.phase === 'complete' ? 'ready' : 'indexing',
        },
      });
    }
  },

  markIndexComplete: (indexId, stats) => {
    set({ isIndexing: false, indexProgress: null });

    // Update indexes list
    const { allIndexes, currentIndex } = get();
    const updatedIndexes = allIndexes.map((idx) =>
      idx.id === indexId
        ? {
            ...idx,
            status: 'ready' as const,
            documentCount: stats.documentCount,
            chunkCount: stats.chunkCount,
            totalBytes: stats.totalBytes,
            lastIndexedAt: new Date().toISOString(),
          }
        : idx
    );

    set({
      allIndexes: updatedIndexes,
      currentIndex:
        currentIndex?.id === indexId
          ? {
              ...currentIndex,
              status: 'ready',
              documentCount: stats.documentCount,
              chunkCount: stats.chunkCount,
              totalBytes: stats.totalBytes,
              lastIndexedAt: new Date().toISOString(),
            }
          : currentIndex,
    });
  },

  markIndexError: (indexId, error) => {
    set({ isIndexing: false, indexProgress: null });

    // Update indexes list
    const { allIndexes, currentIndex } = get();
    const updatedIndexes = allIndexes.map((idx) =>
      idx.id === indexId
        ? {
            ...idx,
            status: 'error' as const,
            errorMessage: error,
          }
        : idx
    );

    set({
      allIndexes: updatedIndexes,
      currentIndex:
        currentIndex?.id === indexId
          ? {
              ...currentIndex,
              status: 'error',
              errorMessage: error,
            }
          : currentIndex,
    });
  },
}));

// Initialize semantic service and wire up event handlers
semanticService.init().then(() => {
  setSemanticEventHandlers(
    // Progress handler
    (progress) => {
      useSemanticStore.getState().updateIndexProgress(progress);
    },
    // Complete handler
    (data) => {
      useSemanticStore.getState().markIndexComplete(data.workspaceId, {
        documentCount: data.documentCount,
        chunkCount: data.chunkCount,
        totalBytes: data.totalBytes,
      });
      // Reload all indexes to get fresh data from database
      useSemanticStore.getState().loadIndexes();
      // Also reload current index if it matches
      const { currentIndex } = useSemanticStore.getState();
      if (currentIndex?.id === data.workspaceId) {
        // Force reload from database to get updated stats
        semanticService.getIndex(data.workspaceId).then((index) => {
          if (index) {
            useSemanticStore.setState({ currentIndex: index });
          }
        });
      }
    },
    // Error handler
    (data) => {
      useSemanticStore.getState().markIndexError(data.workspaceId, data.error);
      // Reload to get error status from database
      useSemanticStore.getState().loadIndexes();
    }
  );
});
