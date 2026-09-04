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
import { isImageModelSelection } from "@/apps/agent/services/providers/image-providers";
import { endpointIdentity, isEndpointModelKey } from "@/apps/agent/services/providers/modal";

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
  if (!modelKey) return selection;
  // An exact row always wins, for every provider. Only a pin naming a model
  // that is genuinely gone is worth rewriting.
  if (models.some((model) => model.providerId === providerId && model.modelKey === modelKey)) {
    return selection;
  }

  // Modal addresses an endpoint by a hostname that carries the gateway region,
  // so changing region renames every model on the row. The endpoint is the
  // same deployment — same workspace, same name — so a conversation pinned to
  // its old hostname follows it instead of dying on `unknown inference model`.
  if (isEndpointModelKey(modelKey)) {
    const identity = endpointIdentity(modelKey);
    const moved = models.find(
      (model) =>
        model.providerId === providerId && endpointIdentity(model.modelKey) === identity,
    );
    if (moved) return `${providerId}:${moved.modelKey}`;
    return selection;
  }

  if (providerId !== CURSOR_PROVIDER_ID) return selection;
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
 * Keep a chat on a model its picker still offers.
 *
 * Aurora Chat is given a shortlist — up to ten models, ticked on the provider
 * page. A conversation pinned to a model that later leaves that shortlist is
 * not thrown away and does not break: it falls to the next available one, and
 * says so by simply showing that model in the composer.
 *
 * Three deliberate non-actions:
 *   - An EMPTY shortlist changes nothing. Nothing ticked means "no shortlist
 *     yet", not "no models" — a fresh install would otherwise open onto a chat
 *     that cannot send.
 *   - A shortlist whose every entry is gone changes nothing either. A pinned
 *     model that still exists beats falling back to nothing.
 *   - Build is untouched. Its roster is long on purpose and has no shortlist.
 */
export function applyChatShortlist(
  selection: string,
  shortlist: readonly string[],
  models: ModelRowIdentity[],
): string {
  if (shortlist.length === 0 || shortlist.includes(selection)) return selection;
  // An image model is picked from its own list, not the shortlist — the
  // shortlist is ticked on the LANGUAGE provider page and can never contain
  // one. Filtering it here would silently turn a picture-making chat back into
  // a talking one the moment a shortlist exists.
  if (isImageModelSelection(selection)) return selection;
  const exists = (entry: string) => {
    const separator = entry.indexOf(":");
    if (separator < 1) return false;
    const providerId = entry.slice(0, separator);
    const modelKey = entry.slice(separator + 1);
    return models.some((m) => m.providerId === providerId && m.modelKey === modelKey);
  };
  return shortlist.find(exists) ?? selection;
}

/**
 * Keep Aurora Build on a model that can actually write software.
 *
 * One field — `useSettingsStore.selectedModel` — is the default for both
 * products, and picking a model anywhere writes it. That is what makes the
 * picker work at all on a fresh conversation, which has no thread of its own to
 * pin to yet. But Aurora Chat can be pointed at an image model, and Build
 * cannot run one: its picker never offers them, and a turn that reached one
 * would fail with "model no longer available" and no way to read why from the
 * screen.
 *
 * So Build substitutes at READ time and the substitution is never written back
 * (see `resolveThreadModel`). The picture-making default the user chose in Chat
 * is still there when they go back to Chat; Build simply declines to inherit
 * it. The alternative — a second stored default per product — is a bigger
 * change than the problem, and would still have to answer this same question
 * the first time the two disagree.
 *
 * An empty roster changes nothing, for the same reason an empty chat shortlist
 * does: falling back to no model at all is worse than the model you cannot run.
 */
export function applyBuildRoster(selection: string, models: ModelRowIdentity[]): string {
  if (!isImageModelSelection(selection)) return selection;
  const first = models[0];
  return first ? `${first.providerId}:${first.modelKey}` : selection;
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
  // Applied HERE, not in the picker, so the model the turn runs on and the
  // model the composer shows can never be two different things — which is the
  // whole reason this module exists.
  const resolved =
    settings.auroraSurface === "chat"
      ? applyChatShortlist(normalized, settings.chatModelShortlist, settings.models)
      : applyBuildRoster(normalized, settings.models);
  if (pinned && resolved !== pinned && threadId) {
    void chat.setThreadModel(threadId, resolved);
  } else if (
    !pinned &&
    resolved !== settings.selectedModel &&
    // Build's image bypass is for THIS turn, not a correction to persist.
    // Writing it back would erase the picture-making model the user chose in
    // Chat the first time they opened Build — a setting undone by visiting
    // another screen.
    !isImageModelSelection(settings.selectedModel)
  ) {
    settings.setSelectedModel(resolved);
  }
  return resolved;
}
