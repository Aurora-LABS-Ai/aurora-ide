import { describe, expect, it } from "vitest";

import { inlineRuns, layoutIsEmpty, parseLayout, splitFields } from "./parse";

describe("reply layout — fields", () => {
  it("splits on pipes, trims, and keeps an escaped pipe", () => {
    expect(splitFields("Framework | Next.js 16.2.3 | App Router")).toEqual(["Framework", "Next.js 16.2.3", "App Router"]);
    expect(splitFields("a \\| b | c")).toEqual(["a | b", "c"]);
  });

  it("drops one empty field after a closing pipe, keeps empty fields inside", () => {
    expect(splitFields("Answers | Am I near a limit? | What do I get? |")).toEqual(["Answers", "Am I near a limit?", "What do I get?"]);
    expect(splitFields("a | | c")).toEqual(["a", "", "c"]);
    expect(splitFields("a \\|")).toEqual(["a |"]);
  });

  it("reads a Compare whose rows end in a pipe (live, 2026-10-23)", () => {
    const layout = parseLayout(
      "aurora-compare",
      "Where it lives\nAspect | Card | Page |\nAnswers | Am I near a limit? | What do I get, and how does it work? |",
      true,
    );
    expect(layout.problems).toEqual([]);
    expect(layout.kind === "compare" && layout.rows[0].values).toEqual(["Am I near a limit?", "What do I get, and how does it work?"]);
  });

  it("splits side-by-side items on a double pipe only", () => {
    expect(splitFields("Storefront / || Admin /admin || Auth | sign-in", "||")).toEqual([
      "Storefront /",
      "Admin /admin",
      "Auth | sign-in",
    ]);
  });

  it("picks code spans out of a field", () => {
    expect(inlineRuns("Gate is `proxy.ts`, not middleware")).toEqual([
      { kind: "text", text: "Gate is " },
      { kind: "code", text: "proxy.ts" },
      { kind: "text", text: ", not middleware" },
    ]);
    expect(inlineRuns("an unclosed ` tick")).toEqual([{ kind: "text", text: "an unclosed ` tick" }]);
  });
});

describe("reply layout — facts", () => {
  it("reads label, value and an optional caption", () => {
    const out = parseLayout("aurora-facts", "Framework | Next.js 16.2.3 | App Router · React 19\nDatabase | PostgreSQL\n", true);
    expect(out).toEqual({
      kind: "facts",
      title: "",
      facts: [
        { label: "Framework", value: "Next.js 16.2.3", caption: "App Router · React 19" },
        { label: "Database", value: "PostgreSQL" },
      ],
      problems: [],
    });
  });

  it("reads a one-field first line as the title, as bars and pairs do", () => {
    const out = parseLayout("aurora-facts", "Stack\nFramework | Next.js 16 | App Router\n", true);
    expect(out.kind === "facts" && out.title).toBe("Stack");
    expect(out.kind === "facts" && out.facts).toHaveLength(1);
    expect(out.problems).toEqual([]);
  });

  it("skips and names a line without a value", () => {
    const out = parseLayout("aurora-facts", "A | B\nJust a label\n", true);
    expect(out.kind === "facts" && out.facts).toHaveLength(1);
    expect(out.problems[0]).toContain("Just a label");
  });

  it("leaves a half-written last line out while streaming, and reads it once closed", () => {
    const open = parseLayout("aurora-facts", "A | 1\nB | 2", false);
    expect(open.kind === "facts" && open.facts.map((f) => f.label)).toEqual(["A"]);
    const closed = parseLayout("aurora-facts", "A | 1\nB | 2", true);
    expect(closed.kind === "facts" && closed.facts.map((f) => f.label)).toEqual(["A", "B"]);
  });
});

describe("reply layout — flow", () => {
  it("reads steps top to bottom, with side-by-side items on one line", () => {
    const out = parseLayout(
      "aurora-flow",
      ["Incoming request", "proxy.ts | Single gate", "Storefront / || Admin /admin || API /api", "PostgreSQL | One database"].join("\n"),
      true,
    );
    expect(out.kind).toBe("flow");
    if (out.kind !== "flow") return;
    expect(out.steps.map((s) => s.items.length)).toEqual([1, 1, 3, 1]);
    expect(out.steps[1].items[0]).toEqual({ title: "proxy.ts", caption: "Single gate" });
    expect(out.steps[2].items[1]).toEqual({ title: "Admin /admin" });
  });

  it("drops an empty item and reports a line with nothing in it", () => {
    const out = parseLayout("aurora-flow", "A || \n|\n", true);
    expect(out.kind === "flow" && out.steps).toHaveLength(1);
    expect(out.problems).toHaveLength(1);
  });

  it("preserves escaped pipes through both branch and field splitting", () => {
    const out = parseLayout("aurora-flow", "`a \\| b` | Filter || Other | Fallback", true);
    expect(out.kind === "flow" && out.steps[0].items).toEqual([
      { title: "`a | b`", caption: "Filter" }, { title: "Other", caption: "Fallback" },
    ]);
  });
});

describe("reply layout — bars", () => {
  it("reads a title, then label and amount as count of max, percent, or bare number", () => {
    const out = parseLayout(
      "aurora-bars",
      ["Client component distribution", "app/*.tsx | 31 / 97", "components/ | 155 of 193 | islands", "Cache hit | 64%", "Handlers | 95"].join("\n"),
      true,
    );
    expect(out.kind).toBe("bars");
    if (out.kind !== "bars") return;
    expect(out.title).toBe("Client component distribution");
    expect(out.bars[0]).toEqual({ label: "app/*.tsx", value: 31, max: 97, shown: "31 / 97" });
    expect(out.bars[1]).toMatchObject({ value: 155, max: 193, caption: "islands" });
    expect(out.bars[2]).toMatchObject({ value: 64, max: 100, shown: "64%" });
    // A bare number scales against the largest bare number in the block.
    expect(out.bars[3]).toMatchObject({ value: 95, max: 95, shown: "95" });
    expect(out.problems).toEqual([]);
  });

  it("takes a bare max in the third field, and names a line with no amount", () => {
    const out = parseLayout("aurora-bars", "Client | 31 | 97 | of the app\nNo number here\n", true);
    expect(out.kind === "bars" && out.bars[0]).toMatchObject({ value: 31, max: 97, shown: "31 / 97", caption: "of the app" });
    expect(out.problems[0]).toContain("No number here");
  });
});

describe("reply layout — pairs", () => {
  it("reads an optional title and label / value rows", () => {
    const out = parseLayout("aurora-pairs", "Route structure\n`app/(client)/` | Storefront\n`proxy.ts` | 4 access gates\n", true);
    expect(out).toEqual({
      kind: "pairs",
      title: "Route structure",
      pairs: [
        { label: "`app/(client)/`", value: "Storefront" },
        { label: "`proxy.ts`", value: "4 access gates" },
      ],
      problems: [],
    });
    const untitled = parseLayout("aurora-pairs", "A | 1\nB | 2\n", true);
    expect(untitled.kind === "pairs" && untitled.title).toBe("");
    expect(untitled.kind === "pairs" && untitled.pairs).toHaveLength(2);
  });
});

describe("reply layout — note", () => {
  it("reads a title, pairs and sentences", () => {
    const out = parseLayout(
      "aurora-note",
      ["The route-group trap", "File location | app/(client)/test-assets/page.tsx", "Actual public URL | /test-assets", "The folder is under the group."].join("\n"),
      true,
    );
    expect(out).toEqual({
      kind: "note",
      title: "The route-group trap",
      lines: [
        { kind: "pair", label: "File location", value: "app/(client)/test-assets/page.tsx" },
        { kind: "pair", label: "Actual public URL", value: "/test-assets" },
        { kind: "text", text: "The folder is under the group." },
      ],
      problems: [],
    });
  });

  it("has no title when the model started with a pair", () => {
    const out = parseLayout("aurora-note", "A | B\nMore.\n", true);
    expect(out.kind === "note" && out.title).toBe("");
    expect(out.kind === "note" && out.lines).toHaveLength(2);
  });

  it("knows when there is nothing to draw", () => {
    expect(layoutIsEmpty(parseLayout("aurora-note", "", true))).toBe(true);
    expect(layoutIsEmpty(parseLayout("aurora-facts", "x\n", true))).toBe(true);
    expect(layoutIsEmpty(parseLayout("aurora-flow", "A\n", true))).toBe(false);
    expect(layoutIsEmpty(parseLayout("aurora-bars", "Only a title\n", true))).toBe(true);
    expect(layoutIsEmpty(parseLayout("aurora-pairs", "A | 1\n", true))).toBe(false);
  });
});
