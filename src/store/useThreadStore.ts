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

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export interface ContextUsage {
  usedTokens: number;
  contextWindow: number;
  percentage: number;
}

export interface Thread {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: Message[];
  tokenUsage?: TokenUsage;
  contextUsage?: ContextUsage;
}

export interface ThreadSummary {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  preview: string;
}

interface ThreadState {
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

  // Message actions
  addMessageToThread: (message: Message) => void;
  updateMessageInThread: (messageId: string, updates: Partial<Message>) => void;

  // Token/Context usage tracking
  updateThreadUsage: (tokenUsage: TokenUsage, contextUsage: ContextUsage) => void;

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

// Track streaming state - NO saves during streaming
let isCurrentlyStreaming = false;

export const setStreamingState = (streaming: boolean) => {
  const wasStreaming = isCurrentlyStreaming;
  isCurrentlyStreaming = streaming;
  
  // When streaming ends, save the thread ONCE
  if (wasStreaming && !streaming) {
    useThreadStore.getState().saveCurrentThread();
  }
};

export const getStreamingState = () => isCurrentlyStreaming;

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
        await get().deleteThreadFile(threadId);

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
          return true;
        }

        try {
          await deleteThreadFromDb(threadId);
        } catch (error) {
          console.error('Failed to delete thread from DB:', error);
        }

        if (isDevMode()) {
          try {
            const filePath = getThreadFilePath(threadId);
            await deletePath(filePath);
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

        // Save when user sends message (not during streaming)
        if (message.sender === 'user') {
          get().saveCurrentThread();
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

      saveCurrentThread: async () => {
        // Skip if currently streaming
        if (isCurrentlyStreaming) {
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
          await saveThreadToDb(toDbThread(thread));
          
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
          const dbThread = await getThreadFromDb(threadId);
          if (dbThread) {
            return fromDbThread(dbThread);
          }
        } catch (error) {
          console.error('Failed to load thread from DB:', error);
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
