import { describe, expect, it } from "vitest";

import { dayLabel, groupByDay } from "./day-groups";
import { clampRatio, layoutRows } from "./justified-rows";

const opts = { targetHeight: 200, gap: 8 };

describe("justified rows", () => {
  it("keeps the given order, left to right, row by row", () => {
    const items = Array.from({ length: 7 }, (_, i) => ({ key: `k${i}`, ratio: 1 }));
    const { boxes } = layoutRows(items, 820, opts);
    expect(boxes.map((b) => b.key)).toEqual(items.map((i) => i.key));
    // Reading order: y never goes back up, and x grows within a row.
    for (let i = 1; i < boxes.length; i++) {
      const prev = boxes[i - 1];
      const box = boxes[i];
      expect(box.y >= prev.y).toBe(true);
      if (box.y === prev.y) expect(box.x > prev.x).toBe(true);
    }
  });

  it("fills full rows to the exact width at the target height or below", () => {
    const items = Array.from({ length: 8 }, (_, i) => ({ key: `k${i}`, ratio: 1.5 }));
    const { boxes } = layoutRows(items, 1000, opts);
    const firstRow = boxes.filter((b) => b.y === 0);
    const right = Math.max(...firstRow.map((b) => b.x + b.width));
    expect(right).toBeCloseTo(1000, 5);
    expect(firstRow[0].height).toBeLessThanOrEqual(200);
  });

  it("does not stretch a short last row", () => {
    const { boxes } = layoutRows([{ key: "a", ratio: 1 }], 1000, opts);
    expect(boxes[0]).toMatchObject({ x: 0, y: 0, width: 200, height: 200 });
  });

  it("returns nothing for no width or no items", () => {
    expect(layoutRows([{ key: "a", ratio: 1 }], 0, opts).boxes).toEqual([]);
    expect(layoutRows([], 500, opts)).toEqual({ boxes: [], height: 0 });
  });

  it("clamps extreme shapes", () => {
    expect(clampRatio(10)).toBe(2.6);
    expect(clampRatio(0.05)).toBe(0.4);
    expect(clampRatio(Number.NaN)).toBe(1);
  });
});

describe("day groups", () => {
  const now = new Date(2026, 9, 1, 15, 0); // Thu 1 Oct 2026, local

  it("labels recent days by name and older ones by date", () => {
    expect(dayLabel("2026-10-01", now)).toBe("Today");
    expect(dayLabel("2026-09-30", now)).toBe("Yesterday");
    expect(dayLabel("2026-09-27", now)).toBe(new Date(2026, 8, 27).toLocaleDateString(undefined, { weekday: "long" }));
    expect(dayLabel("2026-09-01", now)).toBe(new Date(2026, 8, 1).toLocaleDateString(undefined, { month: "short", day: "numeric" }));
    expect(dayLabel("2025-12-24", now)).toContain("2025");
  });

  it("groups in the given order and keeps order inside each group", () => {
    const items = [
      { id: 1, at: new Date(2026, 9, 1, 14).toISOString() },
      { id: 2, at: new Date(2026, 9, 1, 9).toISOString() },
      { id: 3, at: new Date(2026, 8, 30, 20).toISOString() },
      { id: 4, at: "not a date" },
    ];
    const groups = groupByDay(items, (i) => i.at, now);
    expect(groups.map((g) => [g.label, g.items.map((i) => i.id)])).toEqual([
      ["Today", [1, 2]],
      ["Yesterday", [3]],
      ["Earlier", [4]],
    ]);
  });
});
