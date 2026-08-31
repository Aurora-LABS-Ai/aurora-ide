import { describe, expect, it } from "vitest";

import { __testing } from "./models-dev";

describe("published rates", () => {
  it("treats a zero rate as unknown, not as free", () => {
    // models.dev carries a `kenari` provider whose 38 models are ALL listed at
    // `{input: 0, output: 0}` — kenari bills in Rupiah and the schema is USD,
    // so those entries hold a placeholder. Copying it through is how a paid
    // model came to show "$0 / $0" and report every conversation as free.
    expect(__testing.rate(0)).toBeUndefined();
    expect(__testing.rate(undefined)).toBeUndefined();
  });

  it("keeps a real rate exactly as published", () => {
    // Including the very small ones — a cache-read rate is often a fraction of
    // a cent per million tokens, and rounding it away would quietly stop
    // counting the cheapest half of a cached conversation.
    expect(__testing.rate(3)).toBe(3);
    expect(__testing.rate(0.0001)).toBe(0.0001);
  });

  it("never accepts a negative rate", () => {
    // Nothing published should be below zero; if it is, the entry is corrupt
    // and a negative price would subtract from the running total.
    expect(__testing.rate(-1)).toBeUndefined();
  });
});

describe("published token limits", () => {
  const entry = (providerId: string, contextWindow?: number, maxOutputTokens?: number) =>
    ({
      modelKey: "glm-5.2",
      name: "GLM 5.2",
      providerId,
      providerName: providerId,
      contextWindow,
      maxOutputTokens,
      supportsVision: false,
      supportsThinking: true,
      supportsToolStream: true,
    }) as Parameters<typeof __testing.limitsAreCoherent>[0];

  it("rejects an entry whose output limit is not smaller than its window", () => {
    // The prompt and the reply are drawn from the same window, so a model
    // cannot emit as many tokens as the whole window holds. An entry saying
    // otherwise has copied the context number into the output slot.
    expect(__testing.limitsAreCoherent(entry("neuralwatt", 1_048_560, 1_048_560))).toBe(false);
    expect(__testing.limitsAreCoherent(entry("cortecs", 1_048_576, 1_048_576))).toBe(false);
    expect(__testing.limitsAreCoherent(entry("zai", 1_000_000, 131_072))).toBe(true);
  });

  it("treats a missing limit as nothing to contradict", () => {
    // An unset field inherits; it is not a broken row.
    expect(__testing.limitsAreCoherent(entry("unknown", undefined, undefined))).toBe(true);
    expect(__testing.limitsAreCoherent(entry("unknown", 200_000, undefined))).toBe(true);
  });

  it("takes the limit the field agrees on, not whichever provider sorts first", () => {
    // The live catalogue lists glm-5.2 under 30 providers; 20 of them publish
    // output = 131,072. `neuralwatt` publishes 1,048,560 and happens to sort
    // first, and Aurora used to take exactly that — then send it as
    // `max_tokens`, which no endpoint serving the model accepts. Every turn
    // died on a 400 before a token was generated.
    const matches = [
      entry("neuralwatt", 1_048_560, 1_048_560),
      entry("zai", 1_000_000, 131_072),
      entry("alibaba", 1_000_000, 131_072),
      entry("aihubmix", 1_000_000, 128_000),
    ];
    expect(__testing.agreedLimits(matches)).toEqual({
      contextWindow: 1_000_000,
      maxOutputTokens: 131_072,
    });
  });

  it("says nothing when no entry is coherent", () => {
    // Passing on a number we have just decided is meaningless is worse than
    // leaving the field empty, which stays overridable and inherits.
    const matches = [entry("neuralwatt", 1_048_560, 1_048_560)];
    expect(__testing.agreedLimits(matches)).toEqual({});
  });

  it("breaks a tie toward the smaller limit", () => {
    // The two errors are not symmetric: a cap above what the endpoint serves
    // is a hard 400 that kills the turn, one below it costs a shorter reply.
    expect(__testing.consensus([131_072, 200_000])).toBe(131_072);
    expect(__testing.consensus([])).toBeUndefined();
  });
});
