import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import type { Message } from "../types";
import { buildContextTurnsFromMessages } from "../services/context-rehydration";

// Rust Context Engine state
interface RustContextState {
  threadId: string;
  totalTurns: number;
  summarizedTurns: number;
  usedTokens: number;
  contextWindow: number;
  maxOutput: number;
  usagePercentage: number;
  needsSummarization: boolean;
  recentTurnsCount: number;
}

interface ContextState extends ContextUsage {
  // Sync with Rust Context Engine
  initFromThread: (threadId: string, messages: Message[]) => Promise<void>;
  syncFromRust: (threadId: string) => Promise<void>;
  estimateFromRust: (threadId: string, systemPrompt: string) => Promise<void>;
  
  // Legacy methods (still used for API callback updates)
  reset: () => void;
  setContextWindow: (contextWindow: number, maxOutputTokens: number) => void;
  setEstimatedContext: (tokens: number) => void;
  updateUsage: (usage: TokenUsage) => void;
  restoreFromThread: (contextUsage: { usedTokens: number; contextWindow: number; percentage: number } | undefined) => void;
}

export interface ContextUsage {
  // Total completion tokens generated
  completionTokens: number;

  // Provider's context window limit
  contextWindow: number;

  // Whether the current usage is from real API data (vs estimate)
  hasRealUsage: boolean;

  // Whether we're approaching the limit (>80%)
  isNearLimit: boolean;

  // Whether we've exceeded the limit
  isOverLimit: boolean;

  // Current usage from last response
  lastUsage: TokenUsage | null;

  // Provider's max output tokens
  maxOutputTokens: number;

  // Whether summarization is recommended (from Rust)
  needsSummarization: boolean;

  // Number of summarized turns (from Rust)
  summarizedTurns: number;

  // Total turns in conversation (from Rust)
  totalTurns: number;

  // Calculated percentage used
  usagePercentage: number;

  // Total tokens used in context
  usedContextTokens: number;
}

export interface TokenUsage {
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  completionTokens: number;
  promptTokens: number;
  totalTokens: number;
}

const calculatePercentage = (used: number, total: number): number => {
  if (total <= 0) return 0;
  return Math.min(100, Math.round((used / total) * 100));
};

const DEFAULT_CONTEXT_WINDOW = 128000;
const DEFAULT_MAX_OUTPUT = 8192;

export const useContextStore = create<ContextState>((set, get) => ({
  // Initial state
  lastUsage: null,
  usedContextTokens: 0,
  completionTokens: 0,
  contextWindow: DEFAULT_CONTEXT_WINDOW,
  maxOutputTokens: DEFAULT_MAX_OUTPUT,
  usagePercentage: 0,
  isNearLimit: false,
  isOverLimit: false,
  hasRealUsage: false,
  totalTurns: 0,
  summarizedTurns: 0,
  needsSummarization: false,

  initFromThread: async (threadId: string, messages: Message[]) => {
    try {
      const state = get();
      const turns = buildContextTurnsFromMessages(threadId, messages);
      const rustState = await invoke<RustContextState>("context_init_from_thread", {
        threadId,
        turns,
        contextWindow: state.contextWindow,
        maxOutput: state.maxOutputTokens,
      });

      set({
        usedContextTokens: rustState.usedTokens,
        usagePercentage: Math.round(rustState.usagePercentage),
        isNearLimit: rustState.usagePercentage >= 80,
        isOverLimit: rustState.usagePercentage >= 100,
        hasRealUsage: false,
        totalTurns: rustState.totalTurns,
        summarizedTurns: rustState.summarizedTurns,
        needsSummarization: rustState.needsSummarization,
      });

      console.log("[ContextStore] Rehydrated Rust context from thread:", {
        threadId,
        turnCount: turns.length,
        totalTurns: rustState.totalTurns,
      });
    } catch (err) {
      console.error("[ContextStore] Failed to initialize from thread:", err);
    }
  },

  // Sync turn counts and summarization status from Rust (NOT token usage - API provides that)
  syncFromRust: async (threadId: string) => {
    try {
      const state = get();
      const rustState = await invoke<RustContextState>('context_get_state', {
        threadId,
        contextWindow: state.contextWindow,
        maxOutput: state.maxOutputTokens,
      });

      // Only update turn counts and summarization status
      // Token usage comes from API via updateUsage() which is more accurate
      set({
        totalTurns: rustState.totalTurns,
        summarizedTurns: rustState.summarizedTurns,
        needsSummarization: rustState.needsSummarization,
      });

      console.log('[ContextStore] Synced turn counts from Rust:', {
        totalTurns: rustState.totalTurns,
        summarizedTurns: rustState.summarizedTurns,
        needsSummarization: rustState.needsSummarization,
      });
    } catch (err) {
      console.error('[ContextStore] Failed to sync from Rust:', err);
    }
  },

  // Estimate tokens for next request (includes system prompt)
  estimateFromRust: async (threadId: string, systemPrompt: string) => {
    try {
      const state = get();
      const rustState = await invoke<RustContextState>('context_estimate_request_tokens', {
        threadId,
        systemPrompt,
        contextWindow: state.contextWindow,
        maxOutput: state.maxOutputTokens,
      });

      set({
        usedContextTokens: rustState.usedTokens,
        usagePercentage: Math.round(rustState.usagePercentage),
        isNearLimit: rustState.usagePercentage >= 80,
        isOverLimit: rustState.usagePercentage >= 100,
        totalTurns: rustState.totalTurns,
        summarizedTurns: rustState.summarizedTurns,
        needsSummarization: rustState.needsSummarization,
        hasRealUsage: false, // This is an estimate, not real API usage
      });

      console.log('[ContextStore] Estimated tokens from Rust:', {
        usedTokens: rustState.usedTokens,
        usagePercentage: rustState.usagePercentage,
        totalTurns: rustState.totalTurns,
      });
    } catch (err) {
      console.error('[ContextStore] Failed to estimate from Rust:', err);
    }
  },

  // Update with actual API usage
  updateUsage: (usage: TokenUsage) => {
    const state = get();
    const usedContext = usage.promptTokens + (usage.cacheReadTokens || 0);
    const percentage = calculatePercentage(usedContext, state.contextWindow);

    set({
      lastUsage: usage,
      usedContextTokens: usedContext,
      completionTokens: state.completionTokens + usage.completionTokens,
      usagePercentage: percentage,
      isNearLimit: percentage >= 80,
      isOverLimit: percentage >= 100,
      hasRealUsage: true,
    });
  },

  setContextWindow: (contextWindow: number, maxOutputTokens: number) => {
    const state = get();
    const percentage = calculatePercentage(state.usedContextTokens, contextWindow);

    set({
      contextWindow,
      maxOutputTokens,
      usagePercentage: percentage,
      isNearLimit: percentage >= 80,
      isOverLimit: percentage >= 100,
    });
  },

  setEstimatedContext: (tokens: number) => {
    const state = get();
    
    if (state.hasRealUsage && tokens < state.usedContextTokens) {
      return;
    }
    
    const percentage = calculatePercentage(tokens, state.contextWindow);

    set({
      usedContextTokens: tokens,
      usagePercentage: percentage,
      isNearLimit: percentage >= 80,
      isOverLimit: percentage >= 100,
    });
  },

  reset: () => set({
    lastUsage: null,
    usedContextTokens: 0,
    completionTokens: 0,
    usagePercentage: 0,
    isNearLimit: false,
    isOverLimit: false,
    hasRealUsage: false,
    totalTurns: 0,
    summarizedTurns: 0,
    needsSummarization: false,
  }),

  restoreFromThread: (contextUsage) => {
    if (!contextUsage) {
      set({
        usedContextTokens: 0,
        usagePercentage: 0,
        isNearLimit: false,
        isOverLimit: false,
        hasRealUsage: false,
        totalTurns: 0,
        summarizedTurns: 0,
        needsSummarization: false,
      });
      return;
    }

    const { usedTokens, contextWindow, percentage } = contextUsage;
    
    set({
      usedContextTokens: usedTokens,
      contextWindow: contextWindow || DEFAULT_CONTEXT_WINDOW,
      usagePercentage: percentage,
      isNearLimit: percentage >= 80,
      isOverLimit: percentage >= 100,
      hasRealUsage: true,
    });
  },
}));
