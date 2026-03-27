import { invoke } from "@tauri-apps/api/core";

import type { AppSettings, DbLLMProvider, EditorState, ExplorerState, ToolSetting, WorkspaceState } from "../types/database";

/**
 * Database service for persisting application state
 */
class DatabaseService {
  /**
   * Delete a provider
   */
  public async deleteProvider(id: string): Promise<void> {
    await invoke('delete_provider', { id });
  }

  // ============================================================
  // LLM PROVIDERS
  // ============================================================

  /**
   * Get all LLM providers
   */
  public async getAllProviders(): Promise<DbLLMProvider[]> {
    try {
      const result = await invoke<DbLLMProvider[]>('get_all_providers');
      return result;
    } catch (error) {
      console.error('Failed to get providers:', error);
      return [];
    }
  }

  // ============================================================
  // TOOL SETTINGS
  // ============================================================

  /**
   * Get all tool settings
   */
  public async getAllToolSettings(): Promise<ToolSetting[]> {
    try {
      const result = await invoke<ToolSetting[]>('get_all_tool_settings');
      return result;
    } catch (error) {
      console.error('Failed to get tool settings:', error);
      return [];
    }
  }

  // ============================================================
  // APP SETTINGS
  // ============================================================

  /**
   * Get all app settings
   */
  public async getAppSettings(): Promise<AppSettings | null> {
    try {
      const result = await invoke<AppSettings>('get_app_settings');
      return result;
    } catch (error) {
      console.error('Failed to get app settings:', error);
      return null;
    }
  }

  /**
   * Get editor state for a file
   */
  public async getEditorState(filePath: string): Promise<EditorState | null> {
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

  /**
   * Get explorer state for a workspace
   */
  public async getExplorerState(
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

  /**
   * Get a single provider by ID
   */
  public async getProvider(id: string): Promise<DbLLMProvider | null> {
    try {
      const result = await invoke<DbLLMProvider | null>('get_provider', { id });
      return result;
    } catch (error) {
      console.error(`Failed to get provider ${id}:`, error);
      return null;
    }
  }

  /**
   * Get workspace state for a specific workspace
   * If no path provided, returns the most recently opened workspace
   */
  public async getWorkspaceState(
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

  /**
   * Get recently opened workspaces ordered by most recent first
   */
  public async listRecentWorkspaces(limit: number = 3): Promise<WorkspaceState[]> {
    try {
      const result = await invoke<WorkspaceState[]>('list_recent_workspaces', { limit });
      return result;
    } catch (error) {
      console.error('Failed to list recent workspaces:', error);
      return [];
    }
  }

  /**
   * Check if any providers exist in the database
   */
  public async hasProviders(): Promise<boolean> {
    try {
      const result = await invoke<boolean>('has_providers');
      return result;
    } catch (error) {
      console.error('Failed to check providers:', error);
      return false;
    }
  }

  /**
   * Save multiple providers at once
   */
  public async saveAllProviders(providers: DbLLMProvider[]): Promise<void> {
    await invoke('save_all_providers', { providers });
  }

  /**
   * Save all tool settings at once
   */
  public async saveAllToolSettings(settings: [string, string][]): Promise<void> {
    await invoke('save_all_tool_settings', { settings });
  }

  /**
   * Save all app settings
   */
  public async saveAppSettings(settings: AppSettings): Promise<void> {
    await invoke('save_app_settings', { settings });
  }

  // ============================================================
  // EDITOR STATE
  // ============================================================

  /**
   * Save editor state for a file (cursor position, scroll offset, folds)
   */
  public async saveEditorState(state: EditorState): Promise<void> {
    await invoke('save_editor_state', { state });
  }

  // ============================================================
  // EXPLORER STATE
  // ============================================================

  /**
   * Save explorer state (expanded folders, selected file)
   */
  public async saveExplorerState(state: ExplorerState): Promise<void> {
    await invoke('save_explorer_state', { state });
  }

  /**
   * Save or update a provider
   */
  public async saveProvider(provider: DbLLMProvider): Promise<void> {
    await invoke('save_provider', { provider });
  }

  // ============================================================
  // WORKSPACE STATE
  // ============================================================

  /**
   * Save workspace state (open tabs, panel layout, etc.)
   */
  public async saveWorkspaceState(state: WorkspaceState): Promise<void> {
    await invoke('save_workspace_state', { state });
  }

  /**
   * Set tool approval mode
   */
  public async setToolApproval(toolName: string, approvalMode: string): Promise<void> {
    await invoke('set_tool_approval', { toolName, approvalMode });
  }
}

// Export singleton instance
export const databaseService = new DatabaseService();
