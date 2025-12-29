/**
 * Token Counter - Enterprise-grade token estimation
 *
 * Based on KiloCode's approach:
 * - Character-based estimation with type-specific ratios
 * - 1.5x fudge factor for accuracy
 * - Handles text, code, JSON, and images
 */

import type { Message, ContentBlock, ToolDefinition } from './types';

// Token estimation ratios (characters per token)
const CHARS_PER_TOKEN = {
  text: 4,
  code: 3.5,
  json: 3,
  mixed: 3.7,
};

// Fudge factor for estimation accuracy (KiloCode uses 1.5x)
const TOKEN_FUDGE_FACTOR = 1.5;

// Message overhead tokens
const MESSAGE_OVERHEAD_TOKENS = 4;

// Tool definition overhead
const TOOL_OVERHEAD_TOKENS = 10;

// Image token estimation (conservative)
const IMAGE_BASE_TOKENS = 300;

export class TokenCounter {
  private fudgeFactor: number;

  constructor(fudgeFactor: number = TOKEN_FUDGE_FACTOR) {
    this.fudgeFactor = fudgeFactor;
  }

  /**
   * Count tokens for content (string or content blocks)
   */
  countTokens(content: string | ContentBlock[]): number {
    if (typeof content === 'string') {
      return this.estimateTextTokens(content);
    }

    let total = 0;
    for (const block of content) {
      total += this.countBlockTokens(block);
    }

    return Math.ceil(total * this.fudgeFactor);
  }

  /**
   * Count tokens for a single content block
   */
  private countBlockTokens(block: ContentBlock): number {
    switch (block.type) {
      case 'text':
        return this.estimateTextTokens(block.text, false);

      case 'thinking':
        return this.estimateTextTokens(block.thinking, false);

      case 'image':
        return this.estimateImageTokens(block.source?.data);

      case 'tool_use':
        const nameTokens = this.estimateTextTokens(block.name, false);
        const inputTokens = this.estimateTextTokens(
          JSON.stringify(block.input),
          false
        );
        return nameTokens + inputTokens + TOOL_OVERHEAD_TOKENS;

      case 'tool_result':
        return this.estimateTextTokens(block.content, false);

      default:
        return 0;
    }
  }

  /**
   * Estimate tokens for text content
   */
  private estimateTextTokens(text: string, applyFudge: boolean = true): number {
    if (!text) return 0;

    // Detect content type
    const ratio = this.detectContentRatio(text);
    const tokens = Math.ceil(text.length / ratio);

    return applyFudge ? Math.ceil(tokens * this.fudgeFactor) : tokens;
  }

  /**
   * Detect content type and return appropriate ratio
   */
  private detectContentRatio(text: string): number {
    // Check for JSON
    if (text.startsWith('{') || text.startsWith('[')) {
      try {
        JSON.parse(text);
        return CHARS_PER_TOKEN.json;
      } catch {
        // Not JSON, continue
      }
    }

    // Check for code (simple heuristics)
    const codeIndicators = [
      /^(import|export|const|let|var|function|class|interface|type)\s/m,
      /[{}();=]/,
      /^\s{2,}/m, // Indentation
      /\/\//,     // Comments
      /```/,      // Code blocks
    ];

    const hasCodeIndicators = codeIndicators.filter(r => r.test(text)).length;
    if (hasCodeIndicators >= 2) {
      return CHARS_PER_TOKEN.code;
    }

    // Default to mixed content
    return CHARS_PER_TOKEN.mixed;
  }

  /**
   * Estimate tokens for image content
   * Uses sqrt of base64 length (KiloCode approach)
   */
  private estimateImageTokens(base64Data?: string): number {
    if (!base64Data) {
      return IMAGE_BASE_TOKENS;
    }

    // KiloCode formula: sqrt of data length
    return Math.ceil(Math.sqrt(base64Data.length));
  }

  /**
   * Estimate total tokens for a complete request
   */
  estimateRequest(
    messages: Message[],
    tools?: ToolDefinition[]
  ): number {
    let total = 0;

    // Count message tokens
    for (const msg of messages) {
      total += MESSAGE_OVERHEAD_TOKENS;
      total += this.countTokens(msg.content);
    }

    // Count tool definition tokens
    if (tools?.length) {
      for (const tool of tools) {
        total += TOOL_OVERHEAD_TOKENS;
        total += this.estimateTextTokens(tool.function.name, false);
        total += this.estimateTextTokens(tool.function.description, false);
        total += this.estimateTextTokens(
          JSON.stringify(tool.function.parameters),
          false
        );
      }
    }

    return Math.ceil(total * this.fudgeFactor);
  }

  /**
   * Estimate tokens for a message array (for history)
   */
  estimateHistory(messages: Message[]): number {
    return this.estimateRequest(messages);
  }

  /**
   * Calculate remaining tokens in context window
   */
  getRemainingTokens(
    usedTokens: number,
    contextWindow: number,
    reservedForOutput: number
  ): number {
    const bufferPercent = 0.1; // 10% buffer (KiloCode)
    const allowedTokens = contextWindow * (1 - bufferPercent) - reservedForOutput;
    return Math.max(0, allowedTokens - usedTokens);
  }

  /**
   * Check if context is near limit (>80%)
   */
  isNearLimit(usedTokens: number, contextWindow: number): boolean {
    return (usedTokens / contextWindow) >= 0.8;
  }

  /**
   * Check if context is over limit
   */
  isOverLimit(
    usedTokens: number,
    contextWindow: number,
    reservedForOutput: number
  ): boolean {
    const bufferPercent = 0.1;
    const allowedTokens = contextWindow * (1 - bufferPercent) - reservedForOutput;
    return usedTokens > allowedTokens;
  }

  /**
   * Calculate usage percentage
   */
  getUsagePercentage(usedTokens: number, contextWindow: number): number {
    if (contextWindow <= 0) return 0;
    return Math.min(100, Math.round((usedTokens / contextWindow) * 100));
  }
}

// Singleton instance
export const tokenCounter = new TokenCounter();
