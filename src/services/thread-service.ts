/**
 * Thread Service - TypeScript wrapper for Rust thread operations.
 *
 * Backed by the agent_v2 SessionStore on the Rust side. Every command
 * here delegates to a Tauri command in `commands::threads`, which in
 * turn reads/writes the JSONL message log + metadata sidecar under
 * `<app_data>/agent_v2/`.
 *
 * Thread events:
 *   - `thread-created`       — fired by `thread_create`
 *   - `thread-loaded`        — fired by `thread_load` / `thread_save`
 *   - `thread-deleted`       — fired by `thread_delete`
 *   - `thread-usage-updated` — fired by `thread_update_usage`
 *   - `thread-cancelled`     — fired by `thread_cancel_current_turn`
 */

import {
  auroraInvoke as invoke,
  auroraListen as listen,
  type AuroraUnlistenFn as UnlistenFn,
} from '../lib/runtime';

// ============================================================
// Types — wire shapes returned by the Rust commands
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
  // serde renames the Rust `tool_calls` field through the
  // `Message` model (which keeps snake_case for backwards-compat).
  tool_calls?: Array<{
    id: string;
    name: string;
    arguments: string;
    result?: string | null;
  }> | null;
  thinking?: string | null;
  isThinking?: boolean | null;
  tools?: unknown[] | null;
  timeline?: unknown;
  toolProposal?: unknown;
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
  private onUsageUpdated?: (event: ThreadUsageUpdatedEvent) => void;

  // ============================================================
  // Thread Operations
  // ============================================================

  async createThread(title?: string): Promise<DbThread> {
    return await invoke<DbThread>('thread_create', { title: title ?? null });
  }

  async loadThread(threadId: string): Promise<DbThread | null> {
    return await invoke<DbThread | null>('thread_load', { threadId });
  }

  async deleteThread(threadId: string): Promise<void> {
    await invoke('thread_delete', { threadId });
  }

  async listThreads(): Promise<ThreadSummary[]> {
    return await invoke<ThreadSummary[]>('thread_list_summaries');
  }

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
   * API-shaped history for reseeding the in-memory context engine on
   * thread switch. Source: the same JSONL the agent loop writes.
   */
  async getApiHistory(threadId: string): Promise<ApiMessage[]> {
    return await invoke<ApiMessage[]>('thread_get_api_history', { threadId });
  }

  async updateTitle(threadId: string, title: string): Promise<void> {
    await invoke('thread_update_title', { threadId, title });
  }

  /**
   * Upsert a thread row. The Rust side only persists `title` — the
   * messages array is owned exclusively by the agent runtime and is
   * ignored when present in the payload.
   */
  async saveThread(thread: DbThread): Promise<void> {
    await invoke('thread_save', { thread });
  }

  /**
   * Cancel any in-flight turn on a thread. Clears in-memory context
   * engine state so the next request rebuilds from the persisted
   * JSONL only.
   */
  async cancelCurrentTurn(
    threadId: string,
    reason: 'user_stop' | 'provider_error' | 'tool_timeout' | 'internal_error' = 'user_stop',
  ): Promise<string | null> {
    return await invoke<string | null>('thread_cancel_current_turn', {
      threadId,
      reason,
    });
  }

  // ============================================================
  // Token Counting (Real tokenizers via Rust)
  // ============================================================

  async countTokens(text: string, model?: string): Promise<TokenCount> {
    return await invoke<TokenCount>('count_tokens', {
      request: { text, model: model ?? null, encoding: null },
    });
  }

  async countChatTokens(role: string, content: string, model: string): Promise<TokenCount> {
    return await invoke<TokenCount>('count_chat_tokens', {
      request: { role, content, model },
    });
  }

  async countMessagesTokens(messages: ChatMessageForCount[], model: string): Promise<TokenCount> {
    return await invoke<TokenCount>('count_messages_tokens', {
      request: { messages, model },
    });
  }

  async estimateTokensQuick(text: string): Promise<number> {
    return await invoke<number>('estimate_tokens_quick', { text });
  }

  async truncateToTokens(text: string, maxTokens: number, model?: string): Promise<string> {
    return await invoke<string>('truncate_to_tokens', {
      request: { text, maxTokens, model: model ?? null },
    });
  }

  async detectModelEncoding(model: string): Promise<string> {
    return await invoke<string>('detect_model_encoding', { model });
  }

  // ============================================================
  // Event Subscription
  // ============================================================

  async subscribeToEvents(handlers: {
    onThreadCreated?: (event: ThreadCreatedEvent) => void;
    onThreadLoaded?: (event: ThreadLoadedEvent) => void;
    onThreadDeleted?: (event: ThreadDeletedEvent) => void;
    onUsageUpdated?: (event: ThreadUsageUpdatedEvent) => void;
  }): Promise<void> {
    this.onThreadCreated = handlers.onThreadCreated;
    this.onThreadLoaded = handlers.onThreadLoaded;
    this.onThreadDeleted = handlers.onThreadDeleted;
    this.onUsageUpdated = handlers.onUsageUpdated;

    await this.unsubscribeFromEvents();

    const eventNames = [
      'thread-created',
      'thread-loaded',
      'thread-deleted',
      'thread-usage-updated',
    ];

    for (const eventName of eventNames) {
      const unlisten = await listen(eventName, (event) => {
        this.handleEvent(eventName, event.payload);
      });
      this.eventListeners.push(unlisten);
    }
  }

  async unsubscribeFromEvents(): Promise<void> {
    for (const unlisten of this.eventListeners) {
      unlisten();
    }
    this.eventListeners = [];
  }

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
      case 'thread-usage-updated':
        this.onUsageUpdated?.(payload as ThreadUsageUpdatedEvent);
        break;
    }
  }
}

// Export singleton
export const threadService = new ThreadServiceClass();
