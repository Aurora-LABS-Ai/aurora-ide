import { auroraInvoke } from "../lib/runtime";
import type {
  AppSettings,
  DbLLMProvider,
  DbProviderModel,
  EditorState,
  ExplorerState,
  ToolSetting,
  WorkspaceState,
} from "../types/database";

/**
 * Database service for persisting application state
 */
class DatabaseService {
  public async getSetting(key: string): Promise<string | null> {
    try {
      const result = await auroraInvoke<string | null>('get_setting', { key });
      return result;
    } catch (error) {
      console.error(`Failed to get setting ${key}:`, error);
      return null;
    }
  }

  public async setSetting(key: string, value: string): Promise<void> {
    await auroraInvoke('set_setting', { key, value });
  }

  /**
   * Delete a provider
   */
  public async deleteProvider(id: string): Promise<void> {
    await auroraInvoke('delete_provider', { id });
  }

  // ============================================================
  // LLM PROVIDERS
  // ============================================================

  /**
   * Get all LLM providers
   */
  public async getAllProviders(): Promise<DbLLMProvider[]> {
    try {
      const result = await auroraInvoke<DbLLMProvider[]>('get_all_providers');
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
      const result = await auroraInvoke<ToolSetting[]>('get_all_tool_settings');
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
      const result = await auroraInvoke<AppSettings>('get_app_settings');
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
      const result = await auroraInvoke<EditorState | null>('get_editor_state', {
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
      const result = await auroraInvoke<ExplorerState | null>('get_explorer_state', {
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
      const result = await auroraInvoke<DbLLMProvider | null>('get_provider', { id });
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
      const result = await auroraInvoke<WorkspaceState | null>('get_workspace_state', {
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
      const result = await auroraInvoke<WorkspaceState[]>('list_recent_workspaces', { limit });
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
      const result = await auroraInvoke<boolean>('has_providers');
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
    await auroraInvoke('save_all_providers', { providers });
  }

  /**
   * Save all tool settings at once
   */
  public async saveAllToolSettings(settings: [string, string][]): Promise<void> {
    await auroraInvoke('save_all_tool_settings', { settings });
  }

  /**
   * Save all app settings
   */
  public async saveAppSettings(settings: AppSettings): Promise<void> {
    await auroraInvoke('save_app_settings', { settings });
  }

  // ============================================================
  // EDITOR STATE
  // ============================================================

  /**
   * Save editor state for a file (cursor position, scroll offset, folds)
   */
  public async saveEditorState(state: EditorState): Promise<void> {
    await auroraInvoke('save_editor_state', { state });
  }

  // ============================================================
  // EXPLORER STATE
  // ============================================================

  /**
   * Save explorer state (expanded folders, selected file)
   */
  public async saveExplorerState(state: ExplorerState): Promise<void> {
    await auroraInvoke('save_explorer_state', { state });
  }

  /**
   * Save or update a provider
   */
  public async saveProvider(provider: DbLLMProvider): Promise<void> {
    await auroraInvoke('save_provider', { provider });
  }

  // ============================================================
  // PROVIDER MODELS (v15+)
  // ============================================================

  /** Every model row across every provider. */
  public async listProviderModels(): Promise<DbProviderModel[]> {
    try {
      return await auroraInvoke<DbProviderModel[]>('list_provider_models');
    } catch (error) {
      console.error('Failed to list provider models:', error);
      return [];
    }
  }

  /** Models for a single provider. */
  public async listProviderModelsFor(providerId: string): Promise<DbProviderModel[]> {
    try {
      return await auroraInvoke<DbProviderModel[]>('list_provider_models_for', {
        providerId,
      });
    } catch (error) {
      console.error(`Failed to list models for provider ${providerId}:`, error);
      return [];
    }
  }

  /** Insert or update one model row. */
  public async upsertProviderModel(model: DbProviderModel): Promise<void> {
    await auroraInvoke('upsert_provider_model', { model });
  }

  /** Delete a single model row by `(providerId, modelKey)`. */
  public async deleteProviderModel(providerId: string, modelKey: string): Promise<void> {
    await auroraInvoke('delete_provider_model', { providerId, modelKey });
  }

  /**
   * Replace the full model list for a provider in one transaction.
   * Used by the unified Providers hub when the user finishes editing
   * a provider's model roster.
   */
  public async replaceProviderModels(
    providerId: string,
    models: DbProviderModel[],
  ): Promise<void> {
    await auroraInvoke('replace_provider_models', { providerId, models });
  }

  // ============================================================
  // WORKSPACE STATE
  // ============================================================

  /**
   * Save workspace state (open tabs, panel layout, etc.)
   */
  public async saveWorkspaceState(state: WorkspaceState): Promise<void> {
    await auroraInvoke('save_workspace_state', { state });
  }

  /**
   * Set tool approval mode
   */
  public async setToolApproval(toolName: string, approvalMode: string): Promise<void> {
    await auroraInvoke('set_tool_approval', { toolName, approvalMode });
  }
}

// Export singleton instance
export const databaseService = new DatabaseService();
