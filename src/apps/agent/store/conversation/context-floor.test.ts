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

/** A stored floor, in the shape the record holds. */
const floor = (tokens: number, model = "prov:model-a") => ({ model, tokens });

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
    const next = raiseContextFloor({}, T, usage({ promptTokens: 14_161 }), "prov:model-a");
    expect(next[T]).toEqual(floor(14_161));
  });

  it("raises the floor when the conversation grows", () => {
    const next = raiseContextFloor(
      { [T]: floor(14_161) },
      T,
      usage({ promptTokens: 15_000 }),
      "prov:model-a",
    );
    expect(next[T]).toEqual(floor(15_000));
  });

  it("ignores the low band — the same request measured smaller by another backend", () => {
    const next = raiseContextFloor(
      { [T]: floor(14_161) },
      T,
      usage({ promptTokens: 12_802 }),
      "prov:model-a",
    );
    expect(next[T]).toEqual(floor(14_161));
  });

  it("returns the same record when nothing moved, so the card does not repaint", () => {
    const before = { [T]: floor(14_161) };
    expect(raiseContextFloor(before, T, usage({ promptTokens: 12_802 }), "prov:model-a")).toBe(
      before,
    );
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
    const next = raiseContextFloor(
      { [T]: floor(14_161) },
      "thread-2",
      usage({ promptTokens: 500 }),
      "prov:model-a",
    );
    expect(next[T]).toEqual(floor(14_161));
    expect(next["thread-2"]).toEqual(floor(500));
  });
});

/**
 * The floor is a comparison, and a comparison needs both readings to come from
 * the same ruler.
 *
 * Thread `c4669acf`, 2026-09-05, verbatim from the session on disk:
 * `opencode-go:qwen3.8-max` peaked at 189,897 tokens; the user switched to
 * `zai-org/GLM-5.3-Flash`, whose first reading was 122,746 and which then
 * climbed one request at a time. Because the floor was keyed by thread alone,
 * `Math.max` returned 189,897 for the next 71 assistant messages — about
 * twenty-five minutes in which the ring never moved a pixel — and only
 * released on the session's final exchange. The user's report: "as I switch
 * model the context ring stopped filling at all."
 */
describe("a model switch ends the comparison", () => {
  it("drops the old model's peak instead of carrying it", () => {
    const next = raiseContextFloor(
      { [T]: floor(189_897, "opencode-go:qwen3.8-max") },
      T,
      usage({ promptTokens: 122_746 }),
      "prov:zai-org/GLM-5.3-Flash",
    );
    expect(next[T]).toEqual(floor(122_746, "prov:zai-org/GLM-5.3-Flash"));
  });

  it("still floors the new model against its OWN readings", () => {
    // The reason the floor exists has not gone away — it just applies within
    // one model. Same gateway fan-out, now under GLM.
    const after = raiseContextFloor(
      { [T]: floor(122_746, "prov:glm") },
      T,
      usage({ promptTokens: 120_000 }),
      "prov:glm",
    );
    expect(after[T]).toEqual(floor(122_746, "prov:glm"));
  });

  it("treats an unnamed model as no evidence, and keeps the floor", () => {
    // The estimate path calls without a model. "I don't know" must not read as
    // "it changed", or a single silent provider would wipe a good floor.
    const before = { [T]: floor(189_897, "opencode-go:qwen3.8-max") };
    expect(raiseContextFloor(before, T, usage({ promptTokens: 500 }))).toBe(before);
  });

  it("adopts the model on a floor that predates this record shape", () => {
    // A floor recorded before the model travelled with it has `undefined`, and
    // must not be read as a switch on the very next request.
    const next = raiseContextFloor(
      { [T]: { model: undefined, tokens: 14_161 } },
      T,
      usage({ promptTokens: 12_802 }),
      "prov:model-a",
    );
    expect(next[T]).toEqual(floor(14_161));
  });
});
