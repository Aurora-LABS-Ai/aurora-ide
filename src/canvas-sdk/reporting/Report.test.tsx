import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Chart } from "./Chart";
import { DataTable } from "./DataTable";
import { Report } from "./Report";
import { Metric, MetricGrid } from "./Metric";
import royalties from "./examples/royalties.json";
import { CHART_KINDS, type DataRecord, type ReportSpec } from "./types";
import { validateReport } from "./validate";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => { host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });
const render = (node: React.ReactNode) => { act(() => root.render(node)); return host; };
const click = (element: Element | null | undefined) => { expect(element).toBeTruthy(); act(() => (element as HTMLElement).click()); };
const button = (text: string) => [...host.querySelectorAll("button")].find((node) => node.textContent === text);
const input = (element: HTMLInputElement, value: string) => act(() => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
});

describe("connected reports", () => {
  it("reproduces royalty totals and updates metrics and table through a shared filter", () => {
    render(<Report spec={validateReport(royalties).spec!} />);
    expect(host.querySelector(".ac-metric-value")?.textContent).toBe("$17.9138");
    expect(host.querySelector("tfoot")?.textContent).toContain("10,626");
    expect(host.querySelectorAll(".ac-plot-mark")).toHaveLength(5);
    click([...host.querySelectorAll(".ac-report-options label")].find((node) => node.textContent === "Spotify")?.querySelector("input"));
    expect(host.querySelector(".ac-metric-value")?.textContent).toBe("$5.1168");
    expect(host.querySelectorAll(".ac-report-section > .ac-data-table tbody tr")).toHaveLength(1);
    expect(host.querySelectorAll(".ac-plot-mark")).toHaveLength(1);
    click(button("Reset filters"));
    expect(host.querySelector(".ac-metric-value")?.textContent).toBe("$17.9138");
  });
  it("selects a chart category with the keyboard while retaining overview bars", () => {
    render(<Report spec={validateReport(royalties).spec!} />);
    const mark = host.querySelector('[aria-label^="Spotify, earnings"]')!;
    act(() => mark.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(host.querySelector(".ac-metric-value")?.textContent).toBe("$5.1168");
    expect(host.querySelectorAll(".ac-plot-mark")).toHaveLength(5);
    expect(mark.getAttribute("aria-pressed")).toBe("true");
    click(button("Clear selection"));
    expect(host.querySelector(".ac-metric-value")?.textContent).toBe("$17.9138");
  });
  it("switches report views without losing the active filter", () => {
    render(<Report spec={validateReport(royalties).spec!} />);
    click([...host.querySelectorAll(".ac-report-options label")].find((node) => node.textContent === "Deezer")?.querySelector("input"));
    click(button("Streams"));
    expect(host.querySelector(".ac-report-chart figcaption")?.textContent).toBe("Streams by platform");
    expect(host.querySelector(".ac-metric-value")?.textContent).toBe("$8.6845");
    expect(button("Streams")?.getAttribute("aria-pressed")).toBe("true");
  });
  it("does not compare a filtered subset with an unfiltered baseline", () => {
    const spec = validateReport(royalties).spec!;
    const metric = spec.sections[0].blocks[0];
    if (metric.type !== "metrics") throw new Error("Expected metric fixture");
    metric.items[0].previous = 10;
    render(<Report spec={spec} />);
    expect(host.querySelector(".ac-metric-change")).not.toBeNull();
    click([...host.querySelectorAll(".ac-report-options label")].find((node) => node.textContent === "Spotify")?.querySelector("input"));
    expect(host.querySelector(".ac-metric-change")).toBeNull();
    expect(host.textContent).toContain("Previous-period comparison applies to all records.");
  });
  it("reports zero results and can reset an impossible range", () => {
    render(<Report spec={validateReport(royalties).spec!} />);
    const range = host.querySelectorAll<HTMLInputElement>('.ac-report-range input');
    input(range[0], "10000");
    expect(host.querySelector(".ac-report-status")?.textContent).toContain("0 of 5 records");
    expect(host.textContent).toContain("No records match");
    click(button("Reset filters"));
    expect(host.querySelector(".ac-report-status")?.textContent).toContain("5 of 5 records");
  });
  it("shows invalid contracts as actionable errors and keeps markup inert", () => {
    render(<Report spec={{ ...royalties, title: "<script>report</script>" } as unknown as ReportSpec} />);
    expect(host.querySelector("script")).toBeNull();
    expect(host.querySelector("h2")?.textContent).toBe("<script>report</script>");
    render(<Report spec={{ title: "Bad" } as ReportSpec} />);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("data");
  });
  it("renders structural report blocks and explicit empty-source state", () => {
    const spec: ReportSpec = { title: "Structure", data: [], sections: [{ blocks: [
      { type: "facts", items: [{ label: "Owner", value: "Kernel" }] },
      { type: "tree", items: [{ title: "Root", children: [{ title: "Child", detail: "Nested" }] }] },
      { type: "timeline", items: [{ title: "Launch", when: "October", status: "done" }] },
      { type: "steps", items: [{ title: "Read" }, { title: "Verify" }] },
      { type: "list", items: [{ title: "One" }] },
      { type: "text", text: "An explanation." },
      { type: "note", title: "Caveat", text: "One exception", tone: "warn" },
    ] }] };
    render(<Report spec={spec} />);
    expect(host.querySelectorAll(".ac-report-tree .ac-report-tree li")).toHaveLength(1);
    expect(host.querySelector(".ac-report-item-status")?.textContent).toBe("Done");
    expect(host.textContent).toContain("No source records are available");
  });
});

describe("data tables", () => {
  const rows: DataRecord[] = Array.from({ length: 12 }, (_, i) => ({ name: `Row ${i + 1}`, value: i + 1, extra: `Detail ${i + 1}` }));
  const columns = [{ key: "name", label: "Name" }, { key: "value", label: "Value", total: "sum" as const }];
  it("pages without losing totals and sorts numbers correctly", () => {
    render(<DataTable title="Records" rows={rows} columns={columns} pageSize={5} />);
    expect(host.querySelectorAll("tbody tr")).toHaveLength(5);
    expect(host.querySelector("tfoot")?.textContent).toContain("78");
    click(button("Next"));
    expect(host.querySelector("tbody tr")?.textContent).toContain("Row 6");
    click(button("Value ↕"));
    click(button("Value ↑"));
    expect(host.querySelector("tbody tr")?.textContent).toContain("Row 12");
    expect(host.querySelector('th[aria-sort="descending"]')).not.toBeNull();
  });
  it("searches all pages, recomputes matching totals, and exposes row details", () => {
    render(<DataTable title="Records" rows={rows} columns={columns} pageSize={5} details={["name", "extra"]} />);
    input(host.querySelector('input[type="search"]')!, "Row 12");
    expect(host.querySelectorAll("tbody tr")).toHaveLength(1);
    expect(host.querySelector("tfoot")?.textContent).toContain("12");
    click(host.querySelector("tbody button"));
    expect(host.querySelector(".ac-data-details")?.textContent).toContain("Detail 12");
    click(button("Close details"));
    expect(host.querySelector(".ac-data-details")).toBeNull();
  });
  it("keeps missing values last in either sort direction", () => {
    render(<DataTable title="Nulls" rows={[{ v: null }, { v: 0 }, { v: -1 }]} columns={[{ key: "v", label: "Value" }]} />);
    click(button("Value ↕"));
    expect(host.querySelector("tbody tr:last-child")?.textContent).toBe("Not available");
    click(button("Value ↑"));
    expect(host.querySelector("tbody tr:first-child")?.textContent).toBe("0");
    expect(host.querySelector("tbody tr:last-child")?.textContent).toBe("Not available");
  });
});

describe("report charts", () => {
  it.each(CHART_KINDS)("draws %s with actual values and accessible fallback data", (kind) => {
    const rows: DataRecord[] = [{ category: 1, a: 4, b: 3 }, { category: 2, a: 0, b: 2 }, { category: 3, a: 2, b: 1 }];
    render(<Chart title="Measured values" kind={kind} x="category" y={kind === "donut" || kind === "funnel" ? ["a"] : ["a", "b"]} data={rows} />);
    expect(host.querySelectorAll(".ac-plot-mark").length).toBeGreaterThan(0);
    expect(host.querySelector("svg")?.outerHTML).not.toMatch(/NaN|Infinity/);
    expect(host.querySelector("details summary")?.textContent).toBe("View chart data");
    expect(host.querySelectorAll(".ac-data-table tbody tr")).toHaveLength(3);
  });
  it("toggles series and prints an inspection value on keyboard focus", () => {
    render(<Chart title="Measures" kind="line" x="label" y={["a", "b"]} data={[{ label: "One", a: 3, b: -2 }]} />);
    const legend = host.querySelectorAll<HTMLButtonElement>(".ac-chart-legend button");
    click(legend[1]);
    expect(legend[1].getAttribute("aria-pressed")).toBe("false");
    expect(host.querySelectorAll(".ac-plot-mark")).toHaveLength(1);
    expect(legend[0].disabled).toBe(true);
    act(() => host.querySelector(".ac-plot-mark")?.dispatchEvent(new FocusEvent("focusin", { bubbles: true })));
    expect(host.querySelector(".ac-chart-inspection")?.textContent).toContain("One, a: 3");
  });
  it("does not invent measurements for entirely missing data or shares for all zero values", () => {
    render(<Chart title="Missing" kind="line" x="x" y={["y"]} data={[{ x: "One", y: null }]} />);
    expect(host.textContent).toContain("No numeric measurements");
    render(<Chart title="Zero" kind="donut" x="x" y={["y"]} data={[{ x: "One", y: 0 }]} />);
    expect(host.textContent).toContain("All values are zero");
  });
  it("renders metric deltas without dividing a zero baseline", () => {
    render(<MetricGrid><Metric label="Earnings" value={17.9138} previous={0} format={{ style: "currency", digits: 4 }} /></MetricGrid>);
    expect(host.querySelector(".ac-metric-change")?.textContent).toBe("+$17.9138 vs previous");
    expect(host.textContent).not.toMatch(/Infinity|NaN/);
  });
});
