import { create } from "zustand";

interface ContextState extends ContextUsage {
  reset: () => void;
  setContextWindow: (contextWindow: number, maxOutputTokens: number) => void;
  setEstimatedContext: (tokens: number) => void;

  // Actions
  updateUsage: (usage: TokenUsage) => void;
}

export interface ContextUsage {
  // Total completion tokens generated
  completionTokens: number;

  // Provider's context window limit
  contextWindow: number;

  // Whether we're approaching the limit (>80%)
  isNearLimit: boolean;

  // Whether we've exceeded the limit
  isOverLimit: boolean;

  // Current usage from last response
  lastUsage: TokenUsage | null;

  // Provider's max output tokens
  maxOutputTokens: number;

  // Calculated percentage used
  usagePercentage: number;

  // Total tokens used in context (from API's prompt_tokens)
  usedContextTokens: number;
}

/**
 * Context Usage Store
 * Tracks token usage against the provider's context window
 *
 * How it works:
 * - The API's prompt_tokens in each response represents the TOTAL context used
 *   (includes system prompt + all previous messages + current message)
 * - We track prompt_tokens as the "used" context
 * - completion_tokens are added to show total but don't count against context limit
 */
export interface TokenUsage {
  // Cache tokens (MiniMax/Anthropic)
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

  // Update with actual API usage - this REPLACES the estimate
  updateUsage: (usage: TokenUsage) => {
    const state = get();
    // Total context used = new prompt tokens + cached tokens
    // cacheReadTokens represents cached content that was reused
    // Without cache: promptTokens = total context
    // With cache: promptTokens (new) + cacheReadTokens (cached) = total context
    const usedContext = usage.promptTokens + (usage.cacheReadTokens || 0);
    const percentage = calculatePercentage(usedContext, state.contextWindow);

    set({
      lastUsage: usage,
      usedContextTokens: usedContext,
      completionTokens: state.completionTokens + usage.completionTokens,
      usagePercentage: percentage,
      isNearLimit: percentage >= 80,
      isOverLimit: percentage >= 100,
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

  // Set estimated context (before API responds)
  setEstimatedContext: (tokens: number) => {
    const state = get();
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
  }),
}));
