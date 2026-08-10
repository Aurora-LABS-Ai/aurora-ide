import { describe, expect, it } from "vitest";

import {
  formatCost,
  formatRequestCount,
  hasCost,
  modelLabel,
  priceUsage,
  type ModelPrices,
  type ModelUsageGroup,
} from "@/apps/agent/lib/cost/cost";

/** A group with everything zeroed unless the test says otherwise. */
const group = (over: Partial<ModelUsageGroup> = {}): ModelUsageGroup => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  requests: 1,
  estimatedRequests: 0,
  ...over,
});

const PRICES: Record<string, ModelPrices> = {
  // $5 fresh in / $25 out / $0.50 cached in / $6.25 cache write.
  "gw:opus": {
    cacheMissPerMtok: 5,
    outputPerMtok: 25,
    cacheHitPerMtok: 0.5,
    cacheWritePerMtok: 6.25,
  },
  // Cheap model, no cache rates configured — both must fall back to $0.30.
  "gw:mini": { cacheMissPerMtok: 0.3, outputPerMtok: 1.2 },
};
const lookup = (m: string | undefined) => (m ? PRICES[m] ?? null : null);

describe("priceUsage", () => {
  it("prices every line of a single model's usage", () => {
    const out = priceUsage(
      [
        group({
          model: "gw:opus",
          inputTokens: 1_000_000,
          outputTokens: 1_000_000,
          cacheReadTokens: 1_000_000,
          cacheWriteTokens: 1_000_000,
        }),
      ],
      lookup,
    );
    expect(out.lines.freshInput).toBeCloseTo(5, 10);
    expect(out.lines.output).toBeCloseTo(25, 10);
    expect(out.lines.cachedInput).toBeCloseTo(0.5, 10);
    expect(out.lines.cacheWrite).toBeCloseTo(6.25, 10);
    expect(out.total).toBeCloseTo(36.75, 10);
  });

  it("sums MONEY across models, not tokens", () => {
    // The whole reason groups exist. Same token counts on two models with a
    // ~17x price gap: pricing the sum at either single model's rate gives a
    // number that is wrong by a factor, in one direction or the other.
    const groups = [
      group({ model: "gw:opus", inputTokens: 1_000_000, requests: 2 }),
      group({ model: "gw:mini", inputTokens: 1_000_000, requests: 3 }),
    ];
    const out = priceUsage(groups, lookup);
    expect(out.total).toBeCloseTo(5 + 0.3, 10);
    expect(out.pricedRequests).toBe(5);
    expect(out.pricedModels).toEqual(["gw:opus", "gw:mini"]);

    // Guard against the bug directly: 2M tokens priced at either single rate.
    expect(out.total).not.toBeCloseTo((2_000_000 * 5) / 1e6, 6);
    expect(out.total).not.toBeCloseTo((2_000_000 * 0.3) / 1e6, 6);
  });

  it("falls back to the fresh-input rate for unset cache prices, never to zero", () => {
    // A blank cache price meaning "free" is what made cached conversations
    // under-report. `gw:mini` sets neither cache rate.
    const out = priceUsage(
      [
        group({
          model: "gw:mini",
          cacheReadTokens: 1_000_000,
          cacheWriteTokens: 1_000_000,
        }),
      ],
      lookup,
    );
    expect(out.lines.cachedInput).toBeCloseTo(0.3, 10);
    expect(out.lines.cacheWrite).toBeCloseTo(0.3, 10);
    expect(out.total).toBeCloseTo(0.6, 10);
  });

  it("honours an explicit zero rate instead of overriding it with the fallback", () => {
    // A provider that really does not charge for cache reads must be able to
    // say so, and `0` has to survive the `??` fallback.
    const free = (): ModelPrices => ({
      cacheMissPerMtok: 5,
      outputPerMtok: 25,
      cacheHitPerMtok: 0,
    });
    const out = priceUsage([group({ model: "x", cacheReadTokens: 1_000_000 })], free);
    expect(out.lines.cachedInput).toBe(0);
  });

  it("excludes unpriced models from the total and reports them", () => {
    const out = priceUsage(
      [
        group({ model: "gw:opus", inputTokens: 1_000_000, requests: 4 }),
        group({ model: "gw:unknown-model", inputTokens: 9_000_000, requests: 6 }),
      ],
      lookup,
    );
    // The 9M unpriced tokens must NOT silently contribute $0 to a total that
    // is then presented as complete.
    expect(out.total).toBeCloseTo(5, 10);
    expect(out.pricedRequests).toBe(4);
    expect(out.unpricedRequests).toBe(6);
    expect(out.unpricedModels).toEqual(["gw:unknown-model"]);
  });

  it("treats a model priced for input but not output as unpriceable", () => {
    // A half-filled price row cannot produce a trustworthy total — output is
    // usually the larger half of the bill.
    const half = (): ModelPrices => ({ cacheMissPerMtok: 5 });
    const out = priceUsage([group({ model: "x", inputTokens: 1_000, requests: 1 })], half);
    expect(out.total).toBe(0);
    expect(out.unpricedRequests).toBe(1);
  });

  it("counts unattributed groups as unpriced without inventing a model name", () => {
    const out = priceUsage([group({ inputTokens: 5_000, requests: 2 })], lookup);
    expect(out.unpricedRequests).toBe(2);
    expect(out.unpricedModels).toEqual([]);
  });

  it("marks the total estimated when any priced group used estimates", () => {
    const out = priceUsage(
      [
        group({ model: "gw:opus", inputTokens: 1_000, requests: 1 }),
        group({ model: "gw:mini", inputTokens: 1_000, requests: 1, estimatedRequests: 1 }),
      ],
      lookup,
    );
    expect(out.estimated).toBe(true);
  });

  it("does not mark the total estimated when only an UNPRICED group was estimated", () => {
    // That group contributes nothing to the total, so the total is exact.
    const out = priceUsage(
      [
        group({ model: "gw:opus", inputTokens: 1_000, requests: 1 }),
        group({ model: "gw:nope", inputTokens: 1_000, requests: 1, estimatedRequests: 1 }),
      ],
      lookup,
    );
    expect(out.estimated).toBe(false);
  });

  it("survives malformed numbers without poisoning the total with NaN", () => {
    const out = priceUsage(
      [
        group({
          model: "gw:opus",
          inputTokens: Number.NaN,
          outputTokens: Number.POSITIVE_INFINITY,
          cacheReadTokens: -5,
        }),
      ],
      lookup,
    );
    expect(Number.isFinite(out.total)).toBe(true);
    expect(out.total).toBe(0);
  });

  it("returns a zero total for no groups", () => {
    const out = priceUsage([], lookup);
    expect(out.total).toBe(0);
    expect(hasCost(out)).toBe(false);
  });

  it("reports something worth showing when everything is unpriced", () => {
    // $0 total, but the card must still surface "6 requests not priced"
    // rather than render nothing and imply the chat was free.
    const out = priceUsage([group({ model: "gw:nope", requests: 6 })], lookup);
    expect(out.total).toBe(0);
    expect(hasCost(out)).toBe(true);
  });
});

describe("provider-reported cost", () => {
  it("uses the provider's figure verbatim and does not price the tokens", () => {
    // The tokens would price at $5 from the catalog; the provider says $0.02.
    // The provider wins — it knows about markup, BYOK and promos.
    const out = priceUsage(
      [group({ model: "gw:opus", inputTokens: 1_000_000, reportedCostUsd: 0.02 })],
      lookup,
    );
    expect(out.total).toBeCloseTo(0.02, 10);
    expect(out.lines.freshInput).toBe(0);
    expect(out.reportedTotal).toBeCloseTo(0.02, 10);
    expect(out.reportedRequests).toBe(1);
  });

  it("adds reported and computed groups without double-counting", () => {
    const out = priceUsage(
      [
        group({ model: "gw:opus", inputTokens: 1_000_000, reportedCostUsd: 0.02, requests: 1 }),
        group({ model: "gw:opus", inputTokens: 1_000_000, requests: 1 }),
      ],
      lookup,
    );
    // $0.02 reported + $5 computed. The reported group's million tokens must
    // NOT also be priced at $5.
    expect(out.total).toBeCloseTo(5.02, 10);
    expect(out.pricedRequests).toBe(2);
    expect(out.reportedRequests).toBe(1);
  });

  it("prices a reported group even when the model has no catalog pricing", () => {
    // The whole point: a provider that bills us can be trusted for its own
    // number regardless of whether we hold a rate card for the model.
    const out = priceUsage(
      [group({ model: "gw:never-heard-of-it", reportedCostUsd: 1.23, requests: 3 })],
      lookup,
    );
    expect(out.total).toBeCloseTo(1.23, 10);
    expect(out.unpricedRequests).toBe(0);
  });

  it("keeps a reported zero as zero instead of falling back to catalog rates", () => {
    // `cost: 0` is a claim that the request was free. Falling through to the
    // catalog would invent a charge the provider says it did not make.
    const out = priceUsage(
      [group({ model: "gw:opus", inputTokens: 1_000_000, reportedCostUsd: 0 })],
      lookup,
    );
    expect(out.total).toBe(0);
    expect(out.reportedRequests).toBe(1);
  });

  it("refuses a negative reported cost rather than crediting the total", () => {
    const out = priceUsage([group({ model: "gw:opus", reportedCostUsd: -5 })], lookup);
    expect(out.total).toBe(0);
  });
});

describe("the reported case", () => {
  /**
   * The owner's screenshot, reproduced exactly.
   *
   * Card showed: 255.7K input of which 251.3K cached, fresh input $0.0220,
   * cached input $0.1257, output $0.0173, turn cost $0.1650. Backing those
   * out gives $5/Mtok fresh and $0.50/Mtok cached, which is what this fixture
   * uses. The arithmetic was never wrong — it was applied to ONE request out
   * of a turn that made many, which is why $0.0173 of output could sit under
   * a turn where the model reasoned for fifteen minutes.
   */
  const SCREENSHOT_PRICES: ModelPrices = {
    cacheMissPerMtok: 5,
    cacheHitPerMtok: 0.5,
    outputPerMtok: 25,
  };
  const priced = () => SCREENSHOT_PRICES;

  it("reproduces the old per-request figure exactly", () => {
    const oneRequest = group({
      model: "gw:opus",
      inputTokens: 4_400,
      cacheReadTokens: 251_300,
      outputTokens: 692,
    });
    const out = priceUsage([oneRequest], priced);
    expect(formatCost(out.lines.freshInput)).toBe("$0.0220");
    expect(formatCost(out.lines.cachedInput)).toBe("$0.1257");
    expect(formatCost(out.lines.output)).toBe("$0.0173");
    expect(formatCost(out.total)).toBe("$0.1650");
  });

  it("reports the whole turn once every request is counted", () => {
    // Same turn, as it actually ran: 20 tool iterations, and the reasoning
    // tokens that the single-request view could never show.
    const wholeTurn = group({
      model: "gw:opus",
      inputTokens: 4_400 * 20,
      cacheReadTokens: 251_300 * 20,
      outputTokens: 60_000,
      requests: 20,
    });
    const out = priceUsage([wholeTurn], priced);
    expect(out.pricedRequests).toBe(20);
    // The point of the whole exercise: an order of magnitude apart.
    // 88_000 x $5 + 5_026_000 x $0.50 + 60_000 x $25, per million.
    expect(out.lines.freshInput).toBeCloseTo(0.44, 10);
    expect(out.lines.cachedInput).toBeCloseTo(2.513, 10);
    expect(out.lines.output).toBeCloseTo(1.5, 10);
    expect(formatCost(out.total)).toBe("$4.453");
    // The point of the whole exercise: 27x what the card used to report.
    expect(out.total / 0.165).toBeGreaterThan(25);
  });
});

describe("formatCost", () => {
  it("never rounds a real charge down to zero", () => {
    expect(formatCost(0.00004)).toBe("<$0.0001");
    expect(formatCost(0)).toBe("$0");
  });

  it("keeps four decimals where per-turn costs actually live", () => {
    expect(formatCost(0.165)).toBe("$0.1650");
    expect(formatCost(0.0173)).toBe("$0.0173");
  });

  it("sheds precision as the number grows", () => {
    expect(formatCost(6.914)).toBe("$6.914");
    expect(formatCost(284.31)).toBe("$284.31");
  });

  it("treats a negative as nothing rather than printing it", () => {
    expect(formatCost(-1)).toBe("$0");
  });
});

describe("modelLabel", () => {
  it("drops the provider id, which is a UUID for a user-added provider", () => {
    // The raw selection rendered on the cost card as
    // "6fa1043d-2c79-4867-8956-9645decd35e4:agnes-2.5-flash" — meaningless to
    // a person, and long enough to stretch the card across the window.
    expect(modelLabel("6fa1043d-2c79-4867-8956-9645decd35e4:agnes-2.5-flash")).toBe(
      "agnes-2.5-flash",
    );
    expect(modelLabel("openai:gpt-5.6-sol")).toBe("gpt-5.6-sol");
  });

  it("keeps a model key that contains colons", () => {
    // Only the FIRST colon separates provider from model; a provider id never
    // contains one but a model key can.
    expect(modelLabel("gw:openai/gpt-5.6:preview")).toBe("openai/gpt-5.6:preview");
  });

  it("returns null when there is nothing to name", () => {
    expect(modelLabel(undefined)).toBeNull();
    expect(modelLabel("")).toBeNull();
    expect(modelLabel("provider:")).toBeNull();
  });

  it("passes through a bare model key unchanged", () => {
    expect(modelLabel("gpt-5.6-sol")).toBe("gpt-5.6-sol");
  });
});

describe("formatRequestCount", () => {
  it("pluralizes both halves independently", () => {
    expect(formatRequestCount(1, 1)).toBe("1 turn · 1 request");
    expect(formatRequestCount(1, 12)).toBe("1 turn · 12 requests");
    expect(formatRequestCount(14, 41)).toBe("14 turns · 41 requests");
  });
});
