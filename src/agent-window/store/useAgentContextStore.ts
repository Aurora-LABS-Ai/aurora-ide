/**
 * Agent Window — live context-usage store (per thread).
 *
 * Holds the most recent API token usage for each thread, keyed by id, so the
 * header context ring reflects EXACTLY the chat you're viewing — even when other
 * threads are running turns in the background (parallel turns).
 *
 * Live usage is captured from the runtime's `onUsage` during a turn. When a
 * thread has no live entry yet (e.g. just re-opened in a fresh window), the ring
 * falls back to the thread's persisted `token_usage` (loaded from disk). All
 * derivation (used = prompt + cache-read, % of context window) happens in the
 * `ContextRing` view so this store stays a thin, authoritative cache.
 */

import { create } from "zustand";

import type { TokenUsage } from "../../services";

interface AgentContextState {
  /** Latest API usage per thread id. */
  byThread: Record<string, TokenUsage>;
  /** Record usage for a thread (called from the send pipeline's `onUsage`). */
  setUsage: (threadId: string, usage: TokenUsage) => void;
  /** Drop a thread's cached usage (e.g. on delete). */
  clear: (threadId: string) => void;
}

export const useAgentContextStore = create<AgentContextState>((set) => ({
  byThread: {},

  setUsage: (threadId, usage) =>
    set((s) => ({ byThread: { ...s.byThread, [threadId]: usage } })),

  clear: (threadId) =>
    set((s) => {
      if (!(threadId in s.byThread)) return s;
      const byThread = { ...s.byThread };
      delete byThread[threadId];
      return { byThread };
    }),
}));
