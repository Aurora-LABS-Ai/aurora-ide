import { invoke } from '@tauri-apps/api/core';
import type {
  EditorState,
  ExplorerState,
  WorkspaceState,
  AppSettings,
  DbLLMProvider,
  ToolSetting,
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

  // ============================================================
  // APP SETTINGS
  // ============================================================

  /**
   * Get all app settings
   */
  async getAppSettings(): Promise<AppSettings | null> {
    try {
      const result = await invoke<AppSettings>('get_app_settings');
      return result;
    } catch (error) {
      console.error('Failed to get app settings:', error);
      return null;
    }
  }

  /**
   * Save all app settings
   */
  async saveAppSettings(settings: AppSettings): Promise<void> {
    await invoke('save_app_settings', { settings });
  }

  /**
   * Get a single setting by key
   */
  async getSetting(key: string): Promise<string | null> {
    try {
      const result = await invoke<string | null>('get_setting', { key });
      return result;
    } catch (error) {
      console.error(`Failed to get setting ${key}:`, error);
      return null;
    }
  }

  /**
   * Set a single setting
   */
  async setSetting(key: string, value: string): Promise<void> {
    await invoke('set_setting', { key, value });
  }

  // ============================================================
  // LLM PROVIDERS
  // ============================================================

  /**
   * Get all LLM providers
   */
  async getAllProviders(): Promise<DbLLMProvider[]> {
    try {
      const result = await invoke<DbLLMProvider[]>('get_all_providers');
      return result;
    } catch (error) {
      console.error('Failed to get providers:', error);
      return [];
    }
  }

  /**
   * Get a single provider by ID
   */
  async getProvider(id: string): Promise<DbLLMProvider | null> {
    try {
      const result = await invoke<DbLLMProvider | null>('get_provider', { id });
      return result;
    } catch (error) {
      console.error(`Failed to get provider ${id}:`, error);
      return null;
    }
  }

  /**
   * Save or update a provider
   */
  async saveProvider(provider: DbLLMProvider): Promise<void> {
    await invoke('save_provider', { provider });
  }

  /**
   * Delete a provider
   */
  async deleteProvider(id: string): Promise<void> {
    await invoke('delete_provider', { id });
  }

  /**
   * Check if any providers exist in the database
   */
  async hasProviders(): Promise<boolean> {
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
  async saveAllProviders(providers: DbLLMProvider[]): Promise<void> {
    await invoke('save_all_providers', { providers });
  }

  // ============================================================
  // TOOL SETTINGS
  // ============================================================

  /**
   * Get all tool settings
   */
  async getAllToolSettings(): Promise<ToolSetting[]> {
    try {
      const result = await invoke<ToolSetting[]>('get_all_tool_settings');
      return result;
    } catch (error) {
      console.error('Failed to get tool settings:', error);
      return [];
    }
  }

  /**
   * Set tool approval mode
   */
  async setToolApproval(toolName: string, approvalMode: string): Promise<void> {
    await invoke('set_tool_approval', { toolName, approvalMode });
  }

  /**
   * Save all tool settings at once
   */
  async saveAllToolSettings(settings: [string, string][]): Promise<void> {
    await invoke('save_all_tool_settings', { settings });
  }
}

// Export singleton instance
export const databaseService = new DatabaseService();
