/**
 * Hook for syncing chat state via Rust backend
 * 
 * This hook listens to 'chat-state-changed' events from Rust
 * and updates the local Zustand stores. This provides bulletproof
 * multi-window sync because Rust is the single source of truth.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import { useCallback, useEffect } from "react";

import { isTauri } from "../lib/tauri";
import { useChatStore } from "../store/useChatStore";
import { useThreadStore } from "../store/useThreadStore";

// Types matching Rust structs
interface ChatState {
    current_thread_id: string | null;
    is_loading: boolean;
    pending_approval: any | null;
}

interface ChatStateEvent {
    source: string;
    state: ChatState;
}

interface BroadcastEvent {
    event_type: string;
    payload: string;
    source: string;
}

// Window identifier for this window
const getWindowSource = (): string => {
    if (typeof window !== 'undefined') {
        return window.location.pathname.includes('chat-detached') ? 'detached' : 'main';
    }
    return 'main';
};

/**
 * Hook to sync chat state between windows via Rust
 * Call this once at the app root level
 */
export function useRustChatSync() {
    const setLoading = useChatStore((s) => s.setLoading);
    const setPendingApproval = useChatStore((s) => s.setPendingApproval);
    const loadThread = useThreadStore((s) => s.loadThread);
    const clearCurrentThread = useThreadStore((s) => s.clearCurrentThread);
    const updateMessageInThread = useThreadStore((s) => s.updateMessageInThread);

    // Listen for chat state changes from Rust
    useEffect(() => {
        if (!isTauri()) return;

        let unlisten: (() => void) | null = null;
        let unlistenBroadcast: (() => void) | null = null;

        const setup = async () => {
            try {
                unlisten = await listen<ChatStateEvent>('chat-state-changed', (event) => {
                    const { state, source } = event.payload;
                    const mySource = getWindowSource();

                    // Skip updates that originated from this window (we already have them)
                    if (source === mySource) return;

                    console.log(`[RustChatSync] Received update from ${source}:`, state);

                    // Update local stores
                    setLoading(state.is_loading);
                    setPendingApproval(state.pending_approval);

                    // Handle thread changes
                    if (state.current_thread_id) {
                        loadThread(state.current_thread_id);
                    } else {
                        clearCurrentThread();
                    }
                });

                // Listen for generic broadcasts (like stream updates)
                unlistenBroadcast = await listen<BroadcastEvent>('chat-broadcast', (event) => {
                    const { event_type, payload, source } = event.payload;
                    const mySource = getWindowSource();

                    if (source === mySource) return;

                    if (event_type === 'stream-update') {
                        try {
                            const update = JSON.parse(payload);
                            updateMessageInThread(update.messageId, {
                                timeline: update.timeline
                            });
                        } catch (e) {
                            console.error('[RustChatSync] Failed to parse stream update:', e);
                        }
                    }
                });

                // Get initial state from Rust
                const initialState = await invoke<ChatState>('get_chat_state');
                console.log('[RustChatSync] Initial state:', initialState);

                setLoading(initialState.is_loading);
                setPendingApproval(initialState.pending_approval);
                if (initialState.current_thread_id) {
                    loadThread(initialState.current_thread_id);
                }
            } catch (error) {
                console.error('[RustChatSync] Setup failed:', error);
            }
        };

        setup();

        return () => {
            if (unlisten) {
                try {
                    unlisten();
                } catch {
                    // Ignore cleanup errors
                }
            }
            if (unlistenBroadcast) {
                try {
                    unlistenBroadcast();
                } catch {
                    // Ignore cleanup errors
                }
            }
        };
    }, [setLoading, setPendingApproval, loadThread, clearCurrentThread, updateMessageInThread]);

    // Helper functions to update state via Rust (broadcasts to all windows)
    const broadcastLoading = useCallback(async (isLoading: boolean) => {
        if (!isTauri()) return;
        try {
            await invoke('set_chat_loading', {
                isLoading,
                source: getWindowSource(),
            });
        } catch (error) {
            console.error('[RustChatSync] Failed to broadcast loading:', error);
        }
    }, []);

    const broadcastThread = useCallback(async (threadId: string | null) => {
        if (!isTauri()) return;
        try {
            await invoke('set_current_thread', {
                threadId,
                source: getWindowSource(),
            });
        } catch (error) {
            console.error('[RustChatSync] Failed to broadcast thread:', error);
        }
    }, []);

    const broadcastApproval = useCallback(async (approval: any | null) => {
        if (!isTauri()) return;
        try {
            await invoke('set_pending_approval', {
                approval,
                source: getWindowSource(),
            });
        } catch (error) {
            console.error('[RustChatSync] Failed to broadcast approval:', error);
        }
    }, []);

    const broadcastClear = useCallback(async () => {
        if (!isTauri()) return;
        try {
            await invoke('clear_chat_state', {
                source: getWindowSource(),
            });
        } catch (error) {
            console.error('[RustChatSync] Failed to broadcast clear:', error);
        }
    }, []);

    return {
        broadcastLoading,
        broadcastThread,
        broadcastApproval,
        broadcastClear,
    };
}

// Singleton exports for use outside React components
export const chatSyncBroadcast = {
    async setLoading(isLoading: boolean) {
        if (!isTauri()) return;
        try {
            await invoke('set_chat_loading', {
                isLoading,
                source: getWindowSource(),
            });
        } catch (error) {
            console.error('[RustChatSync] Broadcast failed:', error);
        }
    },

    async setThread(threadId: string | null) {
        if (!isTauri()) return;
        try {
            await invoke('set_current_thread', {
                threadId,
                source: getWindowSource(),
            });
        } catch (error) {
            console.error('[RustChatSync] Broadcast failed:', error);
        }
    },

    async setApproval(approval: any | null) {
        if (!isTauri()) return;
        try {
            await invoke('set_pending_approval', {
                approval,
                source: getWindowSource(),
            });
        } catch (error) {
            console.error('[RustChatSync] Broadcast failed:', error);
        }
    },

    async clear() {
        if (!isTauri()) return;
        try {
            await invoke('clear_chat_state', {
                source: getWindowSource(),
            });
        } catch (error) {
            console.error('[RustChatSync] Broadcast failed:', error);
        }
    },

    async broadcastStreamUpdate(messageId: string, timeline: any[]) {
        if (!isTauri()) return;
        try {
            await invoke('broadcast_chat_event', {
                eventType: 'stream-update',
                payload: JSON.stringify({ messageId, timeline }),
                source: getWindowSource(),
            });
        } catch (error) {
            console.error('[RustChatSync] Broadcast stream failed:', error);
        }
    },
};
