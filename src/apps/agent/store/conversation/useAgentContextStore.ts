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

interface AgentContextState {
  /** Latest API response's usage per thread — the context ring's input. */
  byThread: Record<string, TokenUsage>;
  /** Requests accumulated during the in-flight turn, grouped by model. */
  liveTurnByThread: Record<string, ModelUsageGroup[]>;
  /** Whole-conversation cost basis, read from the transcript. */
  breakdownByThread: Record<string, ThreadUsageBreakdown>;
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
   * Threads whose stored breakdown no longer matches the transcript (a turn
   * finished since it was read). Re-fetched lazily when the card next opens,
   * so a background turn on another chat costs nothing until you look.
   */
  staleBreakdowns: Record<string, true>;

  /** Record the latest response's usage (called from `onUsage`). */
  setUsage: (threadId: string, usage: TokenUsage) => void;
  /** Record the post-compaction projection (see {@link projectedByThread}). */
  setProjectedUsage: (threadId: string, tokens: number) => void;
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

  setUsage: (threadId, usage) =>
    set((s) => ({
      byThread: { ...s.byThread, [threadId]: usage },
      // A measurement supersedes a projection — the request the projection
      // was anticipating has now actually happened and been counted.
      projectedByThread: dropKey(s.projectedByThread, threadId),
    })),

  setProjectedUsage: (threadId, tokens) =>
    set((s) => ({
      projectedByThread: { ...s.projectedByThread, [threadId]: tokens },
    })),

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
    })),
}));
