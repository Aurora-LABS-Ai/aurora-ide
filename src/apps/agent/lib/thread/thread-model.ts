/**
 * Agent Window — which model a conversation is on (leaf, non-component).
 *
 * The single source of truth for resolving "the model for THIS chat", shared by
 * the composer's picker and the send pipeline. They must never disagree: a
 * composer showing one model while the turn runs on another is worse than no
 * indicator at all.
 *
 * The rule, in order:
 *   1. the conversation's own pinned model (`ThreadSummary.model`, persisted on
 *      the thread's sidecar — written when the user picks one, and again by the
 *      runtime at the end of every turn);
 *   2. the user's default (`useSettingsStore.selectedModel`) — used by a draft
 *      that has no thread yet, and by chats that predate per-conversation
 *      models or have never run a turn.
 *
 * Step 2 is a FALLBACK, not the state: it is what a NEW chat inherits, which is
 * why picking a model also updates it. Before this existed, `selectedModel` was
 * the whole story, so opening an old chat showed whichever model had been
 * picked last anywhere and sending silently ran on it.
 */

import { useSettingsStore } from "@/kernel/store/useSettingsStore";
import { useAgentChatStore } from "@/apps/agent/store/conversation/useAgentChatStore";

/** The chat-store shape this module reads. Structural, so tests can pass a stub. */
interface ThreadModelSource {
  threads: Array<{ id: string; model?: string | null }>;
  allThreads: Array<{ id: string; model?: string | null }>;
}

/**
 * The model pinned to `threadId`, or `null` when it has none.
 *
 * Pure and synchronous so it can run inside a zustand selector — the composer
 * pill has to re-render the moment the open chat changes.
 */
export function pinnedThreadModel(
  state: ThreadModelSource,
  threadId: string | null | undefined,
): string | null {
  if (!threadId) return null;
  const row =
    state.allThreads.find((t) => t.id === threadId) ??
    state.threads.find((t) => t.id === threadId);
  return row?.model || null;
}

/**
 * The model `threadId` will actually run on, pin or default. Imperative (reads
 * the live stores), for the send path — which must resolve at send time, not at
 * render time, so a pick made while the composer was focused still counts.
 */
export function resolveThreadModel(threadId: string | null | undefined): string {
  const pinned = pinnedThreadModel(useAgentChatStore.getState(), threadId);
  return pinned ?? useSettingsStore.getState().selectedModel;
}
