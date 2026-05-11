/**
 * Pending File Changes Store
 * 
 * Enterprise-grade state management for file modification approvals.
 * Follows the same pattern as tool approvals but for file operations.
 */
import { create } from "zustand";

import { isTauri, readFileContent, writeFileContent } from "../lib/tauri";
import { replaceMonacoFileContent } from "../lib/monaco-editor-ref";
import { useSettingsStore } from "./useSettingsStore";

interface PendingChangesState {
    acceptAll: () => Promise<{ accepted: number; failed: number }>;
    acceptChange: (id: string) => Promise<{ success: boolean; error?: string }>;

    // Actions
    addChange: (change: Omit<PendingChange, 'id' | 'timestamp' | 'status'>) => string;
    changes: Map<string, PendingChange>;
    clearAccepted: () => void;
    getChange: (id: string) => PendingChange | undefined;
    getChangeByToolId: (toolCallId: string) => PendingChange | undefined;
    getPendingChanges: () => PendingChange[];
    getSelectedChange: () => PendingChange | undefined;
    navigateChange: (direction: 'prev' | 'next') => void;
    rejectAll: () => Promise<void>;
    rejectChange: (id: string) => Promise<void>;
    reset: () => void;
    selectedChangeIndex: number;
    setSelectedChangeIndex: (index: number) => void;
}

export interface PendingChange {
    content: string;
    fileName: string;
    filePath: string;
    id: string;
    operation: ChangeOperation;
    originalContent?: string;

    // For patch operations
    patchInfo?: {
        startLine: number;
        endLine: number;
        linesReplaced: number;
        linesInserted: number;
    };
    status: ChangeStatus;
    timestamp: number;
    toolCallId: string;
}

// Types
export type ChangeOperation = 'create' | 'write' | 'patch' | 'delete';

export type ChangeStatus = 'pending' | 'accepted' | 'rejected';

// Generate unique ID
const generateId = () => `change_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

// Helper to load original content for diff
export async function loadOriginalContent(filePath: string): Promise<string | undefined> {
    if (!isTauri()) return undefined;

    try {
        return await readFileContent(filePath);
    } catch {
        // File doesn't exist (create operation)
        return undefined;
    }
}

export const usePendingChangesStore = create<PendingChangesState>((set, get) => ({
    changes: new Map(),
    selectedChangeIndex: 0,

    addChange: (change) => {
        // Check if auto-accept is enabled
        const autoAcceptChanges = useSettingsStore.getState().autoAcceptChanges;

        if (autoAcceptChanges) {
            // Auto-accept: don't add to pending, just log and return empty id
            console.log(`[PendingChanges] Auto-accepted: ${change.operation} ${change.filePath}`);
            
            // Update editor tab if open (file is already written to disk).
            // Route through Monaco's undoable pipeline first so a native
            // Ctrl+Z reverts the AI edit; the React state reload that
            // follows is a no-op for Monaco (values match) and only
            // resets the dirty flag.
            import('./useEditorStore').then(({ useEditorStore }) => {
                const tab = useEditorStore.getState().tabs.find(t => t.path === change.filePath);
                if (tab && change.content) {
                    replaceMonacoFileContent(change.filePath, change.content);
                    useEditorStore.getState().reloadTabContent(tab.id, change.content);
                }
            }).catch(() => {});
            
            return `auto_${Date.now()}`;
        }

        const id = generateId();
        const newChange: PendingChange = {
            ...change,
            id,
            status: 'pending',
            timestamp: Date.now(),
        };

        set((state) => {
            const newChanges = new Map(state.changes);
            newChanges.set(id, newChange);
            return { changes: newChanges };
        });

        console.log(`[PendingChanges] Added: ${change.operation} ${change.filePath}`);
        return id;
    },

    // CURSOR-STYLE: Accept just marks as accepted (file already written to disk)
    acceptChange: async (id) => {
        const state = get();
        const change = state.changes.get(id);

        if (!change) {
            return { success: false, error: 'Change not found' };
        }

        if (change.status !== 'pending') {
            return { success: false, error: 'Change already processed' };
        }

        // File is already on disk (Cursor-style). Route through Monaco's
        // undoable edit so the user can press Ctrl+Z to revert this AI
        // change as one entry on the buffer's native undo stack.
        try {
            const { useEditorStore } = await import('./useEditorStore');
            const tab = useEditorStore.getState().tabs.find(t => t.path === change.filePath);
            if (tab && change.content) {
                replaceMonacoFileContent(change.filePath, change.content);
                useEditorStore.getState().reloadTabContent(tab.id, change.content);
                console.log(`[PendingChanges] Reloaded editor content: ${change.filePath}`);
            }
        } catch (error) {
            console.error(`[PendingChanges] Failed to reload editor:`, error);
        }

        // Mark as accepted and remove from pending
        set((state) => {
            const newChanges = new Map(state.changes);
            newChanges.delete(id); // Remove instead of keeping as 'accepted' to prevent re-clicks
            return { changes: newChanges };
        });

        console.log(`[PendingChanges] Accepted & removed: ${change.filePath}`);
        return { success: true };
    },

    // CURSOR-STYLE: Reject reverts file to original content
    rejectChange: async (id) => {
        const state = get();
        const change = state.changes.get(id);

        if (!change || change.status !== 'pending') return;

        if (!isTauri()) {
            console.error('[PendingChanges] Cannot revert: not in Tauri');
            return;
        }

        try {
            if (change.operation === 'create' && change.originalContent === undefined) {
                // New file - delete it on reject
                const { deletePath } = await import('../lib/tauri');
                await deletePath(change.filePath);
                console.log(`[PendingChanges] Rejected & deleted: ${change.filePath}`);
            } else if (change.originalContent !== undefined) {
                // Existing file - revert to original
                await writeFileContent(change.filePath, change.originalContent);
                console.log(`[PendingChanges] Rejected & reverted: ${change.filePath}`);

                // Update editor tab content to show reverted content.
                // Apply through Monaco so the revert itself is undoable.
                const { useEditorStore } = await import('./useEditorStore');
                const tab = useEditorStore.getState().tabs.find(t => t.path === change.filePath);
                if (tab) {
                    replaceMonacoFileContent(change.filePath, change.originalContent);
                    useEditorStore.getState().reloadTabContent(tab.id, change.originalContent);
                }
            }
        } catch (error) {
            console.error(`[PendingChanges] Failed to revert:`, error);
        }

        // Mark as rejected
        set((state) => {
            const newChanges = new Map(state.changes);
            newChanges.set(id, { ...change, status: 'rejected' });
            return { changes: newChanges };
        });
    },

    acceptAll: async () => {
        const pending = get().getPendingChanges();
        let accepted = 0;
        let failed = 0;

        for (const change of pending) {
            const result = await get().acceptChange(change.id);
            if (result.success) {
                accepted++;
            } else {
                failed++;
            }
        }

        return { accepted, failed };
    },

    rejectAll: async () => {
        const pending = get().getPendingChanges();
        for (const change of pending) {
            await get().rejectChange(change.id);
        }
    },

    getChange: (id) => get().changes.get(id),

    getPendingChanges: () => {
        const changes = Array.from(get().changes.values());
        return changes
            .filter((c) => c.status === 'pending')
            .sort((a, b) => a.timestamp - b.timestamp);
    },

    getChangeByToolId: (toolCallId) => {
        const changes = Array.from(get().changes.values());
        return changes.find((c) => c.toolCallId === toolCallId);
    },

    getSelectedChange: () => {
        const pending = get().getPendingChanges();
        const index = get().selectedChangeIndex;
        if (pending.length === 0) return undefined;
        // Clamp index to valid range
        const clampedIndex = Math.max(0, Math.min(index, pending.length - 1));
        return pending[clampedIndex];
    },

    setSelectedChangeIndex: (index) => {
        const pending = get().getPendingChanges();
        const clampedIndex = Math.max(0, Math.min(index, pending.length - 1));
        set({ selectedChangeIndex: clampedIndex });
    },

    navigateChange: (direction) => {
        const pending = get().getPendingChanges();
        if (pending.length <= 1) return;

        const currentIndex = get().selectedChangeIndex;
        let newIndex: number;

        if (direction === 'prev') {
            newIndex = currentIndex > 0 ? currentIndex - 1 : pending.length - 1;
        } else {
            newIndex = currentIndex < pending.length - 1 ? currentIndex + 1 : 0;
        }

        set({ selectedChangeIndex: newIndex });
    },

    clearAccepted: () => {
        set((state) => {
            const newChanges = new Map(state.changes);
            for (const [id, change] of newChanges) {
                if (change.status === 'accepted') {
                    newChanges.delete(id);
                }
            }
            return { changes: newChanges };
        });
    },

    reset: () => set({ changes: new Map(), selectedChangeIndex: 0 })
}));
