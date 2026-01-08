/**
 * Per-file Undo/Redo Service
 *
 * This service manages undo/redo operations for individual files.
 * It tracks changes made programmatically (AI edits, tool operations)
 * and is complementary to Monaco Editor's built-in keystroke undo/redo.
 */

import { invoke } from '@tauri-apps/api/core';

/**
 * State of undo/redo for a file
 */
export interface FileUndoState {
  filePath: string;
  canUndo: boolean;
  canRedo: boolean;
  undoCount: number;
  redoCount: number;
}

/**
 * Response from undo/redo operations
 */
export interface UndoRedoResponse {
  success: boolean;
  content?: string;
  state?: FileUndoState;
  error?: string;
}

/**
 * Undo/Redo Service for per-file history management
 */
class UndoRedoServiceClass {
  /**
   * Initialize tracking for a file (call when opening a file)
   */
  async initFile(filePath: string, content: string): Promise<void> {
    try {
      await invoke('undo_init_file', { filePath, content });
    } catch (error) {
      console.error('[UndoRedoService] Failed to init file:', error);
    }
  }

  /**
   * Record a change to a file
   * Call this when content is modified programmatically (e.g., by AI tools)
   */
  async recordChange(
    filePath: string,
    oldContent: string,
    newContent: string,
    source: string,
    description?: string
  ): Promise<FileUndoState | null> {
    try {
      const state = await invoke<FileUndoState>('undo_record_change', {
        filePath,
        oldContent,
        newContent,
        source,
        description,
      });
      return state;
    } catch (error) {
      console.error('[UndoRedoService] Failed to record change:', error);
      return null;
    }
  }

  /**
   * Undo the last change for a file (in-memory only)
   * Returns the previous content if successful
   */
  async undo(filePath: string): Promise<UndoRedoResponse> {
    try {
      return await invoke<UndoRedoResponse>('undo_file', { filePath });
    } catch (error) {
      console.error('[UndoRedoService] Failed to undo:', error);
      return {
        success: false,
        error: String(error),
      };
    }
  }

  /**
   * Redo the last undone change for a file (in-memory only)
   * Returns the next content if successful
   */
  async redo(filePath: string): Promise<UndoRedoResponse> {
    try {
      return await invoke<UndoRedoResponse>('redo_file', { filePath });
    } catch (error) {
      console.error('[UndoRedoService] Failed to redo:', error);
      return {
        success: false,
        error: String(error),
      };
    }
  }

  /**
   * Undo and save to disk
   */
  async undoAndSave(filePath: string): Promise<UndoRedoResponse> {
    try {
      return await invoke<UndoRedoResponse>('undo_file_and_save', { filePath });
    } catch (error) {
      console.error('[UndoRedoService] Failed to undo and save:', error);
      return {
        success: false,
        error: String(error),
      };
    }
  }

  /**
   * Redo and save to disk
   */
  async redoAndSave(filePath: string): Promise<UndoRedoResponse> {
    try {
      return await invoke<UndoRedoResponse>('redo_file_and_save', { filePath });
    } catch (error) {
      console.error('[UndoRedoService] Failed to redo and save:', error);
      return {
        success: false,
        error: String(error),
      };
    }
  }

  /**
   * Get undo/redo state for a file
   */
  async getState(filePath: string): Promise<FileUndoState | null> {
    try {
      return await invoke<FileUndoState | null>('undo_get_state', { filePath });
    } catch (error) {
      console.error('[UndoRedoService] Failed to get state:', error);
      return null;
    }
  }

  /**
   * Clear undo/redo history for a file (e.g., when closing)
   */
  async clearFile(filePath: string): Promise<void> {
    try {
      await invoke('undo_clear_file', { filePath });
    } catch (error) {
      console.error('[UndoRedoService] Failed to clear file:', error);
    }
  }

  /**
   * Clear all undo/redo history
   */
  async clearAll(): Promise<void> {
    try {
      await invoke('undo_clear_all');
    } catch (error) {
      console.error('[UndoRedoService] Failed to clear all:', error);
    }
  }
}

// Export singleton instance
export const undoRedoService = new UndoRedoServiceClass();

