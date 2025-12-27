import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Message } from '../types';
import {
  isTauri,
  writeFileContent,
  readFileContent,
  deletePath,
  readDirectory,
  saveThreadToDb,
  getThreadFromDb,
  listThreadsFromDb,
  deleteThreadFromDb,
  type DbThread,
  type DbMessage,
} from '../lib/tauri';

// ============================================
// THREAD TYPES
// ============================================

export interface Thread {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: Message[];
}

export interface ThreadSummary {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  preview: string; // First few chars of last message
}

interface ThreadState {
  // Current thread
  currentThreadId: string | null;
  threads: Record<string, Thread>;
  threadList: ThreadSummary[];
  isLoading: boolean;
  
  // Actions
  createThread: () => string;
  loadThread: (threadId: string) => void;
  deleteThread: (threadId: string) => Promise<void>;
  deleteThreadFile: (threadId: string) => Promise<boolean>;
  updateThreadTitle: (threadId: string, title: string) => void;
  
  // Message actions (synced with thread)
  addMessageToThread: (message: Message) => void;
  updateMessageInThread: (messageId: string, updates: Partial<Message>) => void;
  
  // Persistence
  saveCurrentThread: () => Promise<void>;
  loadThreadFromFile: (threadId: string) => Promise<Thread | null>;
  loadAllThreadsFromFiles: () => Promise<void>;
  
  // History
  getThreadList: () => ThreadSummary[];
  clearCurrentThread: () => void;
}

// Generate UUID
const generateUUID = (): string => {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
};

// Get threads directory path
const getThreadsDir = (): string => {
  return '.aurora/threads';
};

// Get thread file path
const getThreadFilePath = (threadId: string): string => {
  return `${getThreadsDir()}/${threadId}.json`;
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
  created_at: new Date(thread.createdAt).toISOString(),
  updated_at: new Date(thread.updatedAt).toISOString(),
});

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
});

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

        return threadId;
      },

      loadThread: (threadId) => {
        const thread = get().threads[threadId];
        if (thread) {
          set({ currentThreadId: threadId });
        } else {
          // Try to load from file
          get().loadThreadFromFile(threadId).then((loadedThread) => {
            if (loadedThread) {
              set((state) => ({
                currentThreadId: threadId,
                threads: {
                  ...state.threads,
                  [threadId]: loadedThread,
                },
              }));
            }
          });
        }
      },

      deleteThread: async (threadId) => {
        // First delete persistence (db + optional dev JSON)
        await get().deleteThreadFile(threadId);
        
        // Then remove from state
        set((state) => {
          const { [threadId]: _, ...remainingThreads } = state.threads;
          return {
            threads: remainingThreads,
            threadList: state.threadList.filter((t) => t.id !== threadId),
            currentThreadId: state.currentThreadId === threadId ? null : state.currentThreadId,
          };
        });
      },

      deleteThreadFile: async (threadId) => {
        if (!isTauri()) {
          console.log('Thread deleted from localStorage:', threadId);
          return true;
        }

        try {
          await deleteThreadFromDb(threadId);
        } catch (error) {
          console.error('Failed to delete thread from DB:', error);
          // continue to attempt JSON deletion
        }

        if (isDevMode()) {
          try {
            const filePath = getThreadFilePath(threadId);
            await deletePath(filePath);
            console.log('Thread file deleted (dev):', filePath);
          } catch (error) {
            console.error('Failed to delete thread file (dev):', error);
          }
        }

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

        // Update title from first user message
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

        // Auto-save
        get().saveCurrentThread();
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

        // Auto-save (debounced would be better but keeping simple)
        get().saveCurrentThread();
      },

      saveCurrentThread: async () => {
        const { currentThreadId, threads } = get();
        if (!currentThreadId) return;

        const thread = threads[currentThreadId];
        if (!thread) return;

        if (!isTauri()) {
          // In web mode, just use localStorage (handled by persist middleware)
          console.log('Thread saved to localStorage:', currentThreadId);
          return;
        }

        try {
          await saveThreadToDb(toDbThread(thread));
          if (isDevMode()) {
            const filePath = getThreadFilePath(currentThreadId);
            const content = JSON.stringify(thread, null, 2);
            await writeFileContent(filePath, content);
            console.log('Thread saved to file (dev):', filePath);
          }
        } catch (error) {
          console.error('Failed to save thread:', error);
        }
      },

      loadThreadFromFile: async (threadId) => {
        if (!isTauri()) {
          return null;
        }

        // Try DB first
        try {
          const dbThread = await getThreadFromDb(threadId);
          if (dbThread) {
            return fromDbThread(dbThread);
          }
        } catch (error) {
          console.error('Failed to load thread from DB:', error);
        }

        // Dev fallback: JSON file
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
          console.log('Not in Tauri, using localStorage');
          return;
        }

        set({ isLoading: true });

        try {
          const loadedThreads: Record<string, Thread> = {};
          const loadedThreadList: ThreadSummary[] = [];

          // Primary: DB
          const dbThreads = await listThreadsFromDb();
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

          // Optional dev merge from JSON files (keep if not already present)
          if (isDevMode()) {
            const threadsDir = getThreadsDir();
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
          }

          // Sort by updatedAt (newest first)
          loadedThreadList.sort((a, b) => b.updatedAt - a.updatedAt);

          // Merge with existing state (keep any threads not on disk)
          set((state) => ({
            threads: { ...state.threads, ...loadedThreads },
            threadList: loadedThreadList,
            isLoading: false,
          }));

          console.log(`Loaded ${loadedThreadList.length} threads (db${isDevMode() ? '+dev files' : ''})`);
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
      partialize: (state) => ({
        threads: state.threads,
        threadList: state.threadList,
        currentThreadId: state.currentThreadId,
      }),
    }
  )
);

// Helper to get current thread messages
export const useCurrentThread = () => {
  const { currentThreadId, threads } = useThreadStore();
  if (!currentThreadId) return null;
  return threads[currentThreadId] || null;
};

// Helper to get current thread messages
export const useCurrentMessages = () => {
  const thread = useCurrentThread();
  return thread?.messages || [];
};
