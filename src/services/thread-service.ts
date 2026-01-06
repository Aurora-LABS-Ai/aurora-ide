/**
 * Thread Service - TypeScript wrapper for Rust thread operations
 * 
 * This service provides:
 * - Per-message persistence (messages saved immediately, not after streaming)
 * - Crash recovery (no data loss)
 * - Multi-window sync via Tauri events
 * - Accurate token counting via Rust tiktoken
 */

import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

import type { Message } from '../types';

// ============================================================
// Types
// ============================================================

export interface ThreadSummary {
  id: string;
  title: string;
  messageCount: number;
  preview: string;
  createdAt: string;
  updatedAt: string;
}

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

export interface DbMessage {
  id: string;
  role: string;
  content: string;
  timestamp: string;
  tool_calls?: any[] | undefined;
  thinking?: string;
  isThinking?: boolean;
  tools?: any[];
  timeline?: any;
  toolProposal?: any;
}

export interface DbThread {
  id: string;
  title: string;
  summary?: string | null;
  messages: DbMessage[];
  token_usage?: { promptTokens: number; completionTokens: number; totalTokens: number } | null;
  context_usage?: { usedTokens: number; contextWindow: number; percentage: number } | null;
  created_at: string;
  updated_at: string;
}

export interface ApiMessage {
  role: string;
  content?: string;
  reasoning_content?: string;
  tool_calls?: Array<{
    id: string;
    type: string;
    function: {
      name: string;
      arguments: string;
    };
  }>;
  tool_call_id?: string;
}

// ============================================================
// Thread Events
// ============================================================

export interface ThreadCreatedEvent {
  thread: ThreadSummary;
}

export interface ThreadLoadedEvent {
  thread: DbThread;
}

export interface ThreadDeletedEvent {
  threadId: string;
}

export interface ThreadMessageAddedEvent {
  threadId: string;
  message: DbMessage;
}

export interface ThreadMessageUpdatedEvent {
  threadId: string;
  messageId: string;
  updates: Partial<Message>;
}

export interface ThreadTokenReceivedEvent {
  threadId: string;
  streamId: string;
  token: string;
}

export interface ThreadThinkingReceivedEvent {
  threadId: string;
  streamId: string;
  thinking: string;
}

export interface ThreadToolAddedEvent {
  threadId: string;
  streamId: string;
  toolCall: unknown;
}

export interface ThreadToolCompletedEvent {
  threadId: string;
  streamId: string;
  toolId: string;
  result: string;
}

export interface ThreadUsageUpdatedEvent {
  threadId: string;
  tokenUsage: TokenUsage;
  contextUsage: ContextUsage;
}

// ============================================================
// Token Counting Types
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
// Thread Service
// ============================================================

class ThreadServiceClass {
  private eventListeners: UnlistenFn[] = [];
  private onThreadCreated?: (event: ThreadCreatedEvent) => void;
  private onThreadLoaded?: (event: ThreadLoadedEvent) => void;
  private onThreadDeleted?: (event: ThreadDeletedEvent) => void;
  private onMessageAdded?: (event: ThreadMessageAddedEvent) => void;
  private onMessageUpdated?: (event: ThreadMessageUpdatedEvent) => void;
  private onTokenReceived?: (event: ThreadTokenReceivedEvent) => void;
  private onThinkingReceived?: (event: ThreadThinkingReceivedEvent) => void;
  private onToolAdded?: (event: ThreadToolAddedEvent) => void;
  private onToolCompleted?: (event: ThreadToolCompletedEvent) => void;
  private onUsageUpdated?: (event: ThreadUsageUpdatedEvent) => void;

  // ============================================================
  // Thread Operations
  // ============================================================

  /**
   * Create a new thread
   */
  async createThread(title?: string): Promise<DbThread> {
    return await invoke<DbThread>('thread_create', { title: title ?? null });
  }

  /**
   * Load a thread by ID
   */
  async loadThread(threadId: string): Promise<DbThread | null> {
    return await invoke<DbThread | null>('thread_load', { threadId });
  }

  /**
   * Delete a thread
   */
  async deleteThread(threadId: string): Promise<void> {
    await invoke('thread_delete', { threadId });
  }

  /**
   * List all threads (summaries for performance)
   */
  async listThreads(): Promise<ThreadSummary[]> {
    return await invoke<ThreadSummary[]>('thread_list_summaries');
  }

  /**
   * Add a user message to thread (persists immediately)
   */
  async addUserMessage(
    threadId: string,
    content: string,
    attachments?: unknown[]
  ): Promise<DbMessage> {
    return await invoke<DbMessage>('thread_add_user_message', {
      request: {
        threadId,
        content,
        attachments: attachments ?? null,
      },
    });
  }

  /**
   * Start an assistant response stream
   * Returns a stream_id for tracking subsequent updates
   */
  async startResponse(threadId: string): Promise<string> {
    return await invoke<string>('thread_start_response', { threadId });
  }

  /**
   * Append token to streaming response
   */
  async appendToken(streamId: string, token: string): Promise<void> {
    await invoke('thread_append_token', { streamId, token });
  }

  /**
   * Append thinking content to streaming response
   */
  async appendThinking(streamId: string, thinking: string): Promise<void> {
    await invoke('thread_append_thinking', { streamId, thinking });
  }

  /**
   * Add tool call to streaming response
   */
  async addToolCall(streamId: string, toolCall: unknown): Promise<void> {
    await invoke('thread_add_tool_call', { streamId, toolCall });
  }

  /**
   * Finalize response and persist to database
   */
  async finalizeResponse(streamId: string, timeline?: unknown): Promise<DbMessage> {
    return await invoke<DbMessage>('thread_finalize_response', {
      request: {
        streamId,
        timeline: timeline ?? null,
      },
    });
  }

  /**
   * Update thread token/context usage
   */
  async updateUsage(
    threadId: string,
    tokenUsage: TokenUsage,
    contextUsage: ContextUsage
  ): Promise<void> {
    await invoke('thread_update_usage', {
      request: {
        threadId,
        tokenUsage,
        contextUsage,
      },
    });
  }

  /**
   * Get API-formatted history for LLM requests
   * This is used to reconstruct conversation history for the AI
   */
  async getApiHistory(threadId: string): Promise<ApiMessage[]> {
    return await invoke<ApiMessage[]>('thread_get_api_history', { threadId });
  }

  /**
   * Update thread title
   */
  async updateTitle(threadId: string, title: string): Promise<void> {
    await invoke('thread_update_title', { threadId, title });
  }

  // ============================================================
  // Legacy operations (backward compatible with existing DB)
  // ============================================================

  /**
   * Save a full thread (legacy - use per-message methods for new code)
   */
  async saveThread(thread: DbThread): Promise<void> {
    await invoke('save_thread', { thread });
  }

  /**
   * Get a thread by ID (legacy)
   */
  async getThread(threadId: string): Promise<DbThread | null> {
    return await invoke<DbThread | null>('get_thread', { id: threadId });
  }

  /**
   * List all threads (full objects - legacy)
   */
  async listFullThreads(): Promise<DbThread[]> {
    return await invoke<DbThread[]>('list_threads');
  }

  // ============================================================
  // Token Counting (Real tokenizers via Rust)
  // ============================================================

  /**
   * Count tokens in text using real tokenizer
   */
  async countTokens(text: string, model?: string): Promise<TokenCount> {
    return await invoke<TokenCount>('count_tokens', {
      request: { text, model: model ?? null, encoding: null },
    });
  }

  /**
   * Count tokens for a single chat message
   */
  async countChatTokens(role: string, content: string, model: string): Promise<TokenCount> {
    return await invoke<TokenCount>('count_chat_tokens', {
      request: { role, content, model },
    });
  }

  /**
   * Count tokens for a conversation history
   */
  async countMessagesTokens(messages: ChatMessageForCount[], model: string): Promise<TokenCount> {
    return await invoke<TokenCount>('count_messages_tokens', {
      request: { messages, model },
    });
  }

  /**
   * Quick estimate (no tokenizer load - fast fallback)
   */
  async estimateTokensQuick(text: string): Promise<number> {
    return await invoke<number>('estimate_tokens_quick', { text });
  }

  /**
   * Truncate text to fit within token limit
   */
  async truncateToTokens(text: string, maxTokens: number, model?: string): Promise<string> {
    return await invoke<string>('truncate_to_tokens', {
      request: { text, maxTokens, model: model ?? null },
    });
  }

  /**
   * Detect encoding type for a model
   */
  async detectModelEncoding(model: string): Promise<string> {
    return await invoke<string>('detect_model_encoding', { model });
  }

  // ============================================================
  // Event Subscription
  // ============================================================

  /**
   * Subscribe to thread events for real-time sync
   * Call this once when app starts
   */
  async subscribeToEvents(handlers: {
    onThreadCreated?: (event: ThreadCreatedEvent) => void;
    onThreadLoaded?: (event: ThreadLoadedEvent) => void;
    onThreadDeleted?: (event: ThreadDeletedEvent) => void;
    onMessageAdded?: (event: ThreadMessageAddedEvent) => void;
    onMessageUpdated?: (event: ThreadMessageUpdatedEvent) => void;
    onTokenReceived?: (event: ThreadTokenReceivedEvent) => void;
    onThinkingReceived?: (event: ThreadThinkingReceivedEvent) => void;
    onToolAdded?: (event: ThreadToolAddedEvent) => void;
    onToolCompleted?: (event: ThreadToolCompletedEvent) => void;
    onUsageUpdated?: (event: ThreadUsageUpdatedEvent) => void;
  }): Promise<void> {
    // Store handlers
    this.onThreadCreated = handlers.onThreadCreated;
    this.onThreadLoaded = handlers.onThreadLoaded;
    this.onThreadDeleted = handlers.onThreadDeleted;
    this.onMessageAdded = handlers.onMessageAdded;
    this.onMessageUpdated = handlers.onMessageUpdated;
    this.onTokenReceived = handlers.onTokenReceived;
    this.onThinkingReceived = handlers.onThinkingReceived;
    this.onToolAdded = handlers.onToolAdded;
    this.onToolCompleted = handlers.onToolCompleted;
    this.onUsageUpdated = handlers.onUsageUpdated;

    // Clean up existing listeners
    await this.unsubscribeFromEvents();

    // Set up new listeners
    const eventNames = [
      'thread-created',
      'thread-loaded',
      'thread-deleted',
      'thread-message-added',
      'thread-message-updated',
      'thread-token-received',
      'thread-thinking-received',
      'thread-tool-added',
      'thread-tool-completed',
      'thread-usage-updated',
    ];

    for (const eventName of eventNames) {
      const unlisten = await listen(eventName, (event) => {
        this.handleEvent(eventName, event.payload);
      });
      this.eventListeners.push(unlisten);
    }
  }

  /**
   * Unsubscribe from all thread events
   */
  async unsubscribeFromEvents(): Promise<void> {
    for (const unlisten of this.eventListeners) {
      unlisten();
    }
    this.eventListeners = [];
  }

  /**
   * Handle incoming event
   */
  private handleEvent(eventName: string, payload: unknown): void {
    switch (eventName) {
      case 'thread-created':
        this.onThreadCreated?.(payload as ThreadCreatedEvent);
        break;
      case 'thread-loaded':
        this.onThreadLoaded?.(payload as ThreadLoadedEvent);
        break;
      case 'thread-deleted':
        this.onThreadDeleted?.(payload as ThreadDeletedEvent);
        break;
      case 'thread-message-added':
        this.onMessageAdded?.(payload as ThreadMessageAddedEvent);
        break;
      case 'thread-message-updated':
        this.onMessageUpdated?.(payload as ThreadMessageUpdatedEvent);
        break;
      case 'thread-token-received':
        this.onTokenReceived?.(payload as ThreadTokenReceivedEvent);
        break;
      case 'thread-thinking-received':
        this.onThinkingReceived?.(payload as ThreadThinkingReceivedEvent);
        break;
      case 'thread-tool-added':
        this.onToolAdded?.(payload as ThreadToolAddedEvent);
        break;
      case 'thread-tool-completed':
        this.onToolCompleted?.(payload as ThreadToolCompletedEvent);
        break;
      case 'thread-usage-updated':
        this.onUsageUpdated?.(payload as ThreadUsageUpdatedEvent);
        break;
    }
  }
}

// Export singleton
export const threadService = new ThreadServiceClass();

