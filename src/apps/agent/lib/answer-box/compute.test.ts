import { describe, expect, it } from "vitest";

import { computeBox, defaultValues, rankItems, usableValues } from "./compute";
import { ANSWER_BOX_EXAMPLES } from "./instructions";
import { parseBox } from "./parse";

const roast = parseBox(ANSWER_BOX_EXAMPLES.roast, { complete: true });
const bill = parseBox(ANSWER_BOX_EXAMPLES.bill, { complete: true });
const compare = parseBox(ANSWER_BOX_EXAMPLES.compare, { complete: true });

const rowsOf = (box: ReturnType<typeof computeBox>) =>
  box.blocks.flatMap((b) => (b.kind === "rows" ? b.rows.map((r) => `${r.label}=${r.value}`) : []));

describe("computing an answer box", () => {
  it("recomputes every row from the inputs", () => {
    expect(rowsOf(computeBox(roast, defaultValues(roast)))).toEqual([
      "Bone-in leg of lamb=2.4 kg",
      "Potatoes=1.8 kg",
      "Carrots=10",
      "Apples for crumble=5",
    ]);
    expect(rowsOf(computeBox(roast, { people: 9 }))).toEqual([
      "Bone-in leg of lamb=3.6 kg",
      "Potatoes=2.7 kg",
      "Carrots=15",
      "Apples for crumble=8",
    ]);
  });

  it("puts a lone stepper in the centre and keeps several inputs as rows", () => {
    expect(computeBox(roast, defaultValues(roast)).heroInput).toBe(true);
    expect(computeBox(bill, defaultValues(bill)).heroInput).toBe(false);
  });

  it("carries lets, money and the emphasised answer row", () => {
    const box = computeBox(bill, defaultValues(bill));
    const rows = box.blocks.flatMap((b) => (b.kind === "rows" ? b.rows : []));
    expect(rows).toEqual([
      { label: "Tip", value: "$27.96", emphasis: false },
      { label: "Total with tip", value: "$214.36", emphasis: false },
      { label: "Each of 4 pays", value: "$53.59", emphasis: true },
    ]);
    expect(box.problems).toEqual([]);
  });

  it("reports a row it cannot compute instead of showing a wrong number", () => {
    const spec = parseBox(`stepper n "N" 0 min=0 max=4\nrow "Share" = 10 / n`, { complete: true });
    const box = computeBox(spec, defaultValues(spec));
    expect(rowsOf(box)).toEqual(["Share=—"]);
    expect(box.problems).toEqual([{ line: 2, message: "divides by zero" }]);
  });

  it("keeps saved values only where the box can still reach them", () => {
    expect(usableValues(bill, { people: 7, tip: 0.2, bill: 50 })).toEqual({ bill: 50, tip: 0.2, people: 7 });
    expect(usableValues(bill, { people: 99, tip: 0.33, gone: 1 })).toEqual({ bill: 186.4, tip: 0.15, people: 4 });
  });

  it("ranks a comparison best first for the chosen measure", () => {
    const box = computeBox(compare, {});
    const block = box.blocks.find((b) => b.kind === "compare");
    expect(block?.kind).toBe("compare");
    if (block?.kind !== "compare") return;
    expect(rankItems(block.compare, "cost").map((i) => i.name)).toEqual(["Mendocino", "Monterey", "Lake Tahoe"]);
    expect(rankItems(block.compare, "things").map((i) => i.name)).toEqual(["Monterey", "Lake Tahoe", "Mendocino"]);
    expect(box.note).toBe("Sample figures, not live prices");
  });
});
