/**
 * Token Estimation Service
 *
 * Provides approximate token counts for text content.
 * Uses character-based estimation as a reasonable approximation.
 *
 * Average ratios (empirically derived):
 * - English text: ~4 characters per token
 * - Code: ~3.5 characters per token (more symbols)
 * - JSON: ~3 characters per token (lots of punctuation)
 * - Mixed content: ~3.7 characters per token
 */

import type { ChatMessage } from './llm-types';
import type { ToolDefinition } from '../tools/types';

// Estimation constants
const CHARS_PER_TOKEN_TEXT = 4;
const CHARS_PER_TOKEN_CODE = 3.5;
const CHARS_PER_TOKEN_JSON = 3;
const CHARS_PER_TOKEN_MIXED = 3.7;

// Fixed overhead estimates
const MESSAGE_OVERHEAD_TOKENS = 4; // Role, formatting per message
const TOOL_DEFINITION_OVERHEAD = 10; // Per tool definition overhead
const SYSTEM_PROMPT_OVERHEAD = 50; // System message formatting

/**
 * Estimate tokens for a string
 */
export function estimateTokens(text: string, type: 'text' | 'code' | 'json' | 'mixed' = 'mixed'): number {
  if (!text) return 0;

  const charsPerToken = {
    text: CHARS_PER_TOKEN_TEXT,
    code: CHARS_PER_TOKEN_CODE,
    json: CHARS_PER_TOKEN_JSON,
    mixed: CHARS_PER_TOKEN_MIXED,
  }[type];

  return Math.ceil(text.length / charsPerToken);
}

/**
 * Estimate tokens for a chat message
 */
export function estimateMessageTokens(message: ChatMessage): number {
  let tokens = MESSAGE_OVERHEAD_TOKENS;

  // Content tokens
  if (message.content) {
    tokens += estimateTokens(message.content, 'mixed');
  }

  // Reasoning/thinking content (for assistant messages)
  if ('reasoning_content' in message && message.reasoning_content) {
    tokens += estimateTokens(message.reasoning_content, 'text');
  }

  // Tool calls (for assistant messages)
  if ('tool_calls' in message && message.tool_calls) {
    for (const toolCall of message.tool_calls) {
      tokens += estimateTokens(toolCall.function.name, 'text');
      tokens += estimateTokens(toolCall.function.arguments, 'json');
      tokens += 10; // Tool call structure overhead
    }
  }

  // Tool call ID (for tool messages)
  if ('tool_call_id' in message && message.tool_call_id) {
    tokens += estimateTokens(message.tool_call_id, 'text');
  }

  return tokens;
}

/**
 * Estimate tokens for an array of messages
 */
export function estimateMessagesTokens(messages: ChatMessage[]): number {
  return messages.reduce((total, msg) => total + estimateMessageTokens(msg), 0);
}

/**
 * Estimate tokens for tool definitions
 */
export function estimateToolsTokens(tools: ToolDefinition[]): number {
  if (!tools || tools.length === 0) return 0;

  let tokens = 0;
  for (const tool of tools) {
    tokens += TOOL_DEFINITION_OVERHEAD;
    tokens += estimateTokens(tool.function.name, 'text');
    tokens += estimateTokens(tool.function.description || '', 'text');

    // Parameters schema
    if (tool.function.parameters) {
      const paramsJson = JSON.stringify(tool.function.parameters);
      tokens += estimateTokens(paramsJson, 'json');
    }
  }

  return tokens;
}

/**
 * Estimate total tokens for a request
 */
export function estimateRequestTokens(
  messages: ChatMessage[],
  tools?: ToolDefinition[]
): number {
  let total = 0;

  // System prompt overhead
  const hasSystem = messages.some(m => m.role === 'system');
  if (hasSystem) {
    total += SYSTEM_PROMPT_OVERHEAD;
  }

  // Messages
  total += estimateMessagesTokens(messages);

  // Tools
  if (tools && tools.length > 0) {
    total += estimateToolsTokens(tools);
  }

  return total;
}

/**
 * Calculate available tokens for response
 */
export function calculateAvailableTokens(
  contextWindow: number,
  usedTokens: number,
  maxOutputTokens: number
): number {
  const remaining = contextWindow - usedTokens;
  return Math.min(remaining, maxOutputTokens);
}

/**
 * Check if we're approaching context limit
 */
export function checkContextLimit(
  usedTokens: number,
  contextWindow: number
): {
  percentage: number;
  isNearLimit: boolean;
  isOverLimit: boolean;
  remainingTokens: number;
} {
  const percentage = Math.round((usedTokens / contextWindow) * 100);
  const remainingTokens = Math.max(0, contextWindow - usedTokens);

  return {
    percentage: Math.min(100, percentage),
    isNearLimit: percentage >= 80,
    isOverLimit: percentage >= 100,
    remainingTokens,
  };
}

export default {
  estimateTokens,
  estimateMessageTokens,
  estimateMessagesTokens,
  estimateToolsTokens,
  estimateRequestTokens,
  calculateAvailableTokens,
  checkContextLimit,
};
