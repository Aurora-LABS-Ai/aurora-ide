import { describe, expect, it } from "vitest";

import { foldCacheReading } from "@/apps/agent/store/conversation/useAgentContextStore";
import type { TokenUsage } from "@/apps/agent/services";

/**
 * The Cache hit row used to be rendered straight off the newest API response,
 * which a turn overwrites once per tool iteration. Any response that omitted
 * the cache fields blanked the row, so on a 51-request turn it flickered in
 * and out with no relation to whether caching was working — 100%, gone, 73%,
 * gone. These tests pin the two rules that fix it: a silent response never
 * erases a measured one, and a reported zero is a real reading, not a silence.
 */
const usage = (over: Partial<TokenUsage> = {}): TokenUsage => ({
  promptTokens: 1_000,
  completionTokens: 100,
  totalTokens: 1_100,
  ...over,
});

const T = "thread-1";

describe("folding cache telemetry across a turn", () => {
  it("records what a reporting response said", () => {
    const next = foldCacheReading({}, T, usage({ cacheReadTokens: 72_900 }));
    expect(next[T]).toEqual({
      readTokens: 72_900,
      writeTokens: 0,
      promptTokens: 1_000,
      fresh: true,
    });
  });

  it("keeps the numbers when the next response says nothing about cache", () => {
    let rec = foldCacheReading({}, T, usage({ cacheReadTokens: 72_900 }));
    rec = foldCacheReading(rec, T, usage({ promptTokens: 100_000 }));
    // The row must not vanish — it just stops claiming to describe *this*
    // request. Losing the value is what made the card look broken.
    expect(rec[T].readTokens).toBe(72_900);
    expect(rec[T].fresh).toBe(false);
  });

  it("treats a reported zero as a reading, not as silence", () => {
    let rec = foldCacheReading({}, T, usage({ cacheReadTokens: 72_900 }));
    rec = foldCacheReading(rec, T, usage({ cacheReadTokens: 0 }));
    // "The cache missed" is news, and it outranks the older hit.
    expect(rec[T]).toEqual({
      readTokens: 0,
      writeTokens: 0,
      promptTokens: 1_000,
      fresh: true,
    });
  });

  it("counts a cache WRITE as telemetry too", () => {
    // Anthropic's first request after a prefix change writes the cache and
    // reads nothing. That response is reporting, not silent.
    const rec = foldCacheReading({}, T, usage({ cacheWriteTokens: 50_000 }));
    expect(rec[T]).toEqual({
      readTokens: 0,
      writeTokens: 50_000,
      promptTokens: 1_000,
      fresh: true,
    });
  });

  it("stays silent for a provider that never reports cache at all", () => {
    const rec = foldCacheReading({}, T, usage());
    // No record means no row — unchanged from before, and correct: we have
    // nothing to say about a provider that has told us nothing.
    expect(rec[T]).toBeUndefined();
  });

  it("returns the same object when nothing changed", () => {
    const first = foldCacheReading({}, T, usage({ cacheReadTokens: 10 }));
    const carried = foldCacheReading(first, T, usage());
    const again = foldCacheReading(carried, T, usage());
    // Already carried and still silent — publishing a new reference here
    // would re-render the card on every request for no new information.
    expect(again).toBe(carried);
  });

  it("does not leak one thread's reading into another", () => {
    let rec = foldCacheReading({}, "a", usage({ cacheReadTokens: 500 }));
    rec = foldCacheReading(rec, "b", usage({ cacheReadTokens: 900 }));
    rec = foldCacheReading(rec, "b", usage());
    expect(rec.a).toEqual({
      readTokens: 500,
      writeTokens: 0,
      promptTokens: 1_000,
      fresh: true,
    });
    expect(rec.b.fresh).toBe(false);
  });

  it("survives a long turn of alternating reporting and silent responses", () => {
    // The shape of the bug, replayed: the row must be present at every step.
    let rec: ReturnType<typeof foldCacheReading> = {};
    const reads = [100_000, undefined, 72_900, undefined, undefined, 81_000];
    for (const r of reads) {
      rec = foldCacheReading(
        rec,
        T,
        usage(r === undefined ? {} : { cacheReadTokens: r }),
      );
      expect(rec[T]).toBeDefined();
      expect(rec[T].readTokens).toBeGreaterThan(0);
    }
    expect(rec[T]).toEqual({
      readTokens: 81_000,
      writeTokens: 0,
      promptTokens: 1_000,
      fresh: true,
    });
  });
});
