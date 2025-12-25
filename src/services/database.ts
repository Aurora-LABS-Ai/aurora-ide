import { invoke } from '@tauri-apps/api/core';
import type {
  EditorState,
  ExplorerState,
  WorkspaceState,
} from '../types/database';

/**
 * Database service for persisting application state
 */
class DatabaseService {
  // ============================================================
  // WORKSPACE STATE
  // ============================================================

  /**
   * Save workspace state (open tabs, panel layout, etc.)
   */
  async saveWorkspaceState(state: WorkspaceState): Promise<void> {
    await invoke('save_workspace_state', { state });
  }

  /**
   * Get workspace state for a specific workspace
   * If no path provided, returns the most recently opened workspace
   */
  async getWorkspaceState(
    workspacePath?: string
  ): Promise<WorkspaceState | null> {
    try {
      const result = await invoke<WorkspaceState | null>('get_workspace_state', {
        workspacePath: workspacePath ?? null,
      });
      return result;
    } catch (error) {
      console.error('Failed to get workspace state:', error);
      return null;
    }
  }

  // ============================================================
  // EDITOR STATE
  // ============================================================

  /**
   * Save editor state for a file (cursor position, scroll offset, folds)
   */
  async saveEditorState(state: EditorState): Promise<void> {
    await invoke('save_editor_state', { state });
  }

  /**
   * Get editor state for a file
   */
  async getEditorState(filePath: string): Promise<EditorState | null> {
    try {
      const result = await invoke<EditorState | null>('get_editor_state', {
        filePath,
      });
      return result;
    } catch (error) {
      console.error('Failed to get editor state:', error);
      return null;
    }
  }

  // ============================================================
  // EXPLORER STATE
  // ============================================================

  /**
   * Save explorer state (expanded folders, selected file)
   */
  async saveExplorerState(state: ExplorerState): Promise<void> {
    await invoke('save_explorer_state', { state });
  }

  /**
   * Get explorer state for a workspace
   */
  async getExplorerState(
    workspacePath: string
  ): Promise<ExplorerState | null> {
    try {
      const result = await invoke<ExplorerState | null>('get_explorer_state', {
        workspacePath,
      });
      return result;
    } catch (error) {
      console.error('Failed to get explorer state:', error);
      return null;
    }
  }
}

// Export singleton instance
export const databaseService = new DatabaseService();
