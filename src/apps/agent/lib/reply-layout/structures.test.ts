import { describe, expect, it } from "vitest";

import { MAX_ITEMS, layoutIsEmpty, parseLayout, type LayoutLanguage } from "./parse";

describe("reply layout comparisons", () => {
  it("keeps option headers and matching values, including literal pipes and code", () => {
    expect(parseLayout("aurora-compare", "Choices\nAspect | A | B\nCommand | `a \\| b` | `c`\nStorage | Local | Remote", true)).toEqual({
      kind: "compare", title: "Choices", heading: "Aspect", options: ["A", "B"],
      rows: [{ label: "Command", values: ["`a | b`", "`c`"] }, { label: "Storage", values: ["Local", "Remote"] }], problems: [],
    });
  });

  it.each(["Aspect | A", "Aspect | A | ", "Aspect | A | B | C | D | E"])("rejects an invalid header %s", (header) => {
    const parsed = parseLayout("aurora-compare", `${header}\nRow | 1 | 2`, true);
    expect(layoutIsEmpty(parsed)).toBe(true);
    expect(parsed.problems).toHaveLength(1);
  });

  it("reports incomplete and extra cells instead of shifting the comparison", () => {
    const parsed = parseLayout("aurora-compare", "Aspect | A | B\nMissing | One\nEmpty | | Two\nExtra | One | Two | Three\nValid | One | Two", true);
    expect(parsed.kind === "compare" && parsed.rows).toEqual([{ label: "Valid", values: ["One", "Two"] }]);
    expect(parsed.problems).toHaveLength(3);
  });
});

describe("reply layout checklists", () => {
  it("reads all explicit states without inferring completion", () => {
    const parsed = parseLayout("aurora-checklist", "Readiness\ndone | Build | Bundle saved\ndoing | Tests\nblocked | Sign | Missing certificate\ntodo | Publish", true);
    expect(parsed.kind === "checklist" && parsed.items).toEqual([
      { status: "done", title: "Build", caption: "Bundle saved" },
      { status: "doing", title: "Tests" },
      { status: "blocked", title: "Sign", caption: "Missing certificate" },
      { status: "todo", title: "Publish" },
    ]);
    expect(parsed.problems).toEqual([]);
  });

  it("reports unknown states, missing labels and extra fields", () => {
    const parsed = parseLayout("aurora-checklist", "complete | Build\ntodo |\ndone | Build | detail | hidden\nconstructor | unsafe\ntodo | Publish", true);
    expect(parsed.kind === "checklist" && parsed.items).toEqual([{ status: "todo", title: "Publish" }]);
    expect(parsed.problems).toHaveLength(4);
  });
});

describe("reply layout timelines", () => {
  it("preserves supplied order and periods without guessing dates", () => {
    const parsed = parseLayout("aurora-timeline", "Rollout\nWeek 2 | Deploy | Staging first\nWeek 1 | Prepare\nUnknown | Review", true);
    expect(parsed.kind === "timeline" && parsed.items).toEqual([
      { when: "Week 2", title: "Deploy", caption: "Staging first" },
      { when: "Week 1", title: "Prepare" },
      { when: "Unknown", title: "Review" },
    ]);
    expect(parsed.problems).toEqual([]);
  });

  it("reports missing events and extra fields", () => {
    const parsed = parseLayout("aurora-timeline", "09:10 |\n| Restart\n09:20 | Restored | Detail | Lost\n09:30 | Verified", true);
    expect(parsed.kind === "timeline" && parsed.items).toHaveLength(1);
    expect(parsed.problems).toHaveLength(3);
  });
});

describe("reply layout trees", () => {
  it("attaches children to their nearest parent and supports multiple roots", () => {
    expect(parseLayout("aurora-tree", "Ownership\n0 | App\n1 | Components | Views\n2 | Reply layout\n1 | Services\n0 | Kernel", true)).toEqual({
      kind: "tree", title: "Ownership", nodes: [
        { title: "App", children: [
          { title: "Components", caption: "Views", children: [{ title: "Reply layout", children: [] }] },
          { title: "Services", children: [] },
        ] },
        { title: "Kernel", children: [] },
      ], problems: [],
    });
  });

  it("rejects orphaned nodes and invalid depths, then recovers at a valid level", () => {
    const parsed = parseLayout("aurora-tree", "1 | Orphan\n0 | Root\n2 | Skipped\n-1 | Negative\n1.0 | Decimal\n5 | Deep\n0 | Recovered\n1 | Valid\n2 | Child", true);
    expect(parsed.problems).toHaveLength(5);
    expect(parsed.kind === "tree" && parsed.nodes[1].children).toEqual([
      { title: "Valid", children: [{ title: "Child", children: [] }] },
    ]);
  });

  it("does not attach descendants of a rejected parent to an earlier sibling", () => {
    const parsed = parseLayout("aurora-tree", "0 | Root\n1 | Earlier sibling\n1 | | Missing parent\n2 | Orphan\n1 | Valid sibling", true);
    expect(parsed.problems).toHaveLength(2);
    expect(parsed.kind === "tree" && parsed.nodes[0].children).toEqual([
      { title: "Earlier sibling", children: [] }, { title: "Valid sibling", children: [] },
    ]);
  });
});

const CASES: { language: LayoutLanguage; source: string; count: (parsed: ReturnType<typeof parseLayout>) => number }[] = [
  { language: "aurora-compare", source: "Aspect | A | B\nStorage | Local | Remote", count: (p) => p.kind === "compare" ? p.rows.length : 0 },
  { language: "aurora-checklist", source: "Release\ndone | Build", count: (p) => p.kind === "checklist" ? p.items.length : 0 },
  { language: "aurora-timeline", source: "History\n09:10 | Restored", count: (p) => p.kind === "timeline" ? p.items.length : 0 },
  { language: "aurora-tree", source: "Ownership\n0 | Root", count: (p) => p.kind === "tree" ? p.nodes.length : 0 },
];

describe.each(CASES)("$language streaming and bounds", ({ language, source, count }) => {
  it("holds every prefix of an unfinished row until newline or closure", () => {
    for (let length = 0; length <= source.length; length += 1) {
      const partial = parseLayout(language, source.slice(0, length), false);
      expect(count(partial)).toBe(0);
    }
    expect(count(parseLayout(language, `${source}\n`, false))).toBe(1);
    expect(count(parseLayout(language, source, true))).toBe(1);
  });

  it("reports overflow beyond the shared item limit", () => {
    const [header, row] = source.split("\n");
    const parsed = parseLayout(language, [header, ...Array<string>(MAX_ITEMS + 2).fill(row)].join("\n"), true);
    expect(count(parsed)).toBe(MAX_ITEMS);
    expect(parsed.problems).toHaveLength(2);
  });
});
