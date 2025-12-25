import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Message } from '../types';
import { isTauri, writeFileContent, readFileContent, deletePath, readDirectory } from '../lib/tauri';

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
        // First delete the file
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
          const filePath = getThreadFilePath(threadId);
          await deletePath(filePath);
          console.log('Thread file deleted:', filePath);
          return true;
        } catch (error) {
          console.error('Failed to delete thread file:', error);
          return false;
        }
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
          const filePath = getThreadFilePath(currentThreadId);
          const content = JSON.stringify(thread, null, 2);
          await writeFileContent(filePath, content);
          console.log('Thread saved to file:', filePath);
        } catch (error) {
          console.error('Failed to save thread:', error);
        }
      },

      loadThreadFromFile: async (threadId) => {
        if (!isTauri()) {
          return null;
        }

        try {
          const filePath = getThreadFilePath(threadId);
          const content = await readFileContent(filePath);
          const thread: Thread = JSON.parse(content);
          return thread;
        } catch (error) {
          console.error('Failed to load thread:', error);
          return null;
        }
      },

      loadAllThreadsFromFiles: async () => {
        if (!isTauri()) {
          console.log('Not in Tauri, using localStorage');
          return;
        }

        set({ isLoading: true });

        try {
          const threadsDir = getThreadsDir();
          const entries = await readDirectory(threadsDir);
          
          const loadedThreads: Record<string, Thread> = {};
          const loadedThreadList: ThreadSummary[] = [];

          for (const entry of entries) {
            if (!entry.is_dir && entry.name.endsWith('.json')) {
              try {
                const content = await readFileContent(entry.path);
                const thread: Thread = JSON.parse(content);
                
                loadedThreads[thread.id] = thread;
                
                // Get last message for preview
                const lastMessage = thread.messages[thread.messages.length - 1];
                
                loadedThreadList.push({
                  id: thread.id,
                  title: thread.title,
                  createdAt: thread.createdAt,
                  updatedAt: thread.updatedAt,
                  messageCount: thread.messages.length,
                  preview: lastMessage?.content?.slice(0, 100) || '',
                });
              } catch (err) {
                console.error('Failed to load thread file:', entry.path, err);
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

          console.log(`Loaded ${loadedThreadList.length} threads from files`);
        } catch (error) {
          console.error('Failed to load threads from files:', error);
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
