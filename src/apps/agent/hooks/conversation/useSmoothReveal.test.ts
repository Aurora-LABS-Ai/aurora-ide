import { describe, expect, it } from "vitest";

import { revealAdvance } from "@/apps/agent/hooks/conversation/useSmoothReveal";

/** Walk the reveal to completion, returning how long it took in ms. */
function timeToReveal(total: number, frameMs: number): number {
  let shown = 0;
  let elapsed = 0;
  // Bounded so a regression that stalls fails the test instead of hanging it.
  for (let i = 0; i < 100_000 && shown < total; i++) {
    shown += revealAdvance(total - shown, frameMs);
    elapsed += frameMs;
  }
  return elapsed;
}

describe("revealAdvance", () => {
  it("reveals at the same SPEED regardless of frame rate", () => {
    // The bug: the advance was a flat 20% of the gap per FRAME, so a machine
    // at 30fps revealed text at half the speed of one at 60fps — and a fast
    // model, which is exactly when frames drop, fell further behind the harder
    // the UI worked. Wall-clock time to reveal must now be frame-independent.
    const at120 = timeToReveal(4000, 1000 / 120);
    const at60 = timeToReveal(4000, 1000 / 60);
    const at30 = timeToReveal(4000, 1000 / 30);

    expect(at60).toBeGreaterThan(0);
    // Within 25% across a 4x frame-rate range. Exactness is impossible — the
    // 2-char floor and integer rounding both quantise the tail.
    for (const [label, value] of [
      ["120fps", at120],
      ["30fps", at30],
    ] as const) {
      const drift = Math.abs(value - at60) / at60;
      expect(drift, `${label} drifted ${(drift * 100).toFixed(0)}% from 60fps`).toBeLessThan(0.25);
    }
  });

  it("closes about a fifth of the gap in one 60fps frame", () => {
    // The tuned feel, preserved: big steps when far behind, gentle at the tail.
    expect(revealAdvance(1000, 1000 / 60)).toBe(200);
  });

  it("never advances by less than two characters", () => {
    // Without a floor the tail converges asymptotically and the last few
    // characters never arrive.
    expect(revealAdvance(3, 1000 / 60)).toBeGreaterThanOrEqual(2);
    expect(revealAdvance(1, 1000 / 60)).toBe(1);
  });

  it("never advances past the end", () => {
    // Note this is `<=`, not `== remaining`: the stall clamp below means even
    // a huge frame delta only closes part of the gap, which is deliberate.
    for (const remaining of [1, 2, 5, 50, 5000]) {
      for (const frame of [8, 16, 33, 100, 10_000]) {
        const advance = revealAdvance(remaining, frame);
        expect(advance).toBeGreaterThan(0);
        expect(advance).toBeLessThanOrEqual(remaining);
      }
    }
    expect(revealAdvance(0, 16)).toBe(0);
    expect(revealAdvance(-4, 16)).toBe(0);
  });

  it("clamps a long stall instead of dumping the backlog", () => {
    // A backgrounded tab or GC pause can leave a multi-second hole. Scaling by
    // the raw delta would reveal everything in one frame — the lurch the whole
    // hook exists to prevent.
    const afterStall = revealAdvance(10_000, 5_000);
    const afterCap = revealAdvance(10_000, 100);
    expect(afterStall).toBe(afterCap);
    expect(afterStall).toBeLessThan(10_000);
  });

  it("treats a negative or zero frame time as harmless", () => {
    // A backwards clock must not produce a negative or NaN advance.
    expect(revealAdvance(500, 0)).toBeGreaterThanOrEqual(2);
    expect(revealAdvance(500, -50)).toBeGreaterThanOrEqual(2);
    expect(Number.isFinite(revealAdvance(500, Number.NaN))).toBe(true);
  });
});
