import { describe, expect, it } from "vitest";

import {
  ARRIVAL_MAX_DELAY_MS,
  ARRIVAL_STEP_MS,
  createArrivalStagger,
} from "@/apps/agent/components/tools/tool-arrival";

describe("tool arrival stagger", () => {
  it("rolls a batch that lands in one frame in 40ms apart", () => {
    const stagger = createArrivalStagger();
    const delays = [0, 1, 2, 3].map(() => stagger.next(1000));
    expect(delays).toEqual([0, ARRIVAL_STEP_MS, 2 * ARRIVAL_STEP_MS, 3 * ARRIVAL_STEP_MS]);
  });

  it("never makes a step wait longer than the cap, however large the batch", () => {
    // 11 is the largest batch in the measured sessions.
    const stagger = createArrivalStagger();
    const delays = Array.from({ length: 11 }, () => stagger.next(1000));
    expect(Math.max(...delays)).toBe(ARRIVAL_MAX_DELAY_MS);
    // Still in order: nothing capped jumps ahead of the step before it.
    for (let i = 1; i < delays.length; i++) expect(delays[i]).toBeGreaterThanOrEqual(delays[i - 1]);
  });

  it("gives a call that arrives on its own no delay at all", () => {
    const stagger = createArrivalStagger();
    stagger.next(1000);
    expect(stagger.next(1000 + 500)).toBe(0);
  });

  it("only delays a call by what is left of the previous slot", () => {
    const stagger = createArrivalStagger();
    stagger.next(1000);
    // Arrives 25ms after the first: the slot opens 40ms after it, so 15ms left.
    expect(stagger.next(1025)).toBe(15);
  });
});
