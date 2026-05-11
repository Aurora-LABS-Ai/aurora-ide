import { create } from "zustand";
import { persist } from "zustand/middleware";

import {
  deletePath,
  isTauri,
  readDirectory,
  readFileContent,
  writeFileContent,
} from "../lib/tauri";
import { deriveThreadTitle } from "../lib/thread-title";
import {
  threadService,
  type DbMessage,
  type DbThread,
  type ThreadSummary as ServiceThreadSummary,
} from "../services/thread-service";
import type { Message } from "../types";
import { useContextStore } from "./useContextStore";

type PersistedMessageShape = {
  isThinking?: boolean;
  role?: string;
  sender?: Message["sender"] | string;
  thinking?: string;
  timeline?: Message["timeline"];
  tool_calls?: Message["tools"];
  toolProposal?: Message["toolProposal"];
  tools?: Message["tools"];
};

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
  updateThreadUsage: (
    tokenUsage: TokenUsage,
    contextUsage: ContextUsage,
  ) => void;
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
  messages: (dbThread.messages || []).map((m: DbMessage) => {
    const persisted = m as unknown as PersistedMessageShape;
    const sender =
      persisted.sender === "user" || persisted.role === "user"
        ? "user"
        : "assistant";

    return {
      id: m.id,
      sender,
      content: m.content,
      timestamp: Date.parse(m.timestamp) || Date.now(),
      thinking: persisted.thinking,
      isThinking: persisted.isThinking,
      tools: persisted.tools || persisted.tool_calls,
      timeline: persisted.timeline,
      toolProposal: persisted.toolProposal,
    };
  }),
  tokenUsage: dbThread.token_usage
    ? {
        promptTokens: dbThread.token_usage.promptTokens,
        completionTokens: dbThread.token_usage.completionTokens,
        totalTokens: dbThread.token_usage.totalTokens,
      }
    : undefined,
  contextUsage: dbThread.context_usage
    ? {
        usedTokens: dbThread.context_usage.usedTokens,
        contextWindow: dbThread.context_usage.contextWindow,
        percentage: dbThread.context_usage.percentage,
      }
    : undefined,
});

export const fromServiceThreadSummary = (
  summary: ServiceThreadSummary,
): ThreadSummary => ({
  id: summary.id,
  title: summary.title,
  createdAt: Date.parse(summary.createdAt) || Date.now(),
  updatedAt: Date.parse(summary.updatedAt) || Date.now(),
  messageCount: summary.messageCount,
  preview: summary.preview,
});

// Generate UUID
const generateUUID = (): string => {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
};

// Get thread file path
const getThreadFilePath = (threadId: string): string => {
  return `${getThreadsDir()}/${threadId}.json`;
};

// Get threads directory path
const getThreadsDir = (): string => {
  return ".aurora/threads";
};
const isDevMode = (): boolean => {
  const env =
    typeof import.meta !== "undefined"
      ? (import.meta as ImportMeta & { env?: { MODE?: string } }).env
      : undefined;

  return env?.MODE === "development";
};

const rehydrateActiveThreadContext = async (
  threadId: string,
  thread: Thread,
): Promise<void> => {
  const contextStore = useContextStore.getState();
  await contextStore.initFromThread(threadId, thread.messages);
  contextStore.restoreFromThread(thread.contextUsage);
};

/**
 * DevPersistenceManager - Centralized file-based persistence for development
 *
 * This consolidates all dev-mode file operations into a single controlled mechanism.
 * All file-based persistence goes through this manager to avoid dual persistence issues.
 */
class DevPersistenceManager {
  private enabled: boolean;

  constructor() {
    // File persistence only enabled in dev mode
    this.enabled = isDevMode();
  }

  /**
   * Check if file-based persistence is enabled
   */
  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Enable/disable file persistence at runtime (for testing/debugging)
   */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  /**
   * Save thread to file (dev mode only)
   */
  async saveThread(thread: Thread): Promise<void> {
    if (!this.enabled) return;

    try {
      const filePath = getThreadFilePath(thread.id);
      const content = JSON.stringify(thread, null, 2);
      await writeFileContent(filePath, content);
      console.log(`[DevPersistence] Saved thread ${thread.id} to file`);
    } catch (error) {
      console.error("[DevPersistence] Failed to save thread to file:", error);
    }
  }

  /**
   * Load thread from file (dev mode only, fallback)
   */
  async loadThread(threadId: string): Promise<Thread | null> {
    if (!this.enabled) return null;

    try {
      const filePath = getThreadFilePath(threadId);
      const content = await readFileContent(filePath);
      const thread: Thread = JSON.parse(content);
      return thread;
    } catch (error) {
      console.error("[DevPersistence] Failed to load thread from file:", error);
      return null;
    }
  }

  /**
   * Delete thread file (dev mode only)
   */
  async deleteThread(threadId: string): Promise<void> {
    if (!this.enabled) return;

    try {
      const filePath = getThreadFilePath(threadId);
      await deletePath(filePath);
      console.log(`[DevPersistence] Deleted thread file ${threadId}`);
    } catch (error) {
      console.error("[DevPersistence] Failed to delete thread file:", error);
    }
  }

  /**
   * Load all threads from files (dev mode only, as supplementary source)
   * Returns threads not already found in the database
   */
  async loadAllThreads(
    existingThreadIds: Set<string>,
  ): Promise<{ threads: Thread[]; summaries: ThreadSummary[] }> {
    if (!this.enabled) {
      return { threads: [], summaries: [] };
    }

    const threads: Thread[] = [];
    const summaries: ThreadSummary[] = [];

    try {
      const threadsDir = getThreadsDir();
      const entries = await readDirectory(threadsDir);

      for (const entry of entries) {
        if (!entry.is_dir && entry.name.endsWith(".json")) {
          try {
            const content = await readFileContent(entry.path);
            const thread: Thread = JSON.parse(content);

            // Only add threads not already in database
            if (!existingThreadIds.has(thread.id)) {
              threads.push(thread);
              const lastMessage = thread.messages[thread.messages.length - 1];
              summaries.push({
                id: thread.id,
                title: thread.title,
                createdAt: thread.createdAt,
                updatedAt: thread.updatedAt,
                messageCount: thread.messages.length,
                preview: lastMessage?.content?.slice(0, 100) || "",
              });
            }
          } catch (err) {
            console.error(
              "[DevPersistence] Failed to load thread file:",
              entry.path,
              err,
            );
          }
        }
      }
    } catch {
      // Directory may not exist yet - that's okay
    }

    return { threads, summaries };
  }
}

// Singleton instance
const devPersistence = new DevPersistenceManager();
const toDbMessage = (message: Message): DbMessage => {
  const persisted = message as PersistedMessageShape;

  return {
    id: message.id,
    role: persisted.role || persisted.sender || "assistant",
    content: message.content,
    timestamp: new Date(message.timestamp).toISOString(),
    tool_calls: persisted.tool_calls as DbMessage["tool_calls"],
    thinking: message.thinking,
    isThinking: persisted.isThinking,
    tools: persisted.tools as DbMessage["tools"],
    timeline: persisted.timeline,
    toolProposal: persisted.toolProposal,
  };
};
const toDbThread = (thread: Thread): DbThread => ({
  id: thread.id,
  title: thread.title,
  summary: null,
  messages: thread.messages.map(toDbMessage),
  token_usage: thread.tokenUsage
    ? {
        promptTokens: thread.tokenUsage.promptTokens,
        completionTokens: thread.tokenUsage.completionTokens,
        totalTokens: thread.tokenUsage.totalTokens,
      }
    : null,
  context_usage: thread.contextUsage
    ? {
        usedTokens: thread.contextUsage.usedTokens,
        contextWindow: thread.contextUsage.contextWindow,
        percentage: thread.contextUsage.percentage,
      }
    : null,
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
  const oldData = localStorage.getItem("aurora-threads");
  if (oldData) {
    const parsed = JSON.parse(oldData);
    // If old data has threads/threadList, it's the old format - clear it
    if (parsed.state?.threads || parsed.state?.threadList) {
      // Keep only currentThreadId
      const currentThreadId = parsed.state?.currentThreadId || null;
      localStorage.setItem(
        "aurora-threads",
        JSON.stringify({
          state: { currentThreadId },
          version: parsed.version || 0,
        }),
      );
      console.log(
        "[ThreadStore] Cleaned up old localStorage data - threads now stored in database",
      );
    }
  }
} catch {
  // If localStorage is corrupted, just clear it
  try {
    localStorage.removeItem("aurora-threads");
    console.log("[ThreadStore] Cleared corrupted localStorage data");
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
          title: "New Chat",
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
              title: "New Chat",
              createdAt: now,
              updatedAt: now,
              messageCount: 0,
              preview: "",
            },
            ...state.threadList,
          ],
        }));

        // Save to Rust immediately so it exists in DB
        // This is fire-and-forget but ensures thread exists for API history
        if (isTauri()) {
          threadService
            .saveThread({
              id: threadId,
              title: "New Chat",
              summary: null,
              messages: [],
              token_usage: null,
              context_usage: null,
              created_at: new Date(now).toISOString(),
              updated_at: new Date(now).toISOString(),
            })
            .catch((err) =>
              console.error(
                "[ThreadStore] Failed to save new thread to Rust:",
                err,
              ),
            );

          // Pre-register the thread in the Rust context engine so the
          // first `syncFromRust(threadId)` call after the agent
          // completes succeeds instead of erroring with
          // "Context not found for thread". Empty `turns` is fine —
          // the engine just gets an initialized manager keyed on this
          // thread id; subsequent turns will fill it in.
          useContextStore
            .getState()
            .initFromThread(threadId, [])
            .catch((err) =>
              console.error(
                "[ThreadStore] Failed to pre-register context for new thread:",
                err,
              ),
            );
        }

        return threadId;
      },

      loadThread: async (threadId) => {
        const existingThread = get().threads[threadId];
        if (existingThread) {
          set({ currentThreadId: threadId });
          await rehydrateActiveThreadContext(threadId, existingThread);
          console.log(
            `[ThreadStore] Loaded thread ${threadId} from memory (${existingThread.messages.length} messages)`,
          );
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
            await rehydrateActiveThreadContext(threadId, loadedThread);
            console.log(
              `[ThreadStore] Loaded thread ${threadId} from file (${loadedThread.messages.length} messages)`,
            );
            return loadedThread;
          }
          console.warn(`[ThreadStore] Failed to load thread ${threadId}`);
          return null;
        }
      },

      deleteThread: async (threadId) => {
        // Use Rust thread service (primary persistence)
        if (isTauri()) {
          try {
            await threadService.deleteThread(threadId);
          } catch (error) {
            console.error("Failed to delete thread via Rust:", error);
          }
        }

        // Dev mode file cleanup (centralized through DevPersistenceManager)
        await devPersistence.deleteThread(threadId);

        set((state) => {
          const remainingThreads = Object.fromEntries(
            Object.entries(state.threads).filter(([id]) => id !== threadId),
          ) as Record<string, Thread>;

          return {
            threads: remainingThreads,
            threadList: state.threadList.filter((t) => t.id !== threadId),
            currentThreadId:
              state.currentThreadId === threadId ? null : state.currentThreadId,
          };
        });
      },

      deleteThreadFile: async (_threadId) => {
        // Legacy - now handled by deleteThread
        void _threadId;
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
              t.id === threadId ? { ...t, title, updatedAt: Date.now() } : t,
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

        if (message.sender === "user" && thread.messages.length === 0) {
          updatedThread.title = deriveThreadTitle(message.content);
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
              : t,
          ),
        }));

        // Save when user sends message - force save even during streaming setup
        if (message.sender === "user") {
          get().saveCurrentThread(true);
        }
      },

      updateMessageInThread: (messageId, updates) => {
        const { currentThreadId, threads } = get();
        if (!currentThreadId) return;

        const thread = threads[currentThreadId];
        if (!thread) return;

        const updatedMessages = thread.messages.map((msg) =>
          msg.id === messageId ? { ...msg, ...updates } : msg,
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
        const messageIndex = thread.messages.findIndex(
          (msg) => msg.id === messageId,
        );
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
              : t,
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
          console.log(
            `[ThreadStore] Saved thread ${currentThreadId} (${thread.messages.length} messages)`,
          );

          // File persistence in dev mode (centralized through DevPersistenceManager)
          await devPersistence.saveThread(thread);
        } catch (error) {
          console.error("Failed to save thread:", error);
        }
      },

      loadThreadFromFile: async (threadId) => {
        if (!isTauri()) {
          return null;
        }

        try {
          // Use Rust thread service
          const dbThread = await threadService.loadThread(threadId);
          if (dbThread) {
            return fromDbThread(dbThread);
          }
        } catch (error) {
          console.error("Failed to load thread from Rust service:", error);
        }

        // Dev mode fallback to files
        return await devPersistence.loadThread(threadId);
      },

      loadAllThreadsFromFiles: async () => {
        if (!isTauri()) {
          return;
        }

        set({ isLoading: true });

        try {
          const loadedThreadList = (await threadService.listThreads()).map(
            fromServiceThreadSummary,
          );

          // Dev mode: Load any threads from files not in database
          const existingIds = new Set(
            loadedThreadList.map((thread) => thread.id),
          );
          const { threads: fileThreads, summaries: fileSummaries } =
            await devPersistence.loadAllThreads(existingIds);

          const loadedThreads: Record<string, Thread> = {};
          for (const thread of fileThreads) {
            loadedThreads[thread.id] = thread;
          }

          const mergedThreadList = [...loadedThreadList, ...fileSummaries];
          mergedThreadList.sort((a, b) => b.updatedAt - a.updatedAt);

          set((state) => ({
            threads: { ...state.threads, ...loadedThreads },
            threadList: mergedThreadList,
            isLoading: false,
          }));
        } catch (error) {
          console.error("Failed to load threads:", error);
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
      name: "aurora-threads",
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
          console.log(
            "[ThreadStore] Rehydrated with currentThreadId:",
            state.currentThreadId,
          );
          // Thread won't exist in memory on fresh load - this is expected
          // ChatPanel will handle creating a new thread if needed
          // But we should clear stale IDs that don't exist in DB
          if (isTauri()) {
            threadService
              .loadThread(state.currentThreadId)
              .then((dbThread) => {
                if (dbThread) {
                  // Thread exists in DB - load it into memory
                  const thread = fromDbThread(dbThread);
                  useThreadStore.setState((s) => ({
                    threads: { ...s.threads, [thread.id]: thread },
                  }));
                  void rehydrateActiveThreadContext(thread.id, thread);
                  console.log(
                    "[ThreadStore] Loaded persisted thread from DB:",
                    thread.id,
                    thread.contextUsage
                      ? `(context: ${thread.contextUsage.usedTokens} tokens)`
                      : "(no context data)",
                  );
                } else {
                  // Thread doesn't exist in DB - clear the stale ID
                  console.log(
                    "[ThreadStore] Persisted thread not found in DB, clearing",
                  );
                  useThreadStore.setState({ currentThreadId: null });
                }
              })
              .catch((err) => {
                console.error(
                  "[ThreadStore] Failed to verify persisted thread:",
                  err,
                );
                // On error, clear to be safe
                useThreadStore.setState({ currentThreadId: null });
              });
          }
        }
      },
    },
  ),
);
