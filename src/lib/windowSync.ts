/**
 * Cross-window state synchronization using Tauri events
 * This enables the detached chat window to share state with the main window
 */

import { isTauri } from './tauri';

// Event names for state sync
export const SYNC_EVENTS = {
  THREAD_STATE_SYNC: 'thread-state-sync',
  THREAD_STATE_REQUEST: 'thread-state-request',
  CHAT_STATE_SYNC: 'chat-state-sync',
  UI_STATE_SYNC: 'ui-state-sync',
  TASK_STATE_SYNC: 'task-state-sync',
} as const;

interface SyncPayload<T> {
  source: string;
  timestamp: number;
  data: T;
}

/**
 * Emit a sync event to all windows
 */
export async function emitSyncEvent<T>(eventName: string, data: T): Promise<void> {
  if (!isTauri()) return;

  try {
    const { emit } = await import('@tauri-apps/api/event');
    const payload: SyncPayload<T> = {
      source: await getWindowLabel(),
      timestamp: Date.now(),
      data,
    };
    await emit(eventName, payload);
  } catch (error) {
    console.error('Failed to emit sync event:', error);
  }
}

/**
 * Listen for sync events from other windows
 */
export async function listenForSyncEvent<T>(
  eventName: string,
  callback: (data: T, source: string) => void
): Promise<(() => void) | null> {
  if (!isTauri()) return null;

  try {
    const { listen } = await import('@tauri-apps/api/event');
    const currentWindow = await getWindowLabel();

    const unlisten = await listen<SyncPayload<T>>(eventName, (event) => {
      // Ignore events from self
      if (event.payload.source === currentWindow) return;
      callback(event.payload.data, event.payload.source);
    });

    return unlisten;
  } catch (error) {
    console.error('Failed to listen for sync event:', error);
    return null;
  }
}

/**
 * Get current window label
 */
export async function getWindowLabel(): Promise<string> {
  if (!isTauri()) return 'web';

  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    return getCurrentWindow().label;
  } catch (error) {
    return 'unknown';
  }
}

/**
 * Check if current window is the main window
 */
export async function isMainWindow(): Promise<boolean> {
  const label = await getWindowLabel();
  return label === 'main';
}

/**
 * Check if current window is the detached chat window
 */
export async function isDetachedChatWindow(): Promise<boolean> {
  const label = await getWindowLabel();
  return label === 'chat-detached';
}
