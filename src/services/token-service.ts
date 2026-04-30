/**
 * Token Service - TypeScript wrapper for Rust tiktoken
 * 
 * Provides accurate token counting using real tokenizers instead of
 * character-based estimation. Supports multiple encoding schemes
 * for different model families.
 * 
 * This replaces the old token-estimator.ts which used character approximation.
 */

import {
  auroraInvoke as invoke,
  isAuroraRuntimeAvailable,
} from '../lib/runtime';

// ============================================================
// Types
// ============================================================

export interface TokenCount {
  tokens: number;
  encoding: string;
  exact: boolean;
}

export interface ChatMessageForCount {
  role: string;
  content: string;
  toolCalls?: Array<{ name: string; arguments: string }>;
}

// ============================================================
// Token Service
// ============================================================

class TokenServiceClass {
  private isInitialized = false;
  private useFallback = false;

  /**
   * Initialize the token service
   * Call this early to pre-warm the tokenizer
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) return;

    if (!isAuroraRuntimeAvailable()) {
      this.useFallback = true;
      this.isInitialized = true;
      return;
    }

    try {
      // Pre-warm tokenizer by doing a test count
      await invoke<TokenCount>('count_tokens', {
        request: { text: 'test', model: null, encoding: null },
      });
      this.isInitialized = true;
    } catch (error) {
      console.warn('[TokenService] Failed to initialize, using fallback:', error);
      this.useFallback = true;
      this.isInitialized = true;
    }
  }

  /**
   * Count tokens in text
   * @param text - Text to count
   * @param model - Optional model name to detect encoding
   * @returns Token count with encoding info
   */
  async countTokens(text: string, model?: string): Promise<TokenCount> {
    if (this.useFallback || !isAuroraRuntimeAvailable()) {
      return this.quickEstimate(text);
    }

    try {
      return await invoke<TokenCount>('count_tokens', {
        request: { text, model: model ?? null, encoding: null },
      });
    } catch (error) {
      console.warn('[TokenService] countTokens failed, using fallback:', error);
      return this.quickEstimate(text);
    }
  }

  /**
   * Count tokens for a chat message (includes OpenAI format overhead)
   */
  async countChatTokens(role: string, content: string, model: string): Promise<TokenCount> {
    if (this.useFallback || !isAuroraRuntimeAvailable()) {
      return this.quickEstimateChatMessage(role, content);
    }

    try {
      return await invoke<TokenCount>('count_chat_tokens', {
        request: { role, content, model },
      });
    } catch (error) {
      console.warn('[TokenService] countChatTokens failed, using fallback:', error);
      return this.quickEstimateChatMessage(role, content);
    }
  }

  /**
   * Count tokens for a conversation history
   */
  async countMessagesTokens(messages: ChatMessageForCount[], model: string): Promise<TokenCount> {
    if (this.useFallback || !isAuroraRuntimeAvailable()) {
      return this.quickEstimateMessages(messages);
    }

    try {
      return await invoke<TokenCount>('count_messages_tokens', {
        request: { messages, model },
      });
    } catch (error) {
      console.warn('[TokenService] countMessagesTokens failed, using fallback:', error);
      return this.quickEstimateMessages(messages);
    }
  }

  /**
   * Quick estimate without loading tokenizer (synchronous fallback)
   * Uses ~4 chars per token average
   */
  quickEstimate(text: string): TokenCount {
    // Average ~4 characters per token for English text
    const tokens = Math.ceil((text.length + 3) / 4);
    return {
      tokens,
      encoding: 'estimate',
      exact: false,
    };
  }

  /**
   * Quick estimate for a chat message
   */
  quickEstimateChatMessage(role: string, content: string): TokenCount {
    // ~4 tokens overhead per message + content
    const overhead = 4;
    const roleTokens = Math.ceil(role.length / 4);
    const contentTokens = Math.ceil(content.length / 4);
    return {
      tokens: overhead + roleTokens + contentTokens,
      encoding: 'estimate',
      exact: false,
    };
  }

  /**
   * Quick estimate for multiple messages
   */
  quickEstimateMessages(messages: ChatMessageForCount[]): TokenCount {
    // 3 tokens for conversation priming
    let total = 3;

    for (const msg of messages) {
      // 4 tokens overhead per message
      total += 4;
      total += Math.ceil(msg.role.length / 4);
      total += Math.ceil(msg.content.length / 4);

      // Tool calls add extra tokens
      if (msg.toolCalls) {
        for (const tc of msg.toolCalls) {
          total += 3; // Tool call overhead
          total += Math.ceil(tc.name.length / 4);
          total += Math.ceil(tc.arguments.length / 4);
        }
      }
    }

    return {
      tokens: total,
      encoding: 'estimate',
      exact: false,
    };
  }

  /**
   * Truncate text to fit within token limit
   */
  async truncateToTokens(text: string, maxTokens: number, model?: string): Promise<string> {
    if (this.useFallback || !isAuroraRuntimeAvailable()) {
      // Approximate truncation: ~4 chars per token
      const maxChars = maxTokens * 4;
      return text.slice(0, maxChars);
    }

    try {
      return await invoke<string>('truncate_to_tokens', {
        request: { text, maxTokens, model: model ?? null },
      });
    } catch (error) {
      console.warn('[TokenService] truncateToTokens failed, using fallback:', error);
      const maxChars = maxTokens * 4;
      return text.slice(0, maxChars);
    }
  }

  /**
   * Detect encoding type for a model
   */
  async detectModelEncoding(model: string): Promise<string> {
    if (this.useFallback || !isAuroraRuntimeAvailable()) {
      // Heuristic detection
      const m = model.toLowerCase();
      if (m.includes('gpt-4o') || m.includes('o1')) {
        return 'o200k';
      }
      return 'cl100k';
    }

    try {
      return await invoke<string>('detect_model_encoding', { model });
    } catch (error) {
      console.warn('[TokenService] detectModelEncoding failed:', error);
      const m = model.toLowerCase();
      if (m.includes('gpt-4o') || m.includes('o1')) {
        return 'o200k';
      }
      return 'cl100k';
    }
  }

  /**
   * Estimate context usage for a request
   * This is a high-level helper that combines multiple token counts
   */
  async estimateContextUsage(
    systemPrompt: string,
    messages: ChatMessageForCount[],
    newMessage: string,
    model: string,
    toolsJson?: string
  ): Promise<{
    systemPromptTokens: number;
    historyTokens: number;
    newMessageTokens: number;
    toolsTokens: number;
    totalTokens: number;
  }> {
    // Count each component
    const [systemCount, historyCount, newMsgCount, toolsCount] = await Promise.all([
      this.countTokens(systemPrompt, model),
      this.countMessagesTokens(messages, model),
      this.countTokens(newMessage, model),
      toolsJson ? this.countTokens(toolsJson, model) : Promise.resolve({ tokens: 0 } as TokenCount),
    ]);

    return {
      systemPromptTokens: systemCount.tokens,
      historyTokens: historyCount.tokens,
      newMessageTokens: newMsgCount.tokens,
      toolsTokens: toolsCount.tokens,
      totalTokens:
        systemCount.tokens + historyCount.tokens + newMsgCount.tokens + toolsCount.tokens,
    };
  }
}

// Export singleton
export const tokenService = new TokenServiceClass();

// Initialize on import (don't block)
tokenService.initialize().catch(console.error);

