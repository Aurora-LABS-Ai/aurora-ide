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
