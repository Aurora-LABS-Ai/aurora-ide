/**
 * Agent Window — live context-usage and cost store (per thread).
 *
 * Three distinct facts live here, because the card shows three and they are
 * NOT the same number:
 *
 * 1. `byThread` — the MOST RECENT API response's usage. This is what the
 *    context ring measures: every request resends the whole history, so the
 *    last response's `input_tokens` is exactly how full the window is now. It
 *    is deliberately overwritten per request.
 *
 * 2. `liveTurnByThread` — usage ACCUMULATED across the requests of the turn
 *    that is currently streaming, grouped by model. A turn makes one request
 *    per tool iteration, so the running cost of a long turn only exists if
 *    something adds them up. Reset when a turn begins.
 *
 * 3. `breakdownByThread` — the whole conversation's cost basis, read back
 *    from the session transcript by Rust (`thread_usage_breakdown`). This is
 *    the authority: it survives a reload, a second window and a crash
 *    mid-turn, none of which a frontend running total would.
 *
 * 4. `cacheByThread` — the last request that actually SAID something about
 *    cache, kept separately from 1 precisely because it must not be
 *    overwritten by a request that said nothing. See the field's own note.
 *
 * Conflating 1 with 2 is the bug this replaces: "Turn cost" was rendered from
 * the last request alone, so a thirty-minute turn with twenty tool iterations
 * reported the price of iteration twenty.
 */

import { create } from "zustand";

import { auroraInvoke } from "@/kernel/lib/ipc/runtime";
import type { TokenUsage } from "@/apps/agent/services";
import type { ModelUsageGroup, ThreadUsageBreakdown } from "@/apps/agent/lib/cost/cost";

/** Fold one request's usage into a per-model accumulator. */
function accumulate(
  groups: ModelUsageGroup[],
  model: string | undefined,
  usage: TokenUsage,
): ModelUsageGroup[] {
  const next = groups.map((g) => ({ ...g }));
  // Split on whether the PROVIDER priced this request, mirroring the Rust
  // aggregator. A group must be entirely reported or entirely computed, or
  // the reported dollars would sit beside tokens that also get priced.
  const reported = typeof usage.costUsd === "number";
  let slot = next.find(
    (g) => g.model === model && (typeof g.reportedCostUsd === "number") === reported,
  );
  if (!slot) {
    slot = {
      model,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      requests: 0,
      estimatedRequests: 0,
      ...(reported ? { reportedCostUsd: 0 } : {}),
    };
    next.push(slot);
  }
  if (typeof usage.costUsd === "number") {
    slot.reportedCostUsd = (slot.reportedCostUsd ?? 0) + usage.costUsd;
  }
  slot.inputTokens += usage.promptTokens ?? 0;
  slot.outputTokens += usage.completionTokens ?? 0;
  slot.cacheReadTokens += usage.cacheReadTokens ?? 0;
  slot.cacheWriteTokens += usage.cacheWriteTokens ?? 0;
  slot.requests += 1;
  if (usage.estimated === true) slot.estimatedRequests += 1;
  return next;
}

/**
 * What the last cache-reporting request said, per thread.
 *
 * Kept apart from the raw usage record on purpose. The context ring sizes the
 * window from `byThread`, and that arithmetic must only ever add up fields the
 * SAME request reported — folding a carried-over cache read into it would
 * count 70k tokens twice and make the bar jump. This record answers a
 * different question ("is prompt caching working on this chat?"), and that
 * answer does not stop being true the instant one response omits the field.
 */
export interface CacheReading {
  /** Prompt tokens served from cache. `0` is a real answer: the cache missed. */
  readTokens: number;
  /** Prompt tokens written INTO the cache by this request. */
  writeTokens: number;
  /** Fresh (uncached) prompt tokens, so the row can show a denominator. */
  promptTokens: number;
  /**
   * False once a later response has come back carrying no cache telemetry at
   * all. The numbers stay — they were true when measured — but the card stops
   * presenting them as a description of the newest request.
   */
  fresh: boolean;
}

/**
 * Did this response say anything about cache?
 *
 * The distinction the whole fix rests on. `cacheReadTokens: 0` is the provider
 * telling us the cache missed; `cacheReadTokens: undefined` is the provider
 * telling us nothing. The adapters preserve that difference on the wire
 * (`Option<u32>` → `number | undefined`); collapsing it with `?? 0` at the
 * point of use is what made a miss and a silence render identically.
 */
const reportsCache = (usage: TokenUsage): boolean =>
  typeof usage.cacheReadTokens === "number" ||
  typeof usage.cacheWriteTokens === "number";

/**
 * Fold one response into the thread's cache reading.
 *
 * Reported → replace, marked fresh. Silent → keep what we had and mark it
 * carried. Never deletes: a row that vanishes mid-turn and returns a few
 * seconds later reads as a bug in the card, not as news about the provider.
 */
export function foldCacheReading(
  record: Record<string, CacheReading>,
  threadId: string,
  usage: TokenUsage,
): Record<string, CacheReading> {
  if (reportsCache(usage)) {
    return {
      ...record,
      [threadId]: {
        readTokens: usage.cacheReadTokens ?? 0,
        writeTokens: usage.cacheWriteTokens ?? 0,
        promptTokens: usage.promptTokens ?? 0,
        fresh: true,
      },
    };
  }
  const prev = record[threadId];
  // Nothing to carry, or already carried — return the same object so the
  // store does not publish a new reference and re-render the card for nothing.
  if (!prev || !prev.fresh) return record;
  return { ...record, [threadId]: { ...prev, fresh: false } };
}

/**
 * How full the window was on one request — every slice of it.
 *
 * The three input fields are disjoint: Anthropic reports fresh, cache-write
 * and cache-read separately, and Aurora's OpenAI adapters subtract the cache
 * hit out of `prompt_tokens` so the same sum holds there. Output counts too,
 * because the reply is re-sent as input on the very next request.
 */
export function measuredContextTokens(usage: TokenUsage): number {
  return (
    (usage.promptTokens ?? 0) +
    (usage.cacheWriteTokens ?? 0) +
    (usage.cacheReadTokens ?? 0) +
    (usage.completionTokens ?? 0)
  );
}

/**
 * A thread's high-water context reading, and the model that measured it.
 *
 * The model is half the reading. A token count only means something next to
 * the tokenizer that produced it, so a floor without one is a number with no
 * units — see {@link raiseContextFloor}.
 */
export interface ContextFloor {
  /** `providerId:modelKey`, or `undefined` when the turn did not name one. */
  model: string | undefined;
  tokens: number;
}

/**
 * Raise a thread's high-water context reading, never lower it — for as long as
 * the same model is doing the measuring.
 *
 * Between compactions the request only ever grows — every turn appends — so a
 * measurement that comes back SMALLER than the one before it did not observe
 * the context shrinking. It observed a provider counting differently.
 * Gateways that fan one model out across several upstream accounts do this
 * routinely: the same bytes measured 12,802 tokens on one backend and 14,161
 * on another, byte-for-byte identical request, split cleanly by which one
 * served it. Rendering whichever arrived last made the ring jump between
 * those two bands every few requests — the card "never settling" — and on the
 * low band it under-stated how full the window was, which is the direction
 * that ends in the provider rejecting the next request.
 *
 * **Switching model ends the comparison.** Two models do not share a
 * tokenizer, a window, or a way of counting cache, so the old model's peak
 * says nothing about how full the new model's window is — and being a
 * high-water mark, it wins every `Math.max` until the new model happens to
 * exceed it. Measured, on thread `c4669acf` (2026-09-05): qwen3.8-max peaked
 * at 189,897, the user switched to GLM-5.3-Flash, which reported 122,746 and
 * climbed. The ring showed 189,897 for the next 71 messages — twenty-five
 * minutes of a gauge that had visibly stopped working — and only moved again
 * on the session's last exchange. So the floor is dropped, not carried, when
 * the model changes: the first reading from the new model is its own floor.
 *
 * A turn that does not name its model leaves the floor alone rather than
 * clearing it — "unknown" is not evidence of a switch.
 *
 * Also reset by a compaction (which genuinely does shrink the context) and by
 * a rewind. An ESTIMATED usage never raises the floor, for the same reason
 * Rust refuses to anchor on one: it is Aurora's own guess, and laundering it
 * into a floor would make every later real measurement look small.
 *
 * Returns the same record when nothing moved, so the store does not publish a
 * new reference and re-render the card for nothing.
 */
export function raiseContextFloor(
  record: Record<string, ContextFloor>,
  threadId: string,
  usage: TokenUsage,
  model?: string,
): Record<string, ContextFloor> {
  if (usage.estimated === true) return record;
  const measured = measuredContextTokens(usage);
  const prev = record[threadId];
  if (prev === undefined) return { ...record, [threadId]: { model, tokens: measured } };

  // A different model is a different ruler. Its first reading is its own
  // floor, however far below the old model's peak it lands.
  if (model !== undefined && prev.model !== undefined && prev.model !== model) {
    return { ...record, [threadId]: { model, tokens: measured } };
  }

  if (measured <= prev.tokens) {
    // Same reading, but now we know who took it. Adopting the name costs one
    // repaint and makes the NEXT switch visible; a floor that never learns its
    // model can never notice it changed.
    if (model !== undefined && prev.model === undefined) {
      return { ...record, [threadId]: { model, tokens: prev.tokens } };
    }
    return record;
  }
  return { ...record, [threadId]: { model: model ?? prev.model, tokens: measured } };
}

interface AgentContextState {
  /** Latest API response's usage per thread — the context ring's input. */
  byThread: Record<string, TokenUsage>;
  /** Requests accumulated during the in-flight turn, grouped by model. */
  liveTurnByThread: Record<string, ModelUsageGroup[]>;
  /** Whole-conversation cost basis, read from the transcript. */
  breakdownByThread: Record<string, ThreadUsageBreakdown>;
  /**
   * Last cache telemetry each thread received, surviving responses that carry
   * none. See {@link CacheReading} and {@link foldCacheReading}.
   */
  cacheByThread: Record<string, CacheReading>;
  /**
   * Aurora's own projection of the next request's size, set when a compaction
   * has just rewritten the context and no measured request covers the new
   * shape yet.
   *
   * Deliberately NOT written into {@link byThread}. That record is what the
   * PROVIDER reported, and stamping our own arithmetic into it — flagged
   * `estimated` — made the ring announce "this provider didn't report token
   * usage" one second after it had, and wiped the cache-hit telemetry with it.
   * A projection is a different claim from a missing measurement and has to
   * live somewhere else to be said honestly. Cleared by the next real usage.
   */
  projectedByThread: Record<string, number>;
  /**
   * Largest context reading a thread has had since its last compaction, and
   * the model that measured it. See {@link raiseContextFloor} for why the
   * newest reading is not enough on its own, and why the model has to travel
   * with it.
   */
  contextFloorByThread: Record<string, ContextFloor>;
  /**
   * Threads whose stored breakdown no longer matches the transcript (a turn
   * finished since it was read). Re-fetched lazily when the card next opens,
   * so a background turn on another chat costs nothing until you look.
   */
  staleBreakdowns: Record<string, true>;

  /**
   * Record the latest response's usage (called from `onUsage`).
   *
   * `model` is the one running this turn. It is what lets the high-water
   * reading tell "the same conversation got bigger" apart from "a different
   * model counted it" — see {@link raiseContextFloor}.
   */
  setUsage: (threadId: string, usage: TokenUsage, model?: string) => void;
  /** Record the post-compaction projection (see {@link projectedByThread}). */
  setProjectedUsage: (threadId: string, tokens: number) => void;
  /**
   * Forget the high-water context reading — the transcript genuinely shrank.
   * Called on rewind; compaction goes through {@link setProjectedUsage}.
   */
  resetContextFloor: (threadId: string) => void;
  /** Start a fresh turn accumulator. */
  beginTurn: (threadId: string) => void;
  /** Add one API response to the in-flight turn's running cost. */
  addTurnUsage: (threadId: string, model: string | undefined, usage: TokenUsage) => void;
  /** Mark a thread's stored breakdown as out of date. */
  invalidateBreakdown: (threadId: string) => void;
  /** Read the breakdown from the transcript unless a fresh copy is held. */
  loadBreakdown: (threadId: string, force?: boolean) => Promise<void>;
  /** Drop everything for a thread (e.g. on delete). */
  clear: (threadId: string) => void;
}

const dropKey = <T,>(record: Record<string, T>, key: string): Record<string, T> => {
  if (!(key in record)) return record;
  const next = { ...record };
  delete next[key];
  return next;
};

export const useAgentContextStore = create<AgentContextState>((set, get) => ({
  byThread: {},
  liveTurnByThread: {},
  breakdownByThread: {},
  staleBreakdowns: {},
  projectedByThread: {},
  cacheByThread: {},
  contextFloorByThread: {},

  setUsage: (threadId, usage, model) =>
    set((s) => ({
      byThread: { ...s.byThread, [threadId]: usage },
      cacheByThread: foldCacheReading(s.cacheByThread, threadId, usage),
      contextFloorByThread: raiseContextFloor(s.contextFloorByThread, threadId, usage, model),
      // A measurement supersedes a projection — the request the projection
      // was anticipating has now actually happened and been counted.
      projectedByThread: dropKey(s.projectedByThread, threadId),
    })),

  setProjectedUsage: (threadId, tokens) =>
    set((s) => ({
      projectedByThread: { ...s.projectedByThread, [threadId]: tokens },
      // A compaction is the one thing that genuinely makes the next request
      // smaller, so the high-water reading from before it describes a context
      // that no longer exists.
      contextFloorByThread: dropKey(s.contextFloorByThread, threadId),
    })),

  resetContextFloor: (threadId) =>
    set((s) => ({ contextFloorByThread: dropKey(s.contextFloorByThread, threadId) })),

  beginTurn: (threadId) =>
    set((s) => ({ liveTurnByThread: { ...s.liveTurnByThread, [threadId]: [] } })),

  addTurnUsage: (threadId, model, usage) =>
    set((s) => ({
      liveTurnByThread: {
        ...s.liveTurnByThread,
        [threadId]: accumulate(s.liveTurnByThread[threadId] ?? [], model, usage),
      },
    })),

  invalidateBreakdown: (threadId) =>
    set((s) => ({ staleBreakdowns: { ...s.staleBreakdowns, [threadId]: true } })),

  loadBreakdown: async (threadId, force = false) => {
    const state = get();
    if (!force && state.breakdownByThread[threadId] && !state.staleBreakdowns[threadId]) {
      return;
    }
    try {
      const breakdown = await auroraInvoke<ThreadUsageBreakdown | null>(
        "thread_usage_breakdown",
        { threadId },
      );
      if (!breakdown) return;
      set((s) => ({
        breakdownByThread: { ...s.breakdownByThread, [threadId]: breakdown },
        staleBreakdowns: dropKey(s.staleBreakdowns, threadId),
      }));
    } catch (err) {
      // Non-fatal: the card falls back to showing only what it can measure
      // live. Never swallow silently — a missing cost total that nobody can
      // explain is exactly the shape of problem this work exists to fix.
      console.warn("[agent-cost] thread_usage_breakdown failed:", err);
    }
  },

  clear: (threadId) =>
    set((s) => ({
      byThread: dropKey(s.byThread, threadId),
      liveTurnByThread: dropKey(s.liveTurnByThread, threadId),
      breakdownByThread: dropKey(s.breakdownByThread, threadId),
      staleBreakdowns: dropKey(s.staleBreakdowns, threadId),
      projectedByThread: dropKey(s.projectedByThread, threadId),
      cacheByThread: dropKey(s.cacheByThread, threadId),
      contextFloorByThread: dropKey(s.contextFloorByThread, threadId),
    })),
}));
