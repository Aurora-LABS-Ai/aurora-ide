import { create } from "zustand";
import { persist } from "zustand/middleware";

import { deletePath, isTauri, readDirectory, readFileContent, writeFileContent } from "../lib/tauri";
import { threadService, type DbMessage, type DbThread } from "../services/thread-service";
import type { Message } from "../types";
import { useContextStore } from "./useContextStore";

interface ThreadState {
  // Message actions
  addMessageToThread: (message: Message) => void;
  clearCurrentThread: () => void;
  removeMessagesAfter: (messageId: string, includeMessage?: boolean) => void;

  // Actions
  createThread: () => string;
  currentThreadId: string | null;
  deleteThread: (threadId: string) => Promise<void>;
  deleteThreadFile: (threadId: string) => Promise<boolean>;

  // History
  getThreadList: () => ThreadSummary[];
  isLoading: boolean;
  loadAllThreadsFromFiles: () => Promise<void>;
  /** Load thread - returns the loaded thread (waits for file load if needed) */
  loadThread: (threadId: string) => Promise<Thread | null>;
  loadThreadFromFile: (threadId: string) => Promise<Thread | null>;

  // Persistence
  saveCurrentThread: (force?: boolean) => Promise<void>;
  threadList: ThreadSummary[];
  threads: Record<string, Thread>;
  updateMessageInThread: (messageId: string, updates: Partial<Message>) => void;
  updateThreadTitle: (threadId: string, title: string) => void;

  // Token/Context usage tracking
  updateThreadUsage: (tokenUsage: TokenUsage, contextUsage: ContextUsage) => void;
}

export interface ContextUsage {
  contextWindow: number;
  percentage: number;
  usedTokens: number;
}

export interface Thread {
  contextUsage?: ContextUsage;
  createdAt: number;
  id: string;
  messages: Message[];
  title: string;
  tokenUsage?: TokenUsage;
  updatedAt: number;
}

export interface ThreadSummary {
  createdAt: number;
  id: string;
  messageCount: number;
  preview: string;
  title: string;
  updatedAt: number;
}

// ============================================
// THREAD TYPES
// ============================================
export interface TokenUsage {
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  completionTokens: number;
  promptTokens: number;
  totalTokens: number;
}

const fromDbThread = (dbThread: DbThread): Thread => ({
  id: dbThread.id,
  title: dbThread.title,
  createdAt: Date.parse(dbThread.created_at) || Date.now(),
  updatedAt: Date.parse(dbThread.updated_at) || Date.now(),
  messages: (dbThread.messages || []).map((m: DbMessage) => ({
    id: m.id,
    sender: (m as any).sender || (m as any).role || 'assistant',
    content: m.content,
    timestamp: Date.parse(m.timestamp) || Date.now(),
    thinking: (m as any).thinking,
    isThinking: (m as any).isThinking,
    tools: (m as any).tools || (m as any).tool_calls,
    timeline: (m as any).timeline,
    toolProposal: (m as any).toolProposal,
  })),
  tokenUsage: dbThread.token_usage ? {
    promptTokens: dbThread.token_usage.promptTokens,
    completionTokens: dbThread.token_usage.completionTokens,
    totalTokens: dbThread.token_usage.totalTokens,
  } : undefined,
  contextUsage: dbThread.context_usage ? {
    usedTokens: dbThread.context_usage.usedTokens,
    contextWindow: dbThread.context_usage.contextWindow,
    percentage: dbThread.context_usage.percentage,
  } : undefined,
});

// Generate UUID
const generateUUID = (): string => {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
};

// Get thread file path
const getThreadFilePath = (threadId: string): string => {
  return `${getThreadsDir()}/${threadId}.json`;
};

// Get threads directory path
const getThreadsDir = (): string => {
  return '.aurora/threads';
};
const isDevMode = (): boolean => {
  if (typeof import.meta !== 'undefined' && (import.meta as any).env?.MODE) {
    return (import.meta as any).env.MODE === 'development';
  }
  return false;
};
const toDbMessage = (message: Message): DbMessage => ({
  id: message.id,
  role: (message as any).role || (message as any).sender || 'assistant',
  content: message.content,
  timestamp: new Date(message.timestamp).toISOString(),
  tool_calls: (message as any).tool_calls,
  thinking: message.thinking,
  isThinking: (message as any).isThinking,
  tools: (message as any).tools,
  timeline: (message as any).timeline,
  toolProposal: (message as any).toolProposal,
});
const toDbThread = (thread: Thread): DbThread => ({
  id: thread.id,
  title: thread.title,
  summary: null,
  messages: thread.messages.map(toDbMessage),
  token_usage: thread.tokenUsage ? {
    promptTokens: thread.tokenUsage.promptTokens,
    completionTokens: thread.tokenUsage.completionTokens,
    totalTokens: thread.tokenUsage.totalTokens,
  } : null,
  context_usage: thread.contextUsage ? {
    usedTokens: thread.contextUsage.usedTokens,
    contextWindow: thread.contextUsage.contextWindow,
    percentage: thread.contextUsage.percentage,
  } : null,
  created_at: new Date(thread.createdAt).toISOString(),
  updated_at: new Date(thread.updatedAt).toISOString(),
});

export const getStreamingState = () => isCurrentlyStreaming;
export const setStreamingState = (streaming: boolean) => {
  const wasStreaming = isCurrentlyStreaming;
  isCurrentlyStreaming = streaming;
  
  // When streaming ends, save the thread ONCE
  if (wasStreaming && !streaming) {
    useThreadStore.getState().saveCurrentThread();
  }
};

// Helper to get current thread messages
export const useCurrentMessages = () => {
  const thread = useCurrentThread();
  return thread?.messages || [];
};

// Helper to get current thread messages
export const useCurrentThread = () => {
  const { currentThreadId, threads } = useThreadStore();
  if (!currentThreadId) return null;
  return threads[currentThreadId] || null;
};

// Track streaming state - NO saves during streaming
let isCurrentlyStreaming = false;

// ============================================
// CLEANUP OLD LOCALSTORAGE DATA
// ============================================
// Threads are now stored in SQLite, not localStorage
// Clear old localStorage data to free up space
try {
  const oldData = localStorage.getItem('aurora-threads');
  if (oldData) {
    const parsed = JSON.parse(oldData);
    // If old data has threads/threadList, it's the old format - clear it
    if (parsed.state?.threads || parsed.state?.threadList) {
      // Keep only currentThreadId
      const currentThreadId = parsed.state?.currentThreadId || null;
      localStorage.setItem('aurora-threads', JSON.stringify({
        state: { currentThreadId },
        version: parsed.version || 0,
      }));
      console.log('[ThreadStore] Cleaned up old localStorage data - threads now stored in database');
    }
  }
} catch (e) {
  // If localStorage is corrupted, just clear it
  try {
    localStorage.removeItem('aurora-threads');
    console.log('[ThreadStore] Cleared corrupted localStorage data');
  } catch {
    // Ignore - localStorage might be completely full
  }
}

// ============================================
// THREAD STORE
// ============================================
export const useThreadStore = create<ThreadState>()(
  persist(
    (set, get) => ({
      currentThreadId: null,
      threads: {},
      threadList: [],
      isLoading: false,

      createThread: () => {
        const threadId = generateUUID();
        const now = Date.now();

        const newThread: Thread = {
          id: threadId,
          title: 'New Chat',
          createdAt: now,
          updatedAt: now,
          messages: [],
        };

        set((state) => ({
          currentThreadId: threadId,
          threads: {
            ...state.threads,
            [threadId]: newThread,
          },
          threadList: [
            {
              id: threadId,
              title: 'New Chat',
              createdAt: now,
              updatedAt: now,
              messageCount: 0,
              preview: '',
            },
            ...state.threadList,
          ],
        }));

        // Save to Rust immediately so it exists in DB
        // This is fire-and-forget but ensures thread exists for API history
        if (isTauri()) {
          threadService.saveThread({
            id: threadId,
            title: 'New Chat',
            summary: null,
            messages: [],
            token_usage: null,
            context_usage: null,
            created_at: new Date(now).toISOString(),
            updated_at: new Date(now).toISOString(),
          }).catch(err => console.error('[ThreadStore] Failed to save new thread to Rust:', err));
        }

        return threadId;
      },

      loadThread: async (threadId) => {
        const existingThread = get().threads[threadId];
        if (existingThread) {
          set({ currentThreadId: threadId });
          // CRITICAL: Restore context usage from thread when switching
          // This prevents the context indicator from resetting to 0
          useContextStore.getState().restoreFromThread(existingThread.contextUsage);
          console.log(`[ThreadStore] Loaded thread ${threadId} from memory (${existingThread.messages.length} messages)`);
          return existingThread;
        } else {
          // Must wait for file load to complete before returning
          const loadedThread = await get().loadThreadFromFile(threadId);
          if (loadedThread) {
            set((state) => ({
              currentThreadId: threadId,
              threads: {
                ...state.threads,
                [threadId]: loadedThread,
              },
            }));
            // CRITICAL: Restore context usage from thread when switching
            // This prevents the context indicator from resetting to 0
            useContextStore.getState().restoreFromThread(loadedThread.contextUsage);
            console.log(`[ThreadStore] Loaded thread ${threadId} from file (${loadedThread.messages.length} messages)`);
            return loadedThread;
          }
          console.warn(`[ThreadStore] Failed to load thread ${threadId}`);
          return null;
        }
      },

      deleteThread: async (threadId) => {
        // Use Rust thread service
        if (isTauri()) {
          try {
            await threadService.deleteThread(threadId);
          } catch (error) {
            console.error('Failed to delete thread via Rust:', error);
          }
        }

        // Also delete file in dev mode
        if (isDevMode()) {
          try {
            const filePath = getThreadFilePath(threadId);
            await deletePath(filePath);
          } catch (error) {
            console.error('Failed to delete thread file (dev):', error);
          }
        }

        set((state) => {
          const { [threadId]: _, ...remainingThreads } = state.threads;
          return {
            threads: remainingThreads,
            threadList: state.threadList.filter((t) => t.id !== threadId),
            currentThreadId: state.currentThreadId === threadId ? null : state.currentThreadId,
          };
        });
      },

      deleteThreadFile: async (_threadId) => {
        // Legacy - now handled by deleteThread
        return true;
      },

      updateThreadTitle: (threadId, title) => {
        set((state) => {
          const thread = state.threads[threadId];
          if (!thread) return state;

          return {
            threads: {
              ...state.threads,
              [threadId]: { ...thread, title, updatedAt: Date.now() },
            },
            threadList: state.threadList.map((t) =>
              t.id === threadId ? { ...t, title, updatedAt: Date.now() } : t
            ),
          };
        });
      },

      addMessageToThread: (message) => {
        const { currentThreadId, threads } = get();
        if (!currentThreadId) return;

        const thread = threads[currentThreadId];
        if (!thread) return;

        const updatedThread: Thread = {
          ...thread,
          messages: [...thread.messages, message],
          updatedAt: Date.now(),
        };

        if (message.sender === 'user' && thread.messages.length === 0) {
          updatedThread.title = message.content.slice(0, 50) + (message.content.length > 50 ? '...' : '');
        }

        set((state) => ({
          threads: {
            ...state.threads,
            [currentThreadId]: updatedThread,
          },
          threadList: state.threadList.map((t) =>
            t.id === currentThreadId
              ? {
                ...t,
                title: updatedThread.title,
                updatedAt: updatedThread.updatedAt,
                messageCount: updatedThread.messages.length,
                preview: message.content.slice(0, 100),
              }
              : t
          ),
        }));

        // Save when user sends message - force save even during streaming setup
        if (message.sender === 'user') {
          get().saveCurrentThread(true);
        }
      },

      updateMessageInThread: (messageId, updates) => {
        const { currentThreadId, threads } = get();
        if (!currentThreadId) return;

        const thread = threads[currentThreadId];
        if (!thread) return;

        const updatedMessages = thread.messages.map((msg) =>
          msg.id === messageId ? { ...msg, ...updates } : msg
        );

        set((state) => ({
          threads: {
            ...state.threads,
            [currentThreadId]: {
              ...thread,
              messages: updatedMessages,
              updatedAt: Date.now(),
            },
          },
        }));

        // NO save during streaming - save happens when streaming ends via setStreamingState
      },

      removeMessagesAfter: (messageId, includeMessage = false) => {
        const { currentThreadId, threads } = get();
        if (!currentThreadId) return;

        const thread = threads[currentThreadId];
        if (!thread) return;

        // Find the index of the message
        const messageIndex = thread.messages.findIndex(msg => msg.id === messageId);
        if (messageIndex === -1) return;

        // If includeMessage is true, remove this message too (for checkpoint restore)
        // Otherwise keep messages up to and including this message
        const updatedMessages = includeMessage
          ? thread.messages.slice(0, messageIndex)
          : thread.messages.slice(0, messageIndex + 1);

        const updatedThread: Thread = {
          ...thread,
          messages: updatedMessages,
          updatedAt: Date.now(),
        };

        set((state) => ({
          threads: {
            ...state.threads,
            [currentThreadId]: updatedThread,
          },
          threadList: state.threadList.map((t) =>
            t.id === currentThreadId
              ? {
                ...t,
                updatedAt: updatedThread.updatedAt,
                messageCount: updatedMessages.length,
              }
              : t
          ),
        }));

        // Save immediately after removing messages
        get().saveCurrentThread(true);
      },

      updateThreadUsage: (tokenUsage, contextUsage) => {
        const { currentThreadId, threads } = get();
        if (!currentThreadId) return;

        const thread = threads[currentThreadId];
        if (!thread) return;

        set((state) => ({
          threads: {
            ...state.threads,
            [currentThreadId]: {
              ...thread,
              tokenUsage,
              contextUsage,
              updatedAt: Date.now(),
            },
          },
        }));

        // NO save here - save happens when streaming ends
      },

      saveCurrentThread: async (force = false) => {
        // Skip if currently streaming (unless forced)
        // Force is used for saving user messages immediately before streaming starts
        if (isCurrentlyStreaming && !force) {
          return;
        }
        
        const { currentThreadId, threads } = get();
        if (!currentThreadId) return;

        const thread = threads[currentThreadId];
        if (!thread) return;

        if (!isTauri()) {
          return;
        }

        try {
          // Use Rust thread service for persistence
          await threadService.saveThread(toDbThread(thread));
          console.log(`[ThreadStore] Saved thread ${currentThreadId} (${thread.messages.length} messages)`);
          
          if (isDevMode()) {
            const filePath = getThreadFilePath(currentThreadId);
            const content = JSON.stringify(thread, null, 2);
            await writeFileContent(filePath, content);
          }
        } catch (error) {
          console.error('Failed to save thread:', error);
        }
      },

      loadThreadFromFile: async (threadId) => {
        if (!isTauri()) {
          return null;
        }

        try {
          // Use Rust thread service
          const dbThread = await threadService.getThread(threadId);
          if (dbThread) {
            return fromDbThread(dbThread);
          }
        } catch (error) {
          console.error('Failed to load thread from Rust service:', error);
        }

        if (isDevMode()) {
          try {
            const filePath = getThreadFilePath(threadId);
            const content = await readFileContent(filePath);
            const thread: Thread = JSON.parse(content);
            return thread;
          } catch (error) {
            console.error('Failed to load thread from file:', error);
          }
        }

        return null;
      },

      loadAllThreadsFromFiles: async () => {
        if (!isTauri()) {
          return;
        }

        set({ isLoading: true });

        try {
          const loadedThreads: Record<string, Thread> = {};
          const loadedThreadList: ThreadSummary[] = [];

          // Use Rust thread service to list all threads
          const dbThreads = await threadService.listFullThreads();
          for (const dbThread of dbThreads) {
            const thread = fromDbThread(dbThread);
            loadedThreads[thread.id] = thread;
            const lastMessage = thread.messages[thread.messages.length - 1];
            loadedThreadList.push({
              id: thread.id,
              title: thread.title,
              createdAt: thread.createdAt,
              updatedAt: thread.updatedAt,
              messageCount: thread.messages.length,
              preview: lastMessage?.content?.slice(0, 100) || '',
            });
          }

          if (isDevMode()) {
            const threadsDir = getThreadsDir();
            try {
              const entries = await readDirectory(threadsDir);
              for (const entry of entries) {
                if (!entry.is_dir && entry.name.endsWith('.json')) {
                  try {
                    const content = await readFileContent(entry.path);
                    const thread: Thread = JSON.parse(content);
                    if (!loadedThreads[thread.id]) {
                      loadedThreads[thread.id] = thread;
                      const lastMessage = thread.messages[thread.messages.length - 1];
                      loadedThreadList.push({
                        id: thread.id,
                        title: thread.title,
                        createdAt: thread.createdAt,
                        updatedAt: thread.updatedAt,
                        messageCount: thread.messages.length,
                        preview: lastMessage?.content?.slice(0, 100) || '',
                      });
                    }
                  } catch (err) {
                    console.error('Failed to load thread file:', entry.path, err);
                  }
                }
              }
            } catch {
              // Directory may not exist yet
            }
          }

          loadedThreadList.sort((a, b) => b.updatedAt - a.updatedAt);

          set((state) => ({
            threads: { ...state.threads, ...loadedThreads },
            threadList: loadedThreadList,
            isLoading: false,
          }));
        } catch (error) {
          console.error('Failed to load threads:', error);
          set({ isLoading: false });
        }
      },

      getThreadList: () => {
        return get().threadList;
      },

      clearCurrentThread: () => {
        set({ currentThreadId: null });
      },
    }),
    {
      name: 'aurora-threads',
      // Only persist currentThreadId - threads are stored in SQLite database
      // This prevents localStorage quota exceeded errors
      partialize: (state) => ({
        currentThreadId: state.currentThreadId,
      }),
      // On rehydration, verify the persisted currentThreadId is valid
      // If the thread doesn't exist in memory (which it won't on fresh load),
      // we need to either load it from DB or clear the ID
      onRehydrateStorage: () => (state) => {
        if (state?.currentThreadId) {
          console.log('[ThreadStore] Rehydrated with currentThreadId:', state.currentThreadId);
          // Thread won't exist in memory on fresh load - this is expected
          // ChatPanel will handle creating a new thread if needed
          // But we should clear stale IDs that don't exist in DB
          if (isTauri()) {
            threadService.getThread(state.currentThreadId).then(dbThread => {
              if (dbThread) {
                // Thread exists in DB - load it into memory
                const thread = fromDbThread(dbThread);
                useThreadStore.setState((s) => ({
                  threads: { ...s.threads, [thread.id]: thread },
                }));
                // CRITICAL: Restore context usage from thread on app startup
                // This ensures the context indicator shows correct usage after restart
                useContextStore.getState().restoreFromThread(thread.contextUsage);
                console.log('[ThreadStore] Loaded persisted thread from DB:', thread.id, 
                  thread.contextUsage ? `(context: ${thread.contextUsage.usedTokens} tokens)` : '(no context data)');
              } else {
                // Thread doesn't exist in DB - clear the stale ID
                console.log('[ThreadStore] Persisted thread not found in DB, clearing');
                useThreadStore.setState({ currentThreadId: null });
              }
            }).catch(err => {
              console.error('[ThreadStore] Failed to verify persisted thread:', err);
              // On error, clear to be safe
              useThreadStore.setState({ currentThreadId: null });
            });
          }
        }
      },
    }
  )
);
