/**
 * Checkpoint Store
 *
 * Manages checkpoint state for the current thread/workspace.
 * Tracks which messages have checkpoints and handles restore operations.
 */

import { create } from 'zustand';
import { checkpointService, type Checkpoint } from '../services/checkpoint';

interface CheckpointState {
  /** Whether checkpoints are enabled for current workspace */
  enabled: boolean;
  /** Map of messageId -> checkpoint for current thread */
  checkpoints: Map<string, Checkpoint>;
  /** Whether we're currently restoring */
  isRestoring: boolean;
  /** Current workspace path */
  workspacePath: string | null;
  /** Current thread ID */
  threadId: string | null;
}

interface CheckpointActions {
  /** Initialize store for a workspace */
  initForWorkspace: (workspacePath: string) => Promise<void>;
  /** Load checkpoints for a thread */
  loadCheckpointsForThread: (threadId: string) => Promise<void>;
  /** Create a checkpoint when user sends a message - threadId can be passed directly for new threads */
  createCheckpoint: (messageId: string, threadIdOverride?: string) => Promise<boolean>;
  /** Restore to a specific checkpoint */
  restoreToCheckpoint: (checkpointId: string) => Promise<string[]>;
  /** Toggle checkpoint enabled for workspace */
  setEnabled: (enabled: boolean) => Promise<void>;
  /** Check if a message has a checkpoint */
  hasCheckpoint: (messageId: string) => boolean;
  /** Get checkpoint for a message */
  getCheckpoint: (messageId: string) => Checkpoint | undefined;
  /** Clear store state */
  clear: () => void;
}

export const useCheckpointStore = create<CheckpointState & CheckpointActions>((set, get) => ({
  // State
  enabled: true,
  checkpoints: new Map(),
  isRestoring: false,
  workspacePath: null,
  threadId: null,

  // Actions
  initForWorkspace: async (workspacePath: string) => {
    const enabled = await checkpointService.isEnabled(workspacePath);
    set({ workspacePath, enabled });
  },

  loadCheckpointsForThread: async (threadId: string) => {
    const { workspacePath } = get();
    if (!workspacePath) return;

    const checkpointList = await checkpointService.listCheckpoints(threadId);
    const checkpointMap = new Map<string, Checkpoint>();

    for (const cp of checkpointList) {
      checkpointMap.set(cp.messageId, cp);
    }

    set({ threadId, checkpoints: checkpointMap });
  },

  createCheckpoint: async (messageId: string, threadIdOverride?: string) => {
    const { enabled, workspacePath, threadId: storeThreadId } = get();
    const threadId = threadIdOverride || storeThreadId;

    if (!enabled || !workspacePath || !threadId) {
      console.warn('[CheckpointStore] Cannot create checkpoint - missing:', {
        enabled,
        hasWorkspacePath: !!workspacePath,
        hasThreadId: !!threadId
      });
      return false;
    }

    // Update store's threadId if we got an override (for new threads)
    if (threadIdOverride && threadIdOverride !== storeThreadId) {
      set({ threadId: threadIdOverride });
    }

    const response = await checkpointService.createCheckpoint(
      workspacePath,
      threadId,
      messageId
    );

    if (response.success && response.checkpoint) {
      set((state) => {
        const newCheckpoints = new Map(state.checkpoints);
        newCheckpoints.set(messageId, response.checkpoint!);
        return { checkpoints: newCheckpoints };
      });
      return true;
    }

    return false;
  },

  restoreToCheckpoint: async (checkpointId: string) => {
    const { workspacePath, threadId } = get();

    if (!workspacePath || !threadId) {
      return [];
    }

    set({ isRestoring: true });

    try {
      const response = await checkpointService.restoreCheckpoint(
        workspacePath,
        threadId,
        checkpointId
      );

      if (response.success) {
        // Remove deleted checkpoints from our map
        set((state) => {
          const newCheckpoints = new Map(state.checkpoints);
          for (const msgId of response.deletedMessageIds) {
            newCheckpoints.delete(msgId);
          }
          return { checkpoints: newCheckpoints };
        });

        return response.deletedMessageIds;
      }

      console.error('[CheckpointStore] Restore failed:', response.error);
      return [];
    } finally {
      set({ isRestoring: false });
    }
  },

  setEnabled: async (enabled: boolean) => {
    const { workspacePath } = get();

    if (!workspacePath) return;

    await checkpointService.setEnabled(workspacePath, enabled);
    set({ enabled });
  },

  hasCheckpoint: (messageId: string) => {
    return get().checkpoints.has(messageId);
  },

  getCheckpoint: (messageId: string) => {
    return get().checkpoints.get(messageId);
  },

  clear: () => {
    set({
      enabled: true,
      checkpoints: new Map(),
      isRestoring: false,
      workspacePath: null,
      threadId: null,
    });
  },
}));
