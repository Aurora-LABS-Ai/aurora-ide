/**
 * Agent Window — reply-suggestion chips (feature state).
 *
 * After a turn finishes, the picked model (the local prompt-refine model, or a
 * configured cloud one) proposes up to 4 short replies the user could tap
 * instead of typing. Everything is keyed per thread so a background chat's
 * chips never bleed into the open one. Not persisted: stale suggestions after a
 * restart would refer to a conversation state the user no longer sees.
 *
 * Three things are tracked per thread:
 * - `byThread` — the chips on screen. Cleared when one is tapped or a new
 *   message is sent.
 * - `pendingByThread` — the run still being written, so the window can hold a
 *   place for the chips while it waits.
 * - `offerByThread` — what was offered and which chip was tapped. Outlives the
 *   chips themselves (a tap clears them) until the user sends, when
 *   `takeOutcome` reads it once to record what they did with the offer.
 */

import { create } from "zustand";

/** What a run offered, and the chip the user tapped from it, if any. */
export interface SuggestionOffer {
  runId: string;
  shown: string[];
  tapped?: { index: number; text: string };
}

/** What the user did with a set of suggestions, as the log records it. */
export interface SuggestionOutcome {
  runId: string;
  shown: string[];
  action: "tapped" | "tapped_edited" | "typed" | "sent_before_ready";
  tappedIndex?: number;
  sentText: string;
}

interface AgentSuggestState {
  /** threadId → chips for that thread's last settled turn. */
  byThread: Record<string, string[]>;
  /** threadId → the run still writing suggestions for it. */
  pendingByThread: Record<string, string>;
  /** threadId → what the last finished run offered. */
  offerByThread: Record<string, SuggestionOffer>;
  /** Replace a thread's chips (empty array clears the row). */
  setSuggestions: (threadId: string, suggestions: string[]) => void;
  /** Drop a thread's chips (send started / chip tapped / turn superseded). */
  clear: (threadId: string) => void;
  /** A run started writing suggestions for `threadId`. */
  startRun: (threadId: string, runId: string) => void;
  /**
   * A run finished. Ignored unless it is still the thread's pending run — a
   * newer turn has superseded it, or the user already sent.
   */
  finishRun: (threadId: string, runId: string, suggestions: string[]) => void;
  /** A run failed or produced nothing; stop waiting for it. */
  failRun: (threadId: string, runId: string) => void;
  /** The user tapped chip `index`. */
  markTapped: (threadId: string, index: number, text: string) => void;
  /**
   * The user sent `sentText` in `threadId`: return what they did with the
   * suggestions on offer (or the run they did not wait for), and forget it so
   * it is recorded once. `null` when nothing was offered or pending.
   */
  takeOutcome: (threadId: string, sentText: string) => SuggestionOutcome | null;
}

function without<T>(record: Record<string, T>, key: string): Record<string, T> {
  if (!(key in record)) return record;
  const next = { ...record };
  delete next[key];
  return next;
}

/**
 * What a sent message says about an offer. A tapped chip sent unchanged is a
 * tap; a tapped chip that was changed first is an edit; a message that matches
 * a chip word for word counts as that chip even if it was typed; anything else
 * means the chips were ignored.
 */
export function classifyOutcome(offer: SuggestionOffer, sentText: string): SuggestionOutcome {
  const sent = sentText.trim();
  const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
  if (offer.tapped) {
    return {
      runId: offer.runId,
      shown: offer.shown,
      action: same(offer.tapped.text, sent) ? "tapped" : "tapped_edited",
      tappedIndex: offer.tapped.index,
      sentText: sent,
    };
  }
  const matched = offer.shown.findIndex((s) => same(s, sent));
  if (matched >= 0) {
    return { runId: offer.runId, shown: offer.shown, action: "tapped", tappedIndex: matched, sentText: sent };
  }
  return { runId: offer.runId, shown: offer.shown, action: "typed", sentText: sent };
}

export const useAgentSuggestStore = create<AgentSuggestState>((set, get) => ({
  byThread: {},
  pendingByThread: {},
  offerByThread: {},

  setSuggestions: (threadId, suggestions) =>
    set((s) => {
      const next = { ...s.byThread };
      if (suggestions.length > 0) next[threadId] = suggestions;
      else delete next[threadId];
      return { byThread: next };
    }),

  clear: (threadId) =>
    set((s) => {
      if (!(threadId in s.byThread)) return s;
      return { byThread: without(s.byThread, threadId) };
    }),

  startRun: (threadId, runId) =>
    set((s) => ({
      pendingByThread: { ...s.pendingByThread, [threadId]: runId },
      byThread: without(s.byThread, threadId),
      offerByThread: without(s.offerByThread, threadId),
    })),

  finishRun: (threadId, runId, suggestions) =>
    set((s) => {
      if (s.pendingByThread[threadId] !== runId) return s;
      const pendingByThread = without(s.pendingByThread, threadId);
      if (suggestions.length === 0) return { pendingByThread };
      return {
        pendingByThread,
        byThread: { ...s.byThread, [threadId]: suggestions },
        offerByThread: { ...s.offerByThread, [threadId]: { runId, shown: suggestions } },
      };
    }),

  failRun: (threadId, runId) =>
    set((s) =>
      s.pendingByThread[threadId] === runId
        ? { pendingByThread: without(s.pendingByThread, threadId) }
        : s,
    ),

  markTapped: (threadId, index, text) =>
    set((s) => {
      const offer = s.offerByThread[threadId];
      if (!offer) return s;
      return {
        offerByThread: { ...s.offerByThread, [threadId]: { ...offer, tapped: { index, text } } },
      };
    }),

  takeOutcome: (threadId, sentText) => {
    const s = get();
    const offer = s.offerByThread[threadId];
    const pending = s.pendingByThread[threadId];
    if (!offer && !pending) return null;
    set({
      offerByThread: without(s.offerByThread, threadId),
      pendingByThread: without(s.pendingByThread, threadId),
      byThread: without(s.byThread, threadId),
    });
    if (offer) return classifyOutcome(offer, sentText);
    return { runId: pending!, shown: [], action: "sent_before_ready", sentText: sentText.trim() };
  },
}));
