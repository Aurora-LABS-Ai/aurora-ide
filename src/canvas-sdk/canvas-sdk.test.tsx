import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import * as sdk from "./index";
import { Badge, Canvas, List, Row, Section, Stat, Stats, Table } from "./index";

// React only treats `act` as real batching when this is set; without it every
// render logs a warning and the assertions run against un-flushed output.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement | null = null;
let root: Root | null = null;

const render = (node: React.ReactNode): HTMLDivElement => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(node);
  });
  return host;
};

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

describe("Picker", () => {
  it("is a radio group whose chosen item is marked and reported", () => {
    const seen: string[] = [];
    const el = render(
      <sdk.Picker
        label="Project"
        items={[
          { id: "shop", label: "Storefront", caption: "Next.js" },
          { id: "ide", label: "Aurora IDE" },
        ]}
        onChange={(id) => seen.push(id)}
      />,
    );
    const radios = el.querySelectorAll<HTMLButtonElement>("[role=radio]");
    expect(radios).toHaveLength(2);
    expect(radios[0].getAttribute("aria-checked")).toBe("true");
    expect(radios[0].querySelector(".ac-picker-caption")?.textContent).toBe("Next.js");
    act(() => radios[1].click());
    expect(seen).toEqual(["ide"]);
    expect(el.querySelector("[role=radio][aria-checked=true]")?.textContent).toContain("Aurora IDE");
  });

  it("follows a controlled value and draws nothing for no items", () => {
    const el = render(<sdk.Picker label="x" items={[{ id: "a", label: "A" }, { id: "b", label: "B" }]} value="b" />);
    expect(el.querySelector("[role=radio][aria-checked=true]")?.textContent).toBe("B");
    expect(render(<sdk.Picker label="x" items={[]} />).innerHTML).toBe("");
  });
});

describe("the exported surface", () => {
  it("is exactly what canvas_guidelines documents", () => {
    // Both sides are pinned: the Rust test asserts the guide names each of
    // these, this one asserts they exist. A component that drifts out of one
    // list fails in the other.
    expect(Object.keys(sdk).sort()).toEqual(
      [
        "Badge", "Bar", "BarChart", "Canvas", "Choice", "Cite", "Code",
        "Columns", "Detail", "Divider", "Event", "Fact", "Facts", "Image",
        "List", "Note", "NumberField", "Picker", "Quote", "Row", "Section", "Sparkline",
        "Stat", "Stats", "Stepper", "Table", "Tabs", "Text", "Timeline",
        "useHostTheme", "Report", "Chart", "DataTable", "Metric", "MetricGrid",
        "SearchField", "SelectField", "MultiSelect", "RangeField", "Toggle",
      ].sort(),
    );
  });

  it("ships no generic Card — the wall of identical cards has no component", () => {
    expect(sdk).not.toHaveProperty("Card");
    expect(sdk).not.toHaveProperty("Panel");
  });
});

describe("empty renders nothing", () => {
  it("collapses a Section, List, Stats, and Table that have no content", () => {
    // "Never render an empty state" is a rule the components keep, so the
    // agent cannot leave a titled-but-empty frame behind by forgetting.
    expect(render(<Section title="Findings">{[]}</Section>).innerHTML).toBe("");
    expect(render(<Section title="Findings">{null}</Section>).innerHTML).toBe("");
    expect(render(<List>{[]}</List>).innerHTML).toBe("");
    expect(render(<Stats>{false}</Stats>).innerHTML).toBe("");
    expect(
      render(<Table caption="Files" columns={[{ key: "a", label: "A" }]} rows={[]} />).innerHTML,
    ).toBe("");
  });

  it("keeps a Section that has real content", () => {
    const output = render(
      <Section title="Findings">
        <List>
          <Row title="one" />
        </List>
      </Section>,
    );
    expect(output.querySelector("h2")?.textContent).toBe("Findings");
    expect(output.querySelectorAll(".ac-row")).toHaveLength(1);
  });
});

describe("Canvas frame", () => {
  it("owns the single h1 and shows provenance when given", () => {
    const output = render(
      <Canvas title="Cost review" subtitle="Q3" source="Stripe · last 90 days">
        <Section title="x">
          <List>
            <Row title="row" />
          </List>
        </Section>
      </Canvas>,
    );
    expect(output.querySelectorAll("h1")).toHaveLength(1);
    expect(output.querySelector("h1")?.textContent).toBe("Cost review");
    expect(output.querySelector(".ac-canvas-source")?.textContent).toBe("Stripe · last 90 days");
  });
});

describe("Table — the shape a developer would reasonably write", () => {
  // Every assertion in this block comes from one real failure: the agent wrote
  // idiomatic table code (`header`, `align`, components in cells) against an
  // API that demanded `label`/`numeric` and accepted only strings. It rendered
  // blank headings and `[object Object]` in every cell. The API was wrong, not
  // the caller.

  it("accepts `header`, which is what most table APIs call it", () => {
    const output = render(
      <Table
        caption="Files"
        columns={[{ key: "f", header: "File" }]}
        rows={[{ f: "a.ts" }]}
      />,
    );
    expect(output.querySelector("th")?.textContent).toContain("File");
  });

  it("renders components in cells instead of stringifying them", () => {
    const output = render(
      <Table
        caption="Files"
        columns={[{ key: "path", header: "File" }, { key: "area", header: "Area" }]}
        rows={[{ path: <code>a.ts</code>, area: <Badge tone="info">UI</Badge> }]}
      />,
    );
    expect(output.textContent).not.toContain("[object Object]");
    expect(output.querySelector("td code")?.textContent).toBe("a.ts");
    expect(output.querySelector(".ac-badge")?.textContent).toBe("UI");
  });

  it("detects a numeric column from its data — no `numeric: true` needed", () => {
    const output = render(
      <Table
        caption="Files"
        columns={[{ key: "f", header: "File" }, { key: "n", header: "Lines" }]}
        rows={[
          { f: "a", n: 20 },
          { f: "b", n: 100 },
        ]}
      />,
    );
    const headers = output.querySelectorAll("th");
    expect(headers[1].getAttribute("data-align")).toBe("right");
    expect(headers[0].getAttribute("data-align")).toBe("left");

    act(() => (output.querySelectorAll("thead button")[1] as HTMLButtonElement).click());
    // Numeric-aware: 100 before 20, which string ordering would reverse.
    expect([...output.querySelectorAll("tbody tr")].map((r) => r.children[0].textContent)).toEqual(
      ["b", "a"],
    );
  });

  it("does not offer sorting on a column of components — nothing to compare", () => {
    const output = render(
      <Table
        caption="Files"
        columns={[{ key: "bar", header: "Share" }]}
        rows={[{ bar: <div /> }, { bar: <div /> }]}
      />,
    );
    expect(output.querySelectorAll("thead button")).toHaveLength(0);
    expect(output.querySelector(".ac-th-static")?.textContent).toBe("Share");
    expect(output.querySelector("th")?.getAttribute("aria-sort")).toBeNull();
  });

  it("names a column with no heading instead of rendering a blank one", () => {
    expect(() =>
      render(<Table caption="Files" columns={[{ key: "f" }]} rows={[{ f: "a" }]} />),
    ).toThrow(/columns\[0\].*has no heading/s);
  });

  it("refuses a plain object in a cell rather than printing [object Object]", () => {
    expect(() =>
      render(
        <Table
          caption="Files"
          columns={[{ key: "f", header: "File" }]}
          rows={[{ f: { name: "a.ts" } as unknown as React.ReactNode }]}
        />,
      ),
    ).toThrow(/is a plain object/);
  });
});

describe("Table", () => {
  const columns = [
    { key: "file", header: "File" },
    { key: "lines", header: "Lines", numeric: true },
  ];
  const rows = [
    { file: "b.ts", lines: 20 },
    { file: "a.ts", lines: 100 },
    { file: "c.ts", lines: null },
  ];

  const cells = (output: HTMLElement, column: number) =>
    [...output.querySelectorAll("tbody tr")].map(
      (row) => row.children[column].textContent ?? "",
    );

  it("sorts numerically, not lexically, on a numeric column", () => {
    const output = render(<Table caption="Files by size" columns={columns} rows={rows} />);
    const header = output.querySelectorAll("thead button")[1] as HTMLButtonElement;

    // Numeric columns open descending — for a ranking, biggest-first is the
    // question being asked.
    act(() => header.click());
    expect(cells(output, 0).slice(0, 2)).toEqual(["a.ts", "b.ts"]);

    act(() => header.click());
    // 20 before 100 proves it is not comparing "100" < "20" as strings.
    expect(cells(output, 0).slice(0, 2)).toEqual(["b.ts", "a.ts"]);
  });

  it("sorts absent values last in BOTH directions — a gap is not a low score", () => {
    const output = render(<Table caption="Files by size" columns={columns} rows={rows} />);
    const header = output.querySelectorAll("thead button")[1] as HTMLButtonElement;

    act(() => header.click());
    expect(cells(output, 0).at(-1)).toBe("c.ts");
    act(() => header.click());
    expect(cells(output, 0).at(-1)).toBe("c.ts");
  });

  it("names an absent cell instead of leaving a dash that reads as breakage", () => {
    const output = render(<Table caption="Files by size" columns={columns} rows={rows} />);
    expect(output.querySelector(".ac-absent")?.textContent).toBe("not recorded");
  });

  it("announces sort state and is reachable as a real button", () => {
    const output = render(<Table caption="Files by size" columns={columns} rows={rows} />);
    const headers = output.querySelectorAll("th");
    expect([...headers].map((th) => th.getAttribute("aria-sort"))).toEqual(["none", "none"]);
    expect(output.querySelectorAll("thead button")).toHaveLength(2);

    act(() => (output.querySelectorAll("thead button")[0] as HTMLButtonElement).click());
    expect(headers[0].getAttribute("aria-sort")).toBe("ascending");
  });

  it("carries its caption, so the reader never has to infer what they are seeing", () => {
    const output = render(<Table caption="Files by size" columns={columns} rows={rows} />);
    expect(output.querySelector("caption")?.textContent).toBe("Files by size");
  });
});

describe("numbers", () => {
  it("groups thousands and uses tabular figures so columns line up", () => {
    const output = render(<Stat label="Lines" value={1391} unit="lines" />);
    expect(output.querySelector(".ac-num")?.textContent).toBe((1391).toLocaleString());
    expect(output.querySelector(".ac-stat-label")?.textContent).toBe("Lines");
  });

  it("leaves pre-formatted strings alone", () => {
    const output = render(<Stat label="Ratio" value="18%" />);
    expect(output.querySelector(".ac-num")?.textContent).toBe("18%");
  });
});

/** Type into a controlled input the way a person does, so React's onChange fires. */
const typeInto = (input: HTMLInputElement, text: string) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

const press = (target: Element, key: string) =>
  act(() => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  });

describe("inputs", () => {
  it("steps within its limits and disables the button at each end", () => {
    const seen: number[] = [];
    const output = render(
      <sdk.Stepper label="People" defaultValue={2} min={1} max={3} onChange={(v) => seen.push(v)} />,
    );
    const [minus, plus] = output.querySelectorAll<HTMLButtonElement>("button");
    const value = output.querySelector('[role="spinbutton"]')!;
    act(() => plus.click());
    expect(value.textContent).toBe("3");
    expect(plus.disabled).toBe(true);
    act(() => minus.click());
    act(() => minus.click());
    expect(value.textContent).toBe("1");
    expect(minus.disabled).toBe(true);
    expect(seen).toEqual([3, 2, 1]);
  });

  it("answers the arrow keys, Home and End on the number itself", () => {
    const output = render(<sdk.Stepper label="People" defaultValue={6} min={1} max={30} />);
    const value = output.querySelector('[role="spinbutton"]')!;
    press(value, "ArrowUp");
    expect(value.getAttribute("aria-valuenow")).toBe("7");
    press(value, "PageDown");
    expect(value.getAttribute("aria-valuenow")).toBe("2");
    press(value, "End");
    expect(value.getAttribute("aria-valuenow")).toBe("30");
  });

  it("names its unit in the singular or the plural to match the number", () => {
    const output = render(
      <sdk.Stepper label="People" defaultValue={2} min={1} unit="person/people" size="large" />,
    );
    expect(output.querySelector(".ac-stepper-unit")?.textContent).toBe("people");
    act(() => output.querySelector<HTMLButtonElement>('[aria-label="Decrease People"]')!.click());
    expect(output.querySelector(".ac-stepper-unit")?.textContent).toBe("person");
  });

  it("lands a decimal step on the decimal, not on floating-point noise", () => {
    const output = render(<sdk.Stepper label="Rate" defaultValue={0.1} step={0.1} min={0} max={1} />);
    act(() => output.querySelector<HTMLButtonElement>('[aria-label="Increase Rate"]')!.click());
    expect(output.querySelector('[role="spinbutton"]')?.getAttribute("aria-valuenow")).toBe("0.2");
  });

  it("keeps the last good number while what is typed is not one, and says why", () => {
    const seen: number[] = [];
    const output = render(
      <sdk.NumberField label="Bill total" defaultValue={100} min={0} prefix="$" onChange={(v) => seen.push(v)} />,
    );
    const input = output.querySelector("input")!;
    typeInto(input, "");
    expect(output.querySelector(".ac-field-error")?.textContent).toBe("Enter a number.");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    typeInto(input, "-4");
    expect(output.querySelector(".ac-field-error")?.textContent).toBe("It can't be less than 0.");
    typeInto(input, "1,250.5");
    expect(output.querySelector(".ac-field-error")).toBeNull();
    expect(seen).toEqual([1250.5]);
  });

  it("is a real radio group: one checked, arrow keys move the choice", () => {
    const seen: Array<string | number> = [];
    const output = render(
      <sdk.Choice
        label="Tip"
        defaultValue={0.1}
        options={[
          { label: "None", value: 0 },
          { label: "10%", value: 0.1 },
          { label: "15%", value: 0.15 },
        ]}
        onChange={(v) => seen.push(v)}
      />,
    );
    const group = output.querySelector('[role="radiogroup"]')!;
    const checked = () =>
      [...output.querySelectorAll('[role="radio"]')].map((b) => b.getAttribute("aria-checked"));
    expect(checked()).toEqual(["false", "true", "false"]);
    press(group, "ArrowRight");
    expect(checked()).toEqual(["false", "false", "true"]);
    press(group, "ArrowRight");
    expect(checked()).toEqual(["true", "false", "false"]);
    expect(seen).toEqual([0.15, 0]);
  });

  it("marks the answer row without colouring it", () => {
    const output = render(
      <List>
        <Row title="Tip" value="$27.96" />
        <Row title="Each pays" value="$53.59" emphasis />
      </List>,
    );
    const rows = output.querySelectorAll(".ac-row");
    expect(rows[0].classList.contains("ac-row-strong")).toBe(false);
    expect(rows[1].classList.contains("ac-row-strong")).toBe(true);
  });
});
