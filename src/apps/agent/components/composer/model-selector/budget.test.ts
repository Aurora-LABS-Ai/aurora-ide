import { describe, expect, it } from "vitest";

import {
  BUDGET_FLOOR,
  budgetPresets,
  budgetRange,
  posToTokens,
  shortTokens,
  tokensToPos,
} from "./budget";

describe("thinking budget maths", () => {
  it("keeps the ceiling strictly below the output cap", () => {
    expect(budgetRange({ type: "budget", min: 1024, max: 64_000 }, 32_000)).toEqual([1024, 31_999]);
  });

  it("floors the minimum at the provider floor", () => {
    expect(budgetRange({ type: "budget", min: 10 }, 16_000)[0]).toBe(BUDGET_FLOOR);
  });

  it("round-trips a value through the log slider within one step", () => {
    const [min, max] = [1024, 63_999];
    for (const value of [2000, 8000, 16_000, 32_000]) {
      const back = posToTokens(tokensToPos(value, min, max), min, max);
      expect(Math.abs(back - value)).toBeLessThanOrEqual(1000);
    }
  });

  it("offers the floor, up to three stops inside the range, and Max", () => {
    const presets = budgetPresets(1024, 31_999);
    expect(presets.map((p) => p.label)).toEqual(["1k", "4k", "8k", "16k", "Max"]);
    expect(presets.at(-1)?.value).toBe(31_999);
  });

  it("abbreviates token counts", () => {
    expect(shortTokens(16_000)).toBe("16k");
    expect(shortTokens(1500)).toBe("1.5k");
    expect(shortTokens(800)).toBe("800");
  });
});
