import { describe, expect, it } from "vitest";

import {
  measuredContextTokens,
  raiseContextFloor,
} from "@/apps/agent/store/conversation/useAgentContextStore";
import type { TokenUsage } from "@/apps/agent/services";

/**
 * The context reading was rendered straight off the newest API response, on
 * the assumption that the newest measurement is the best one. It is not, when
 * the provider does not measure consistently.
 *
 * Measured against a live gateway: fourteen byte-identical requests came back
 * with exactly two distinct prompt sizes — 12,802 tokens whenever the backend
 * that served it did no caching, 14,161 whenever the caching one did. A 10.7%
 * step, split cleanly by routing, with nothing in between. Over a long turn
 * the ring therefore jumped between two bands every few requests while the
 * conversation itself only grew.
 *
 * The rule these pin: between compactions the request cannot get smaller, so
 * a smaller reading is noise and the largest one stands.
 */
const usage = (over: Partial<TokenUsage> = {}): TokenUsage => ({
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
  ...over,
});

const T = "thread-1";

describe("the context reading only ever grows within a compaction epoch", () => {
  it("counts every slice of the request, not just the fresh prompt", () => {
    expect(
      measuredContextTokens(
        usage({
          promptTokens: 41_273,
          cacheReadTokens: 203_213,
          cacheWriteTokens: 1_000,
          completionTokens: 39,
        }),
      ),
    ).toBe(245_525);
  });

  it("takes the first reading as the floor", () => {
    const next = raiseContextFloor({}, T, usage({ promptTokens: 14_161 }));
    expect(next[T]).toBe(14_161);
  });

  it("raises the floor when the conversation grows", () => {
    const next = raiseContextFloor({ [T]: 14_161 }, T, usage({ promptTokens: 15_000 }));
    expect(next[T]).toBe(15_000);
  });

  it("ignores the low band — the same request measured smaller by another backend", () => {
    const next = raiseContextFloor({ [T]: 14_161 }, T, usage({ promptTokens: 12_802 }));
    expect(next[T]).toBe(14_161);
  });

  it("returns the same record when nothing moved, so the card does not repaint", () => {
    const before = { [T]: 14_161 };
    expect(raiseContextFloor(before, T, usage({ promptTokens: 12_802 }))).toBe(before);
  });

  it("never lets Aurora's own estimate set the floor", () => {
    // An estimate is what a silent provider gets, and it runs low. Laundering
    // it into a floor would make every later real measurement look small.
    const before = {};
    expect(
      raiseContextFloor(before, T, usage({ promptTokens: 900_000, estimated: true })),
    ).toBe(before);
  });

  it("keeps threads apart", () => {
    const next = raiseContextFloor({ [T]: 14_161 }, "thread-2", usage({ promptTokens: 500 }));
    expect(next[T]).toBe(14_161);
    expect(next["thread-2"]).toBe(500);
  });
});
