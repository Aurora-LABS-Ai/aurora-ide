/**
 * Context Manager - Enterprise-grade context window management
 * 
 * Based on KiloCode's approach:
 * - Summarization-based condensation
 * - Sliding window truncation as fallback
 * - Non-destructive message tagging
 * - Rewind capability
 * - 10% buffer zone
 */
import type { ApiMessage, IProvider } from "./types";

export interface CondenseResult {
  condenseId: string;
  cost: number;
  error?: string;
  messages: ApiMessage[];
  newContextTokens: number;
  prevContextTokens: number;
  summary: string;
}

export interface ContextManagementOptions {
  autoCondenseContext?: boolean;
  autoCondenseContextPercent?: number;
  contextWindow: number;
  customCondensingPrompt?: string;
  maxTokens?: number;
  messages: ApiMessage[];
  provider?: IProvider;
  systemPrompt?: string;
  totalTokens: number;
}

export interface ContextManagementResult {
  condenseId?: string;
  cost?: number;
  error?: string;
  messages: ApiMessage[];
  messagesRemoved?: number;
  newContextTokens?: number;
  prevContextTokens: number;
  summary?: string;
  truncationId?: string;
}

// ============================================================
// TYPES
// ============================================================
export interface ContextState {
  allowedTokens: number;
  contextWindow: number;
  isNearLimit: boolean;
  isOverLimit: boolean;
  maxOutputTokens: number;
  percentage: number;
  remainingTokens: number;
  usedTokens: number;
}

export interface TruncationResult {
  messages: ApiMessage[];
  messagesRemoved: number;
  truncationId: string;
}

// ============================================================
// SINGLETON CONTEXT MANAGER
// ============================================================
class ContextManagerService {
  private currentState: ContextState | null = null;

  /**
   * Get current context state
   */
  public getState(): ContextState | null {
    return this.currentState;
  }

  /**
   * Check if context management is needed
   */
  public needsManagement(threshold: number = 100): boolean {
    if (!this.currentState) return false;
    return (
      this.currentState.percentage >= threshold ||
      this.currentState.isOverLimit
    );
  }

  /**
   * Reset state
   */
  public reset(): void {
    this.currentState = null;
  }

  /**
   * Update context state
   */
  public updateState(
    usedTokens: number,
    contextWindow: number,
    maxOutputTokens: number
  ): ContextState {
    this.currentState = calculateContextState(usedTokens, contextWindow, maxOutputTokens);
    return this.currentState;
  }
}

// ============================================================
// HELPER FUNCTIONS
// ============================================================

/**
 * Generate UUID for condense/truncation IDs
 */
function generateUUID(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

/**
 * Calculate allowed tokens for context
 */
export function calculateAllowedTokens(
  contextWindow: number,
  maxOutputTokens: number = DEFAULT_MAX_OUTPUT_TOKENS
): number {
  return contextWindow * (1 - TOKEN_BUFFER_PERCENTAGE) - maxOutputTokens;
}

/**
 * Calculate context state
 */
export function calculateContextState(
  usedTokens: number,
  contextWindow: number,
  maxOutputTokens: number = DEFAULT_MAX_OUTPUT_TOKENS
): ContextState {
  const allowedTokens = calculateAllowedTokens(contextWindow, maxOutputTokens);
  const percentage = contextWindow > 0
    ? Math.round((usedTokens / contextWindow) * 100)
    : 0;

  return {
    usedTokens,
    contextWindow,
    maxOutputTokens,
    percentage,
    isNearLimit: percentage >= 80,
    isOverLimit: usedTokens > allowedTokens,
    allowedTokens,
    remainingTokens: Math.max(0, allowedTokens - usedTokens),
  };
}

// ============================================================
// REWIND OPERATIONS
// ============================================================

/**
 * Clean up orphaned messages after truncation/condensation is undone
 */
export function cleanupAfterRewind(messages: ApiMessage[]): ApiMessage[] {
  // Get IDs of existing summaries and markers
  const existingSummaryIds = new Set<string>();
  const existingTruncationIds = new Set<string>();

  for (const msg of messages) {
    if (msg.isSummary && msg.condenseId) {
      existingSummaryIds.add(msg.condenseId);
    }
    if (msg.isTruncationMarker && msg.truncationId) {
      existingTruncationIds.add(msg.truncationId);
    }
  }

  // Clear parent references that point to non-existent summaries/markers
  return messages.map((msg) => {
    const cleaned = { ...msg };

    if (msg.condenseParent && !existingSummaryIds.has(msg.condenseParent)) {
      delete cleaned.condenseParent;
    }
    if (msg.truncationParent && !existingTruncationIds.has(msg.truncationParent)) {
      delete cleaned.truncationParent;
    }

    return cleaned;
  });
}

/**
 * Force context reduction (75%) - used on context overflow errors
 */
export async function forceContextReduction(
  messages: ApiMessage[]
): Promise<TruncationResult> {
  return truncateConversation(messages, FORCED_REDUCTION_PERCENT / 100);
}

// ============================================================
// EFFECTIVE HISTORY FILTERING
// ============================================================

/**
 * Get effective API history (filter out condensed/truncated messages)
 * KiloCode-style non-destructive filtering
 */
export function getEffectiveApiHistory(messages: ApiMessage[]): ApiMessage[] {
  // Collect all condenseIds and truncationIds of existing summaries/markers
  const existingSummaryIds = new Set<string>();
  const existingTruncationIds = new Set<string>();

  for (const msg of messages) {
    if (msg.isSummary && msg.condenseId) {
      existingSummaryIds.add(msg.condenseId);
    }
    if (msg.isTruncationMarker && msg.truncationId) {
      existingTruncationIds.add(msg.truncationId);
    }
  }

  // Filter out messages whose parent points to an existing summary/marker
  return messages.filter((msg) => {
    if (msg.condenseParent && existingSummaryIds.has(msg.condenseParent)) {
      return false; // Hidden by summary
    }
    if (msg.truncationParent && existingTruncationIds.has(msg.truncationParent)) {
      return false; // Hidden by truncation
    }
    return true;
  });
}

/**
 * Get messages since the last summary
 */
export function getMessagesSinceLastSummary(messages: ApiMessage[]): ApiMessage[] {
  // Find the last summary index
  let lastSummaryIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].isSummary) {
      lastSummaryIndex = i;
      break;
    }
  }

  // If no summary, return all (but always include first message)
  if (lastSummaryIndex === -1) {
    return messages;
  }

  // Return first message + summary + messages after summary
  const result: ApiMessage[] = [];

  // Always include first message (task instructions)
  if (messages.length > 0) {
    result.push(messages[0]);
  }

  // Include summary and subsequent messages
  for (let i = lastSummaryIndex; i < messages.length; i++) {
    if (i !== 0) { // Don't duplicate first message
      result.push(messages[i]);
    }
  }

  return result;
}

// ============================================================
// CONTEXT MANAGEMENT (Main entry point)
// ============================================================

/**
 * Manage context - condense or truncate as needed
 */
export async function manageContext(
  options: ContextManagementOptions
): Promise<ContextManagementResult> {
  const {
    messages,
    totalTokens,
    contextWindow,
    maxTokens = DEFAULT_MAX_OUTPUT_TOKENS,
    // autoCondenseContext is reserved for future summarization feature
    autoCondenseContextPercent = 100,
  } = options;

  const allowedTokens = calculateAllowedTokens(contextWindow, maxTokens);
  const prevContextTokens = totalTokens;

  // Calculate effective threshold
  const contextPercent = (100 * prevContextTokens) / contextWindow;

  // Check if we need to condense/truncate
  const needsCondensation =
    contextPercent >= autoCondenseContextPercent || prevContextTokens > allowedTokens;

  if (!needsCondensation) {
    return {
      messages,
      prevContextTokens,
    };
  }

  // For now, use truncation (summarization would require LLM call)
  // In full implementation, try summarization first, then fallback to truncation
  if (prevContextTokens > allowedTokens) {
    const truncationResult = truncateConversation(messages, TRUNCATION_FRACTION);
    return {
      messages: truncationResult.messages,
      prevContextTokens,
      truncationId: truncationResult.truncationId,
      messagesRemoved: truncationResult.messagesRemoved,
    };
  }

  return {
    messages,
    prevContextTokens,
  };
}

/**
 * Rewind to a specific message index
 */
export function rewindToIndex(
  messages: ApiMessage[],
  index: number
): ApiMessage[] {
  // Keep messages up to index
  const filtered = messages.slice(0, index + 1);

  // Clean up orphaned references
  return cleanupAfterRewind(filtered);
}

/**
 * Rewind to a specific timestamp
 */
export function rewindToTimestamp(
  messages: ApiMessage[],
  timestamp: number
): ApiMessage[] {
  // Remove messages after timestamp
  const filtered = messages.filter((msg) => msg.ts <= timestamp);

  // Clean up orphaned references
  return cleanupAfterRewind(filtered);
}

// ============================================================
// SLIDING WINDOW TRUNCATION
// ============================================================

/**
 * Truncate conversation using sliding window
 * Removes 50% of visible messages (excluding first message)
 */
export function truncateConversation(
  messages: ApiMessage[],
  fracToRemove: number = TRUNCATION_FRACTION
): TruncationResult {
  const truncationId = generateUUID();

  // Get visible messages (not already truncated)
  const visibleIndices: number[] = [];
  messages.forEach((msg, index) => {
    if (!msg.truncationParent && !msg.isTruncationMarker) {
      visibleIndices.push(index);
    }
  });

  // Calculate how many to remove (excluding first message)
  const visibleCount = visibleIndices.length;
  const rawMessagesToRemove = Math.floor((visibleCount - 1) * fracToRemove);
  // Ensure even number (maintain user/assistant pairing)
  const messagesToRemove = rawMessagesToRemove - (rawMessagesToRemove % 2);

  if (messagesToRemove < 2) {
    return { messages, truncationId, messagesRemoved: 0 };
  }

  // Determine which indices to truncate (skip index 0 = first message)
  const indicesToTruncate = new Set<number>();
  for (let i = 1; i <= messagesToRemove && i < visibleIndices.length; i++) {
    indicesToTruncate.add(visibleIndices[i]);
  }

  // Tag messages with truncationParent
  const taggedMessages = messages.map((msg, index) => {
    if (indicesToTruncate.has(index)) {
      return { ...msg, truncationParent: truncationId };
    }
    return msg;
  });

  // Find timestamp for truncation marker
  const firstKeptIndex = visibleIndices[messagesToRemove + 1] ?? visibleIndices[visibleIndices.length - 1];
  const firstKeptTs = messages[firstKeptIndex]?.ts ?? Date.now();

  // Create truncation marker
  const truncationMarker: ApiMessage = {
    role: 'user',
    content: `[Context truncated: ${messagesToRemove} earlier messages hidden to manage context window]`,
    ts: firstKeptTs - 1,
    isTruncationMarker: true,
    truncationId,
  };

  // Insert marker after first message
  const result = [...taggedMessages];
  result.splice(1, 0, truncationMarker);

  return {
    messages: result,
    truncationId,
    messagesRemoved: messagesToRemove,
  };
}

const DEFAULT_MAX_OUTPUT_TOKENS = 8192;
const FORCED_REDUCTION_PERCENT = 75; // 75% reduction on context overflow error

// ============================================================
// CONSTANTS
// ============================================================
const TOKEN_BUFFER_PERCENTAGE = 0.1; // 10% buffer

// const MESSAGES_TO_KEEP = 3; // Keep last N messages during condensation (unused for now)
const TRUNCATION_FRACTION = 0.5; // Remove 50% of messages during truncation

export const contextManager = new ContextManagerService();
