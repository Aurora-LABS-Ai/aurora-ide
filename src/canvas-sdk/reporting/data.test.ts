import { describe, expect, it } from "vitest";
import royalties from "./examples/royalties.json";
import { aggregateValue, chartPoints, filterRows, formatValue, numericAxis, valueDomain } from "./data";
import { parseReportSource, validateReport } from "./validate";
import type { ChartSpec, DataRecord } from "./types";

describe("report data", () => {
  it("formats precision, currency, percentages, bytes, durations and missing values", () => {
    expect(formatValue(17.9138, { style: "currency", digits: 4 })).toBe("$17.9138");
    expect(formatValue(0.123, { style: "percent", digits: 1 })).toBe("12.3%");
    expect(formatValue(1536, { style: "bytes" })).toBe("1.5 KiB");
    expect(formatValue(-12.4, { style: "duration" })).toBe("-12.4 ms");
    expect(formatValue(null)).toBe("Not available");
    expect(formatValue(Number.NaN)).toBe("Not available");
    expect(formatValue(false)).toBe("false");
  });
  it("computes aggregates without treating missing cells as measured zero", () => {
    const rows: DataRecord[] = [{ v: 0, group: "A" }, { v: -4, group: "A" }, { v: null, group: "B" }];
    expect(aggregateValue(rows, "v", "average")).toBe(-2);
    expect(aggregateValue(rows, "v", "min")).toBe(-4);
    expect(aggregateValue(rows, "v", "max")).toBe(0);
    expect(aggregateValue(rows, "group", "distinct")).toBe(2);
    expect(aggregateValue(rows, undefined, "count")).toBe(3);
    expect(aggregateValue([], "v", "average")).toBeNull();
  });
  it("combines select, multi, text, numeric and calendar filters", () => {
    const rows: DataRecord[] = [{ name: "Alpha", n: 0, ok: false, date: "2026-10-02" }, { name: "Beta", n: 5, ok: true, date: "2026-10-20" }, { name: null, n: null, date: null }];
    expect(filterRows(rows, [{ field: "n", label: "n", kind: "range" }], { n: { min: "0", max: "0" } })).toEqual([rows[0]]);
    expect(filterRows(rows, [{ field: "ok", label: "ok", kind: "select" }], { ok: "false" })).toEqual([rows[0]]);
    expect(filterRows(rows, [{ field: "name", label: "name", kind: "multi" }], { name: ['"Beta"'] })).toEqual([rows[1]]);
    expect(filterRows(rows, [{ field: "date", label: "Date", kind: "date" }], { date: { min: "2026-10-01", max: "2026-10-10" } })).toEqual([rows[0]]);
    expect(filterRows(rows, [{ field: "name", label: "name", kind: "search" }], { name: "ALP" })).toEqual([rows[0]]);
    expect(filterRows(rows, [{ field: "name", label: "name", kind: "multi" }], { name: [] })).toEqual(rows);
  });
  it("groups categories and preserves zero, negative and missing measurements", () => {
    const spec: ChartSpec = { type: "chart", title: "x", kind: "column", x: "label", y: ["a", "b"] };
    const points = chartPoints([{ label: "One", a: 2, b: -4 }, { label: "One", a: 3, b: 0 }, { label: "Two", a: 0, b: null }], spec);
    expect(points).toEqual([{ label: "One", values: [5, -4] }, { label: "Two", values: [0, null] }]);
    expect(valueDomain(points)).toEqual([-4, 5]);
    expect(valueDomain([{ label: "x", values: [-4, -2, 3, 2] }], true)).toEqual([-6, 5]);
    expect(valueDomain([{ label: "x", values: [0] }])).toEqual([0, 1]);
  });
  it("expands axes to readable ticks without cropping positive or negative values", () => {
    expect(numericAxis(0, 8.6845)).toEqual({ low: 0, high: 10, ticks: [0, 2.5, 5, 7.5, 10] });
    const signed = numericAxis(-6, 5);
    expect(signed.low).toBeLessThanOrEqual(-6);
    expect(signed.high).toBeGreaterThanOrEqual(5);
    expect(signed.ticks).toContain(0);
    expect(numericAxis(-6, 0).high).toBe(0);
  });
});

describe("report contract", () => {
  it("validates the screenshot report and computes its exact totals", () => {
    const parsed = validateReport(royalties);
    expect(parsed.problems).toEqual([]);
    expect(parsed.spec?.data).toHaveLength(5);
    expect(aggregateValue(parsed.spec!.data, "earnings")).toBeCloseTo(17.9138, 8);
    expect(aggregateValue(parsed.spec!.data, "streams")).toBe(10626);
  });
  it.each([
    { ...royalties, unknown: true },
    { ...royalties, data: [{ platform: "A", streams: {}, earnings: 1 }] },
    { ...royalties, filters: [{ field: "missing", label: "Bad", kind: "select" }] },
    { ...royalties, sections: [{ blocks: [{ type: "chart", kind: "pie", title: "Bad", x: "platform", y: ["earnings"] }] }] },
    { ...royalties, sections: [{ blocks: [{ type: "table", title: "Bad", columns: [{ key: "earnings", label: "A" }, { key: "earnings", label: "B" }] }] }] },
    { ...royalties, sections: [{ blocks: [{ type: "chart", kind: "donut", title: "Bad", x: "platform", y: ["streams", "earnings"] }] }] },
  ])("rejects invalid schema without partial data loss", (value) => {
    const parsed = validateReport(value);
    expect(parsed.spec).toBeNull();
    expect(parsed.problems.length).toBeGreaterThan(0);
  });
  it("rejects incompatible numeric data and negative part-to-whole values", () => {
    const report = { title: "x", data: [{ category: "A", amount: -2 }], sections: [{ blocks: [{ type: "chart", kind: "donut", title: "Bad", x: "category", y: ["amount"] }] }] };
    expect(validateReport(report).problems.join(" ")).toContain("nonnegative");
    expect(validateReport({ ...report, data: [{ category: "A", amount: "$2" }] }).problems.join(" ")).toContain("numbers or null");
  });
  it("reports malformed JSON and bounded input explicitly", () => {
    expect(parseReportSource('{"title":').problems[0]).toContain("JSON");
    expect(parseReportSource(" ".repeat(512001)).problems[0]).toContain("exceeds");
    expect(validateReport({ ...royalties, data: Array(2001).fill({}) }).problems.join(" ")).toContain("2,000".replace(",", ""));
  });
});
