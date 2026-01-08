/**
 * Undo/Redo Store
 *
 * Manages per-file undo/redo state and provides actions for
 * undoing/redoing changes made to files.
 */

import { create } from 'zustand';
import { undoRedoService, type FileUndoState } from '../services/undo-redo';

interface UndoRedoState {
  /** Map of file path -> undo/redo state */
  fileStates: Map<string, FileUndoState>;
  /** Currently active file (for keyboard shortcuts) */
  activeFilePath: string | null;
}

interface UndoRedoActions {
  /** Initialize undo tracking for a file */
  initFile: (filePath: string, content: string) => Promise<void>;
  /** Record a change to a file */
  recordChange: (
    filePath: string,
    oldContent: string,
    newContent: string,
    source: string,
    description?: string
  ) => Promise<void>;
  /** Undo last change and update editor content */
  undo: (filePath: string) => Promise<string | null>;
  /** Redo last undone change and update editor content */
  redo: (filePath: string) => Promise<string | null>;
  /** Undo and save to disk */
  undoAndSave: (filePath: string) => Promise<string | null>;
  /** Redo and save to disk */
  redoAndSave: (filePath: string) => Promise<string | null>;
  /** Check if can undo for a file */
  canUndo: (filePath: string) => boolean;
  /** Check if can redo for a file */
  canRedo: (filePath: string) => boolean;
  /** Set active file path (for keyboard shortcuts) */
  setActiveFile: (filePath: string | null) => void;
  /** Clear history for a file */
  clearFile: (filePath: string) => Promise<void>;
  /** Refresh state for a file */
  refreshState: (filePath: string) => Promise<void>;
}

export const useUndoRedoStore = create<UndoRedoState & UndoRedoActions>((set, get) => ({
  // State
  fileStates: new Map(),
  activeFilePath: null,

  // Actions
  initFile: async (filePath: string, content: string) => {
    await undoRedoService.initFile(filePath, content);
    const state = await undoRedoService.getState(filePath);
    if (state) {
      set((s) => {
        const newStates = new Map(s.fileStates);
        newStates.set(filePath, state);
        return { fileStates: newStates };
      });
    }
  },

  recordChange: async (
    filePath: string,
    oldContent: string,
    newContent: string,
    source: string,
    description?: string
  ) => {
    const state = await undoRedoService.recordChange(
      filePath,
      oldContent,
      newContent,
      source,
      description
    );
    if (state) {
      set((s) => {
        const newStates = new Map(s.fileStates);
        newStates.set(filePath, state);
        return { fileStates: newStates };
      });
    }
  },

  undo: async (filePath: string) => {
    const response = await undoRedoService.undo(filePath);
    if (response.success && response.state) {
      set((s) => {
        const newStates = new Map(s.fileStates);
        newStates.set(filePath, response.state!);
        return { fileStates: newStates };
      });
      return response.content || null;
    }
    return null;
  },

  redo: async (filePath: string) => {
    const response = await undoRedoService.redo(filePath);
    if (response.success && response.state) {
      set((s) => {
        const newStates = new Map(s.fileStates);
        newStates.set(filePath, response.state!);
        return { fileStates: newStates };
      });
      return response.content || null;
    }
    return null;
  },

  undoAndSave: async (filePath: string) => {
    const response = await undoRedoService.undoAndSave(filePath);
    if (response.success && response.state) {
      set((s) => {
        const newStates = new Map(s.fileStates);
        newStates.set(filePath, response.state!);
        return { fileStates: newStates };
      });
      return response.content || null;
    }
    return null;
  },

  redoAndSave: async (filePath: string) => {
    const response = await undoRedoService.redoAndSave(filePath);
    if (response.success && response.state) {
      set((s) => {
        const newStates = new Map(s.fileStates);
        newStates.set(filePath, response.state!);
        return { fileStates: newStates };
      });
      return response.content || null;
    }
    return null;
  },

  canUndo: (filePath: string) => {
    const state = get().fileStates.get(filePath);
    return state?.canUndo ?? false;
  },

  canRedo: (filePath: string) => {
    const state = get().fileStates.get(filePath);
    return state?.canRedo ?? false;
  },

  setActiveFile: (filePath: string | null) => {
    set({ activeFilePath: filePath });
  },

  clearFile: async (filePath: string) => {
    await undoRedoService.clearFile(filePath);
    set((s) => {
      const newStates = new Map(s.fileStates);
      newStates.delete(filePath);
      return { fileStates: newStates };
    });
  },

  refreshState: async (filePath: string) => {
    const state = await undoRedoService.getState(filePath);
    if (state) {
      set((s) => {
        const newStates = new Map(s.fileStates);
        newStates.set(filePath, state);
        return { fileStates: newStates };
      });
    }
  },
}));

