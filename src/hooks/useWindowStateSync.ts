/**
 * Hook for synchronizing state between main window and detached chat window
 */

import { useEffect, useCallback, useRef } from 'react';
import { useThreadStore } from '../store/useThreadStore';
import type { Thread, ThreadSummary } from '../store/useThreadStore';
import { useChatStore } from '../store/useChatStore';
import { useSettingsStore } from '../store/useSettingsStore';
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

interface SettingsSyncData {
  selectedModel: string;
  thinkingEnabled: boolean;
  autoApproveTools: boolean;
  temperature: number;
  maxTokens: number;
}

export function useWindowStateSync() {
  const threadStore = useThreadStore();
  const chatStore = useChatStore();
  const settingsStore = useSettingsStore();

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

  return {
    emitThreadState,
    emitChatState,
    requestStateFromMain,
  };
}
