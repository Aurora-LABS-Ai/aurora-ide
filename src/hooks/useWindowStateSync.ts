/**
 * Hook for synchronizing state between main window and detached chat window
 */

import { useEffect, useCallback, useRef } from 'react';
import { useThreadStore } from '../store/useThreadStore';
import type { Thread, ThreadSummary } from '../store/useThreadStore';
import { useChatStore } from '../store/useChatStore';
import { useTaskStore } from '../store/useTaskStore';
import type { Task } from '../store/useTaskStore';
import {
  emitSyncEvent,
  listenForSyncEvent,
  SYNC_EVENTS,
  isMainWindow,
  isDetachedChatWindow,
} from '../lib/windowSync';
import { isTauri } from '../lib/tauri';

interface ThreadSyncData {
  currentThreadId: string | null;
  threads: Record<string, Thread>;
  threadList: ThreadSummary[];
}

interface ChatSyncData {
  isLoading: boolean;
  pendingApproval: any | null;
}

interface TaskSyncData {
  tasks: Task[];
  isVisible: boolean;
}

// Settings sync data interface (for future use)
// interface SettingsSyncData {
//   selectedModel: string;
//   thinkingEnabled: boolean;
//   autoApproveTools: boolean;
//   temperature: number;
//   maxTokens: number;
// }

export function useWindowStateSync() {
  const threadStore = useThreadStore();
  const chatStore = useChatStore();
  const taskStore = useTaskStore();
  // Settings sync currently handled by database
  // const settingsStore = useSettingsStore();

  const isInitializedRef = useRef(false);
  const lastSyncRef = useRef<number>(0);

  // Debounce sync emissions to avoid flooding
  const shouldSync = useCallback(() => {
    const now = Date.now();
    if (now - lastSyncRef.current < 100) return false;
    lastSyncRef.current = now;
    return true;
  }, []);

  // Emit thread state to other windows
  const emitThreadState = useCallback(async () => {
    if (!shouldSync()) return;

    const data: ThreadSyncData = {
      currentThreadId: threadStore.currentThreadId,
      threads: threadStore.threads,
      threadList: threadStore.threadList,
    };
    await emitSyncEvent(SYNC_EVENTS.THREAD_STATE_SYNC, data);
  }, [threadStore.currentThreadId, threadStore.threads, threadStore.threadList, shouldSync]);

  // Emit chat state to other windows
  const emitChatState = useCallback(async () => {
    if (!shouldSync()) return;

    const data: ChatSyncData = {
      isLoading: chatStore.isLoading,
      pendingApproval: chatStore.pendingApproval,
    };
    await emitSyncEvent(SYNC_EVENTS.CHAT_STATE_SYNC, data);
  }, [chatStore.isLoading, chatStore.pendingApproval, shouldSync]);

  // Emit task state to other windows
  const emitTaskState = useCallback(async () => {
    if (!shouldSync()) return;

    const data: TaskSyncData = {
      tasks: taskStore.tasks,
      isVisible: taskStore.isVisible,
    };
    await emitSyncEvent(SYNC_EVENTS.TASK_STATE_SYNC, data);
  }, [taskStore.tasks, taskStore.isVisible, shouldSync]);

  // Request state from main window (used by detached window on mount)
  const requestStateFromMain = useCallback(async () => {
    await emitSyncEvent(SYNC_EVENTS.THREAD_STATE_REQUEST, {});
  }, []);

  // Setup listeners and initial sync
  useEffect(() => {
    if (!isTauri() || isInitializedRef.current) return;
    isInitializedRef.current = true;

    let unlistenThread: (() => void) | null = null;
    let unlistenChat: (() => void) | null = null;
    let unlistenTask: (() => void) | null = null;
    let unlistenRequest: (() => void) | null = null;

    const setup = async () => {
      const isMain = await isMainWindow();
      const isDetached = await isDetachedChatWindow();

      // Listen for thread state sync
      unlistenThread = await listenForSyncEvent<ThreadSyncData>(
        SYNC_EVENTS.THREAD_STATE_SYNC,
        (data) => {
          // Update local state with received data
          useThreadStore.setState({
            currentThreadId: data.currentThreadId,
            threads: data.threads,
            threadList: data.threadList,
          });
        }
      );

      // Listen for chat state sync
      unlistenChat = await listenForSyncEvent<ChatSyncData>(
        SYNC_EVENTS.CHAT_STATE_SYNC,
        (data) => {
          useChatStore.setState({
            isLoading: data.isLoading,
            pendingApproval: data.pendingApproval,
          });
        }
      );

      // Listen for task state sync
      unlistenTask = await listenForSyncEvent<TaskSyncData>(
        SYNC_EVENTS.TASK_STATE_SYNC,
        (data) => {
          useTaskStore.setState({
            tasks: data.tasks,
            isVisible: data.isVisible,
          });
        }
      );

      // Main window listens for state requests
      if (isMain) {
        unlistenRequest = await listenForSyncEvent(
          SYNC_EVENTS.THREAD_STATE_REQUEST,
          async () => {
            // Send current state to requesting window
            const data: ThreadSyncData = {
              currentThreadId: useThreadStore.getState().currentThreadId,
              threads: useThreadStore.getState().threads,
              threadList: useThreadStore.getState().threadList,
            };
            await emitSyncEvent(SYNC_EVENTS.THREAD_STATE_SYNC, data);

            // Also send chat state
            const chatData: ChatSyncData = {
              isLoading: useChatStore.getState().isLoading,
              pendingApproval: useChatStore.getState().pendingApproval,
            };
            await emitSyncEvent(SYNC_EVENTS.CHAT_STATE_SYNC, chatData);

            // Also send task state
            const taskData: TaskSyncData = {
              tasks: useTaskStore.getState().tasks,
              isVisible: useTaskStore.getState().isVisible,
            };
            await emitSyncEvent(SYNC_EVENTS.TASK_STATE_SYNC, taskData);
          }
        );
      }

      // Detached window requests initial state
      if (isDetached) {
        // Small delay to ensure main window listener is ready
        setTimeout(() => {
          requestStateFromMain();
        }, 100);
      }
    };

    setup();

    return () => {
      unlistenThread?.();
      unlistenChat?.();
      unlistenTask?.();
      unlistenRequest?.();
    };
  }, [requestStateFromMain]);

  // Emit state changes (throttled)
  useEffect(() => {
    if (!isTauri()) return;
    emitThreadState();
  }, [threadStore.currentThreadId, threadStore.threads, emitThreadState]);

  useEffect(() => {
    if (!isTauri()) return;
    emitChatState();
  }, [chatStore.isLoading, chatStore.pendingApproval, emitChatState]);

  useEffect(() => {
    if (!isTauri()) return;
    emitTaskState();
  }, [taskStore.tasks, taskStore.isVisible, emitTaskState]);


  return {
    emitThreadState,
    emitChatState,
    emitTaskState,
    requestStateFromMain,
  };
}
