import { describe, expect, it } from "vitest";

import {
  alignLinesToTotal,
  costPrecision,
  formatCostAt,
} from "@/apps/agent/lib/cost/cost";

/**
 * The cost card shows a total and the lines that make it up. Rounded on their
 * own, the lines did not add up to the total on screen — a real card read
 * `$0.0665 + $0.0028 + $0.0006` under a headline of `$0.0700`. The arithmetic
 * was right to the last unrounded cent and visibly wrong to anyone adding up
 * three numbers, which is exactly what someone opening a cost card is doing.
 *
 * The rule: the TOTAL is never adjusted, and the lines are rounded so their
 * displayed values sum to it.
 */

/** What the column actually reads as, once formatted. */
const column = (values: number[], total: number): string[] =>
  alignLinesToTotal(values, total).map((v) =>
    formatCostAt(v, costPrecision(total)),
  );

const sums = (values: number[], total: number): boolean => {
  const dp = costPrecision(total);
  const scale = 10 ** dp;
  const lines = alignLinesToTotal(values, total).reduce((a, b) => a + b, 0);
  return Math.round(lines * scale) === Math.round(total * scale);
};

describe("a cost column that adds up", () => {
  it("fixes the exact case from the card", () => {
    // Values that produced $0.0665 / $0.0028 / $0.0006 under $0.0700.
    const values = [0.06653, 0.00281, 0.00062];
    const total = values.reduce((a, b) => a + b, 0);
    expect(formatCostAt(total, 4)).toBe("$0.0700");
    expect(column(values, total)).toEqual(["$0.0666", "$0.0028", "$0.0006"]);
    expect(sums(values, total)).toBe(true);
  });

  it("leaves an already-tallying column alone", () => {
    // The chat total in the same screenshot needed no adjustment; a fix that
    // nudged correct figures would be worse than the bug.
    const values = [0.1212, 0.0029, 0.0023];
    const total = 0.1264;
    expect(column(values, total)).toEqual(["$0.1212", "$0.0029", "$0.0023"]);
  });

  it("puts the residual on the largest line", () => {
    // One unit in the last place is proportionally least visible there, and
    // that line is never zero when there is a residual to place.
    const aligned = alignLinesToTotal([0.00004, 0.5, 0.00004], 0.50009);
    expect(aligned[1]).toBeCloseTo(0.5001, 10);
    expect(aligned[0]).toBe(0);
    expect(aligned[2]).toBe(0);
  });

  it("never rewrites the total to make the lines fit", () => {
    // The total is the bill. Adjusting IT to tally would falsify the one
    // figure on the card that has to be exact.
    const values = [0.01111, 0.02222];
    const total = 0.03333;
    const aligned = alignLinesToTotal(values, total);
    expect(aligned.reduce((a, b) => a + b, 0)).toBeCloseTo(0.0333, 10);
    expect(formatCostAt(total, costPrecision(total))).toBe("$0.0333");
  });

  it("keeps one precision across a section, chosen by the total", () => {
    // Mixed precision is why the column could never tally: a $0.0002 line
    // under a $1.20 total was rendered at 4dp beside a 3dp headline.
    expect(costPrecision(0.5)).toBe(4);
    expect(costPrecision(4.453)).toBe(3);
    expect(costPrecision(250)).toBe(2);
    // The tiny line rounds away at the section's precision and reads "$0" —
    // the card renders it as a dash or a "<$…", never as a padded $0.000.
    expect(column([1.2005, 0.0002], 1.2007)).toEqual(["$1.201", "$0"]);
  });

  it("survives an empty section without inventing a line", () => {
    // Every request priced by the provider itself → no token breakdown to
    // show, and nowhere to put a residual.
    expect(alignLinesToTotal([], 0.05)).toEqual([]);
  });

  it("ignores negative and non-finite inputs rather than propagating them", () => {
    const aligned = alignLinesToTotal([Number.NaN, -3, 0.002], 0.002);
    expect(aligned.every(Number.isFinite)).toBe(true);
    expect(aligned[0]).toBe(0);
    expect(aligned[1]).toBe(0);
    expect(aligned[2]).toBeCloseTo(0.002, 10);
  });

  it("never produces a negative line, whatever the total claims", () => {
    // A money column with a negative row in it is nonsense on its face. When
    // the total is smaller than the parts the line is floored at zero rather
    // than going below it — degenerate input, but it must not render as a
    // refund that never happened.
    expect(alignLinesToTotal([0.001], 0)[0]).toBe(0);
    for (const total of [0, 0.0001, 0.5]) {
      for (const v of alignLinesToTotal([0.4, 0.3, 0.2], total)) {
        expect(v).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("holds for a hundred random splits", () => {
    // Property: whatever the parts, the displayed column equals the displayed
    // total. Deterministic seed — a flaky money test is worse than none.
    let seed = 7;
    const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    for (let i = 0; i < 100; i++) {
      const values = [next() * 0.5, next() * 0.05, next() * 0.005, next() * 0.0005];
      const total = values.reduce((a, b) => a + b, 0);
      expect(sums(values, total)).toBe(true);
    }
  });
});
