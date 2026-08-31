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
import { CURSOR_PROVIDER_ID } from "@/apps/agent/services/providers/cursor";
import { splitCursorVariant } from "@/apps/agent/services/providers/cursor-variants";

/** The chat-store shape this module reads. Structural, so tests can pass a stub. */
interface ThreadModelSource {
  threads: Array<{ id: string; model?: string | null }>;
  allThreads: Array<{ id: string; model?: string | null }>;
}

interface ModelRowIdentity {
  providerId: string;
  modelKey: string;
}

/**
 * Convert an old decorated Cursor pin to the stable model row it belongs to.
 *
 * Migration is deliberately conservative. An exact row always wins, and a
 * suffix is stripped only when that exact row is gone and the resulting stem
 * is present. This avoids treating a legitimate model name ending in `-high`
 * or `-fast` as a run modifier on guesswork.
 */
export function normalizeThreadModelSelection(
  selection: string,
  models: ModelRowIdentity[],
): string {
  const separator = selection.indexOf(":");
  if (separator < 1) return selection;
  const providerId = selection.slice(0, separator);
  const modelKey = selection.slice(separator + 1);
  if (providerId !== CURSOR_PROVIDER_ID || !modelKey) return selection;
  if (models.some((model) => model.providerId === providerId && model.modelKey === modelKey)) {
    return selection;
  }
  const { stem } = splitCursorVariant(modelKey);
  if (
    stem !== modelKey &&
    models.some((model) => model.providerId === providerId && model.modelKey === stem)
  ) {
    return `${providerId}:${stem}`;
  }
  return selection;
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
  const chat = useAgentChatStore.getState();
  const settings = useSettingsStore.getState();
  const pinned = pinnedThreadModel(chat, threadId);
  const source = pinned ?? settings.selectedModel;
  const normalized = normalizeThreadModelSelection(source, settings.models);
  if (pinned && normalized !== pinned && threadId) {
    void chat.setThreadModel(threadId, normalized);
  } else if (!pinned && normalized !== settings.selectedModel) {
    settings.setSelectedModel(normalized);
  }
  return normalized;
}
