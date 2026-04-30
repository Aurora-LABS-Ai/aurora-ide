/**
 * Checkpoint Service
 *
 * Manages workspace file state checkpoints. Each checkpoint captures the state
 * of all files in the workspace at the moment a user sends a message.
 *
 * When a user restores to a checkpoint:
 * 1. All workspace files are restored to that point in time
 * 2. All messages after that checkpoint are deleted from the thread
 * 3. All checkpoints after that point are deleted
 */

import { auroraInvoke as invoke } from "../lib/runtime";

/**
 * Checkpoint data representing a point-in-time snapshot
 */
export interface Checkpoint {
  /** Git commit hash (unique ID) */
  id: string;
  /** Associated message ID in the thread */
  messageId: string;
  /** Thread ID this checkpoint belongs to */
  threadId: string;
  /** Workspace path this checkpoint is for */
  workspacePath: string;
  /** ISO timestamp when checkpoint was created */
  createdAt: string;
}

/**
 * Response from checkpoint create operation
 */
export interface CheckpointResponse {
  success: boolean;
  checkpoint?: Checkpoint;
  error?: string;
}

/**
 * Response from checkpoint restore operation
 */
export interface RestoreResponse {
  success: boolean;
  deletedMessageIds: string[];
  error?: string;
}

/**
 * Checkpoint Service - manages workspace file state snapshots
 */
class CheckpointService {
  private readonly initPromises = new Map<string, Promise<void>>();

  /**
   * Initialize the checkpoint service (called on app startup)
   */
  async init(): Promise<void> {
    try {
      await invoke("checkpoint_init");
    } catch (error) {
      console.error("[CheckpointService] Failed to initialize:", error);
    }
  }

  /**
   * Ensure the shadow checkpoint repository exists for a workspace.
   * This lets the app pay the heavy first-time setup cost before the user sends a message.
   */
  async ensureInitialized(workspacePath: string): Promise<void> {
    const existing = this.initPromises.get(workspacePath);
    if (existing) {
      return existing;
    }

    const promise = invoke<void>("checkpoint_ensure_initialized", { workspacePath })
      .catch((error) => {
        console.error(
          "[CheckpointService] Failed to ensure initialization:",
          error,
        );
        throw error;
      })
      .finally(() => {
        this.initPromises.delete(workspacePath);
      });

    this.initPromises.set(workspacePath, promise);
    return promise;
  }

  /**
   * Create a checkpoint for the current workspace state
   * Called when user sends a message
   */
  async createCheckpoint(
    workspacePath: string,
    threadId: string,
    messageId: string,
  ): Promise<CheckpointResponse> {
    try {
      const response = await invoke<CheckpointResponse>("checkpoint_create", {
        workspacePath,
        threadId,
        messageId,
      });
      return response;
    } catch (error) {
      console.error("[CheckpointService] Failed to create checkpoint:", error);
      return {
        success: false,
        error: String(error),
      };
    }
  }

  /**
   * Restore workspace to a specific checkpoint
   * This will also delete all messages after the checkpoint
   */
  async restoreCheckpoint(
    workspacePath: string,
    threadId: string,
    checkpointId: string,
  ): Promise<RestoreResponse> {
    try {
      const response = await invoke<RestoreResponse>("checkpoint_restore", {
        workspacePath,
        threadId,
        checkpointId,
      });
      return response;
    } catch (error) {
      console.error("[CheckpointService] Failed to restore checkpoint:", error);
      return {
        success: false,
        deletedMessageIds: [],
        error: String(error),
      };
    }
  }

  /**
   * Get all checkpoints for a thread
   */
  async listCheckpoints(threadId: string): Promise<Checkpoint[]> {
    try {
      return await invoke<Checkpoint[]>("checkpoint_list", { threadId });
    } catch (error) {
      console.error("[CheckpointService] Failed to list checkpoints:", error);
      return [];
    }
  }

  /**
   * Get checkpoint by message ID
   */
  async getCheckpointByMessage(messageId: string): Promise<Checkpoint | null> {
    try {
      return await invoke<Checkpoint | null>("checkpoint_get_by_message", {
        messageId,
      });
    } catch (error) {
      console.error("[CheckpointService] Failed to get checkpoint:", error);
      return null;
    }
  }

  /**
   * Delete all checkpoints for a thread
   */
  async deleteThreadCheckpoints(
    threadId: string,
    workspacePath?: string,
  ): Promise<void> {
    try {
      await invoke("checkpoint_delete_thread", { threadId, workspacePath });
    } catch (error) {
      console.error(
        "[CheckpointService] Failed to delete thread checkpoints:",
        error,
      );
    }
  }

  /**
   * Delete all checkpoints for a workspace
   */
  async deleteWorkspaceCheckpoints(workspacePath: string): Promise<void> {
    try {
      await invoke("checkpoint_delete_workspace", { workspacePath });
    } catch (error) {
      console.error(
        "[CheckpointService] Failed to delete workspace checkpoints:",
        error,
      );
    }
  }

  /**
   * Check if checkpoint service is initialized for a workspace
   */
  async isInitialized(workspacePath: string): Promise<boolean> {
    try {
      return await invoke<boolean>("checkpoint_is_initialized", {
        workspacePath,
      });
    } catch (error) {
      console.error(
        "[CheckpointService] Failed to check initialization:",
        error,
      );
      return false;
    }
  }

  /**
   * Get checkpoint enabled setting for a workspace
   * Returns true by default for new workspaces
   */
  async isEnabled(workspacePath: string): Promise<boolean> {
    try {
      return await invoke<boolean>("checkpoint_get_enabled", { workspacePath });
    } catch (error) {
      console.error(
        "[CheckpointService] Failed to get enabled setting:",
        error,
      );
      return true; // Default to enabled
    }
  }

  /**
   * Set checkpoint enabled setting for a workspace
   */
  async setEnabled(workspacePath: string, enabled: boolean): Promise<void> {
    try {
      await invoke("checkpoint_set_enabled", { workspacePath, enabled });
    } catch (error) {
      console.error(
        "[CheckpointService] Failed to set enabled setting:",
        error,
      );
    }
  }
}

// Export singleton instance
export const checkpointService = new CheckpointService();
