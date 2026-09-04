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
} from '@/kernel/lib/ipc/runtime';
import type { AuroraSurface } from '@/apps/agent/services/runtime/agent-execution-mode';

// ============================================================
// Types — wire shapes returned by the Rust commands
// ============================================================

export interface ThreadSummary {
  id: string;
  title: string;
  messageCount: number;
  preview: string;
  /** Project the thread is scoped to. Absent for legacy unscoped threads. */
  workspaceRoot?: string | null;
  /**
   * The model this conversation is on, as `"providerId:modelKey"`. Absent for
   * chats that predate per-conversation models or have never run a turn — the
   * composer falls back to the user's default model for those.
   */
  model?: string | null;
  /** Whether the chat is pinned to the top of the rail. */
  pinned?: boolean;
  /**
   * RFC3339 instant the chat was archived, or absent/null when active.
   * Archived chats live in the rail's "Archived" view and are auto-purged
   * 15 days after this timestamp.
   */
  archivedAt?: string | null;
  /** Aurora Chat: started in deep research. Fixed at creation, never changed. */
  deepResearch?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /**
   * True when these counts are a local tiktoken ESTIMATE, not numbers the
   * provider reported. Set by the agent window when a turn finishes without any
   * `usage` event (e.g. an OpenAI-compatible provider that doesn't emit
   * `stream_options.include_usage`). The UI flags estimated counts with a `~`.
   */
  estimated?: boolean;
  /**
   * USD the PROVIDER reported for this request, when it reports one (routers
   * in the OpenRouter family send `usage.cost`). Outranks any price Aurora
   * multiplies out of a catalog rate: it is the account's actual charge,
   * already including gateway markup, BYOK rates, promos and discounts.
   */
  costUsd?: number;
}

export interface ContextUsage {
  usedTokens: number;
  contextWindow: number;
  percentage: number;
}

/**
 * Compact, display-only record of an element the user picked with the in-app
 * browser inspector. Rendered as a "Selected N" chip on the user bubble. The
 * FULL element context (outerHTML etc.) is sent to the model separately via the
 * turn's ideContext — this is purely for the transcript UI.
 */
export interface AttachedSelectedElement {
  index: number;
  selector: string;
  tagName: string;
  url?: string | null;
  text?: string | null;
  source?: string;
}

/**
 * A `/`-directive (skill / rule / MCP) the user attached to a turn in the
 * composer, snapshotted onto the user message purely so the chip re-renders in
 * the transcript. The directive's effect already rode to the model via the
 * turn's ideContext.
 */
export interface AttachedCommandChip {
  kind: "skill" | "rule" | "mcp";
  title: string;
}

/** Exact inline composer pills persisted with a user turn for transcript replay. */
export interface AttachedPromptChip {
  /** `folder` is a path chip like `file`, not a directive — see MessageBubble. */
  /** `terminal` carries a live terminal session id in `value`. */
  /** `element` is a browser-inspector pick riding a MID-TURN injection; its
   *  `value` holds the CSS selector. (A fresh turn's picks travel as
   *  `attachedSelectedElements` instead — this kind exists because the queued
   *  path has exactly one chip channel through the Rust runtime.) */
  kind: "file" | "folder" | "skill" | "rule" | "mcp" | "terminal" | "element";
  title: string;
  /** Serialized file reference (`rel` for @ picker, absolute for OS picks). */
  value?: string | null;
  /** Absolute file path used to resolve the same icon and tooltip after reload. */
  path?: string | null;
}

export interface DbMessage {
  id: string;
  role: string;
  content: string;
  timestamp: string;
  /** User messages only — chips for elements picked via the browser inspector. */
  attachedSelectedElements?: AttachedSelectedElement[] | null;
  /** User messages only — chips for `/`-attached skills / rules / MCP servers. */
  attachedCommands?: AttachedCommandChip[] | null;
  /** User messages only — exact file and `/` pills from the composer. */
  attachedPromptChips?: AttachedPromptChip[] | null;
  // serde renames the Rust `tool_calls` field through the
  // `Message` model (which keeps snake_case for backwards-compat).
  tool_calls?: Array<{
    id: string;
    name: string;
    arguments: string;
    result?: string | null;
    /** Live-only wall-clock execution time; never persisted by Rust. */
    durationMs?: number;
    /** Live-only epoch ms the call began executing, so a running card can show
     *  a clock. Never persisted by Rust either — a reloaded call has no start
     *  time and correctly shows none. */
    startedAt?: number;
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
  token_usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    cacheReadTokens?: number;
    estimated?: boolean;
  } | null;
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

  /**
   * `surface` decides WHICH conversation store the new chat is written to:
   * `'chat'` puts it in Aurora Chat's `Chats/`, anything else in Build's
   * `sessions/`.
   *
   * It has to be passed here and on `listThreads`, and nowhere else. Every
   * other command names a conversation that already exists, and Rust looks the
   * store up from the id rather than trusting a caller to remember.
   */
  async createThread(
    title?: string,
    workspaceRoot?: string | null,
    surface?: AuroraSurface,
    deepResearch?: boolean,
  ): Promise<DbThread> {
    return await invoke<DbThread>('thread_create', {
      title: title ?? null,
      workspaceRoot: workspaceRoot ?? null,
      surface: surface ?? null,
      // The ONLY place deep research can be set. It is fixed on the
      // conversation from here on, so there is no setter to call later.
      deepResearch: deepResearch ?? false,
    });
  }

  async loadThread(threadId: string): Promise<DbThread | null> {
    return await invoke<DbThread | null>('thread_load', { threadId });
  }

  async deleteThread(threadId: string): Promise<void> {
    await invoke('thread_delete', { threadId });
  }

  /** Duplicate the persisted transcript as a new active, unpinned chat. */
  async duplicateThread(threadId: string): Promise<ThreadSummary> {
    return await invoke<ThreadSummary>('thread_duplicate', { threadId });
  }

  /** Render the visible conversation as Markdown and copy it natively. */
  async copyThreadAsMarkdown(threadId: string): Promise<void> {
    await invoke('thread_copy_markdown', { threadId });
  }

  /**
   * List threads. Pass `workspaceRoot` to get only that project's
   * chats (the agent window's project-scoped list); omit it for the
   * IDE's global history.
   *
   * `surface: 'chat'` lists Aurora Chat's conversations instead. Pass no
   * `workspaceRoot` with it — chat conversations have no workspace, so a
   * project filter matches none of them.
   */
  async listThreads(
    workspaceRoot?: string | null,
    surface?: AuroraSurface,
  ): Promise<ThreadSummary[]> {
    return await invoke<ThreadSummary[]>('thread_list_summaries', {
      workspaceRoot: surface === 'chat' ? null : (workspaceRoot ?? null),
      surface: surface ?? null,
    });
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
   * Generate a short chat title from the first user message via the configured
   * OpenAI-compatible title-maker endpoint. Rejects on any error (the caller
   * keeps the locally-derived title). Does NOT persist — pair with `updateTitle`.
   */
  async generateTitle(params: {
    baseUrl: string;
    apiKey: string | null;
    model: string;
    userMessage: string;
  }): Promise<string> {
    return invoke<string>('generate_thread_title', {
      baseUrl: params.baseUrl,
      apiKey: params.apiKey,
      model: params.model,
      userMessage: params.userMessage,
    });
  }

  /** Pin / unpin a chat. Persisted in the thread's metadata sidecar. */
  async setPinned(threadId: string, pinned: boolean): Promise<void> {
    await invoke('thread_set_pinned', { threadId, pinned });
  }

  /**
   * Archive / unarchive a chat. Archived chats leave the rail tree for the
   * "Archived" view and are permanently purged 15 days after archiving.
   * Persisted in the metadata sidecar.
   */
  async setArchived(threadId: string, archived: boolean): Promise<void> {
    await invoke('thread_set_archived', { threadId, archived });
  }

  /**
   * Pin a conversation to a model (`"providerId:modelKey"`), or pass `null` to
   * clear it back to the user's default.
   *
   * The runtime writes this field itself on every turn, so this call is for the
   * choice made BEFORE a turn runs — open an old chat, switch its model, then
   * send. Without it, the pick would live only in memory and be lost the moment
   * you navigated away.
   */
  async setModel(threadId: string, model: string | null): Promise<void> {
    await invoke('thread_set_model', { threadId, model });
  }

  /**
   * Upsert a thread row. The Rust side only persists `title` (and, when
   * supplied, the `workspaceRoot` scope) — the messages array is owned
   * exclusively by the agent runtime and is ignored when present.
   */
  async saveThread(
    thread: DbThread,
    workspaceRoot?: string | null,
  ): Promise<void> {
    await invoke('thread_save', { thread, workspaceRoot: workspaceRoot ?? null });
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
