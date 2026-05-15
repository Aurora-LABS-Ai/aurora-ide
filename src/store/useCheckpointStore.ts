/**
 * Checkpoint Store
 *
 * Manages checkpoint state for the current thread/workspace.
 * Tracks which messages have checkpoints and handles restore operations.
 */

import { create } from "zustand";
import { checkpointService, type Checkpoint } from "../services/checkpoint";

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
  createCheckpoint: (
    messageId: string,
    threadIdOverride?: string,
  ) => Promise<boolean>;
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

export const useCheckpointStore = create<CheckpointState & CheckpointActions>(
  (set, get) => ({
    // State
    enabled: true,
    checkpoints: new Map(),
    isRestoring: false,
    workspacePath: null,
    threadId: null,

    // Actions
    initForWorkspace: async (workspacePath: string) => {
      const previousWorkspacePath = get().workspacePath;
      const enabled = await checkpointService.isEnabled(workspacePath);

      set((state) => ({
        workspacePath,
        enabled,
        threadId:
          previousWorkspacePath === workspacePath ? state.threadId : null,
        checkpoints:
          previousWorkspacePath === workspacePath
            ? state.checkpoints
            : new Map(),
      }));

      if (enabled) {
        void checkpointService.ensureInitialized(workspacePath);
        const currentThreadId = get().threadId;
        if (currentThreadId) {
          await get().loadCheckpointsForThread(currentThreadId);
        }
      }
    },

    loadCheckpointsForThread: async (threadId: string) => {
      const { workspacePath, enabled } = get();
      if (!workspacePath) return;

      if (!enabled) {
        set({ threadId, checkpoints: new Map() });
        return;
      }

      const checkpointList = await checkpointService.listCheckpoints(threadId);
      const checkpointMap = new Map<string, Checkpoint>();

      for (const cp of checkpointList) {
        if (cp.workspacePath === workspacePath) {
          checkpointMap.set(cp.messageId, cp);
        }
      }

      set({ threadId, checkpoints: checkpointMap });
    },

    createCheckpoint: async (messageId: string, threadIdOverride?: string) => {
      const { enabled, workspacePath, threadId: storeThreadId } = get();
      const threadId = threadIdOverride || storeThreadId;

      if (!enabled || !workspacePath || !threadId) {
        console.warn("[CheckpointStore] Cannot create checkpoint - missing:", {
          enabled,
          hasWorkspacePath: !!workspacePath,
          hasThreadId: !!threadId,
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
        messageId,
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
          checkpointId,
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

          // After a successful restore the workspace files were
          // rewritten by `git reset --hard` underneath us. The FS
          // watcher CAN see those changes, but in practice the burst
          // of writes during a hard reset is large enough that some
          // platforms (Windows in particular) batch / coalesce events
          // and we end up with stale Monaco buffers + a stale file
          // cache. Force a reload of every open tab here so the user
          // never sees pre-restore content. Done concurrently —
          // ordering between tabs doesn't matter.
          try {
            // `loadFileContent` lives on the workspace store (it
            // routes through the file cache); `lib/tauri` exposes
            // the lower-level `readFileContent` IPC wrapper, which
            // is fine for the post-restore reload since the
            // checkpoint mutation already invalidated every cached
            // entry under the workspace root.
            const [{ useEditorStore }, { readFileContent }, monacoRef] =
              await Promise.all([
                import("./useEditorStore"),
                import("../lib/tauri"),
                import("../lib/monaco-editor-ref"),
              ]);
            const editorStore = useEditorStore.getState();
            const reloadJobs = editorStore.tabs
              .filter((tab) => !tab.isDirty && tab.type !== "browser")
              .map(async (tab) => {
                try {
                  const newContent = await readFileContent(tab.path);
                  // Route through Monaco first so the restored
                  // content lands as one undoable entry (Ctrl+Z would
                  // bring back the pre-restore state, which matches
                  // the user's mental model of "checkpoint restore").
                  monacoRef.replaceMonacoFileContent(tab.path, newContent);
                  editorStore.reloadTabContent(tab.id, newContent);
                } catch (err) {
                  // File might have been deleted by the restore — mark
                  // the tab so the UI shows the "deleted" banner.
                  console.warn(
                    `[CheckpointStore] Failed to reload ${tab.path} after restore:`,
                    err,
                  );
                  editorStore.markTabAsDeleted(tab.id);
                }
              });
            await Promise.allSettled(reloadJobs);
          } catch (err) {
            console.warn(
              "[CheckpointStore] Post-restore tab reload setup failed:",
              err,
            );
          }

          return response.deletedMessageIds;
        }

        console.error("[CheckpointStore] Restore failed:", response.error);
        return [];
      } finally {
        set({ isRestoring: false });
      }
    },

    setEnabled: async (enabled: boolean) => {
      const { workspacePath, threadId } = get();

      if (!workspacePath) return;

      await checkpointService.setEnabled(workspacePath, enabled);

      if (!enabled) {
        await checkpointService.deleteWorkspaceCheckpoints(workspacePath);
        set({ enabled, checkpoints: new Map() });
        return;
      }

      set({ enabled });

      if (threadId) {
        await get().loadCheckpointsForThread(threadId);
      }
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
  }),
);
