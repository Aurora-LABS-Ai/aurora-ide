import { describe, expect, it } from "vitest";

import {
  USE_HALF_LIFE_MS,
  bumpUsage,
  frecency,
  parseModelUsage,
  rankByUsage,
  type ModelUsage,
} from "./model-usage";

const T0 = 1_700_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

/** Build a history by replaying picks at explicit times. */
function history(picks: Array<[key: string, at: number]>): Record<string, ModelUsage> {
  return picks.reduce<Record<string, ModelUsage>>(
    (acc, [key, at]) => bumpUsage(acc, key, at),
    {},
  );
}

describe("model usage frecency", () => {
  it("ranks a habit above a single newer pick — the bug this replaced", () => {
    // The old strip sorted on last-used alone, so `tried-once` (touched most
    // recently) beat `daily-driver` and the models actually in use fell off.
    const usage = history([
      ...Array.from({ length: 10 }, (_, i): [string, number] => [
        "daily-driver",
        T0 + i * DAY,
      ]),
      ["tried-once", T0 + 10 * DAY + 1],
    ]);
    const now = T0 + 10 * DAY + 2;

    expect(usage["tried-once"].last).toBeGreaterThan(usage["daily-driver"].last);
    expect(rankByUsage(["tried-once", "daily-driver"], usage, now, 5)).toEqual([
      "daily-driver",
      "tried-once",
    ]);
  });

  it("still lets recency win when the habit is equally strong", () => {
    const usage = history([
      ["older", T0],
      ["newer", T0 + DAY],
    ]);
    expect(rankByUsage(["older", "newer"], usage, T0 + DAY, 5)).toEqual(["newer", "older"]);
  });

  it("halves a score after exactly one half-life", () => {
    const usage = history([["m", T0]]);
    expect(frecency(usage["m"], T0)).toBeCloseTo(1, 10);
    expect(frecency(usage["m"], T0 + USE_HALF_LIFE_MS)).toBeCloseTo(0.5, 10);
    expect(frecency(usage["m"], T0 + 2 * USE_HALF_LIFE_MS)).toBeCloseTo(0.25, 10);
  });

  it("lets an abandoned model fall behind one in current use", () => {
    // Heavy use, then nothing for three half-lives, versus a couple of recent picks.
    let usage = history(
      Array.from({ length: 8 }, (_, i): [string, number] => ["abandoned", T0 + i * 1000]),
    );
    const now = T0 + 3 * USE_HALF_LIFE_MS;
    usage = bumpUsage(usage, "current", now - DAY);
    usage = bumpUsage(usage, "current", now);

    expect(rankByUsage(["abandoned", "current"], usage, now, 5)).toEqual([
      "current",
      "abandoned",
    ]);
  });

  it("decays what is already stored before adding a new use", () => {
    // Two picks a half-life apart are worth 1.5, not 2 — otherwise old activity
    // would never lose ground and the strip could never re-sort.
    const usage = history([
      ["m", T0],
      ["m", T0 + USE_HALF_LIFE_MS],
    ]);
    expect(usage["m"].score).toBeCloseTo(1.5, 10);
    expect(usage["m"].uses).toBe(2);
  });

  it("never ranks a model that was never picked, and honours the limit", () => {
    const usage = history([
      ["a", T0],
      ["b", T0],
      ["c", T0],
    ]);
    expect(rankByUsage(["a", "b", "c", "unpicked"], usage, T0, 5)).not.toContain("unpicked");
    expect(rankByUsage(["a", "b", "c"], usage, T0, 2)).toHaveLength(2);
  });

  it("reads the legacy timestamp map instead of resetting the strip", () => {
    // The key used to hold `"provider:model": <ms epoch>`.
    const migrated = parseModelUsage({ "openai:gpt-5.6": T0, "openai:gpt-4o": T0 - DAY });
    expect(migrated["openai:gpt-5.6"]).toEqual({ score: 1, last: T0, uses: 1 });
    expect(rankByUsage(["openai:gpt-4o", "openai:gpt-5.6"], migrated, T0, 5)).toEqual([
      "openai:gpt-5.6",
      "openai:gpt-4o",
    ]);
  });

  it("drops junk entries rather than letting them poison the ranking", () => {
    const parsed = parseModelUsage({
      good: { score: 2, last: T0, uses: 2 },
      nan: { score: Number.NaN, last: T0, uses: 1 },
      negative: -5,
      wrongType: "nope",
      nested: null,
    });
    expect(Object.keys(parsed)).toEqual(["good"]);
  });

  it("survives a non-object payload", () => {
    expect(parseModelUsage(null)).toEqual({});
    expect(parseModelUsage("garbage")).toEqual({});
    expect(parseModelUsage(42)).toEqual({});
  });
});
