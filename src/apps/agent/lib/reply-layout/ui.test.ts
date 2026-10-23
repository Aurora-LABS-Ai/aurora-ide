import { describe, expect, it } from "vitest";

import { parseUi, readStatement, type UiPart } from "./ui";

/** The probe's card 03: the GADGET-POWER architecture reply, written in the language. */
const GADGET = `root = Page([scale, stack, t1, gates, boundary, request, start, docs])
scale = Stats([Stat("Route handlers", 94), Stat("\\"use client\\" files", 189), Stat("/api fetch call sites", 149), Stat("Admin files with role checks", 37)])
stack = Facts("Stack", ["Framework | Next.js 16 | App Router, React 19", "Data | Prisma 7 + PostgreSQL | \`@prisma/adapter-pg\`", "Auth | NextAuth v5 | JWT sessions, no Prisma adapter"])
t1 = Text("Four surfaces share one app, and one file outside \`app/\` runs before all of them.")
gates = Diagram("Routing and gates", [surfaces, gate, checks, data])
surfaces = Column("Surfaces", [Node("Storefront", "\`app/(client)/**\`"), Node("Admin", "\`app/admin/**\`"), Node("Auth", "\`app/auth/(shell)/**\`"), Node("REST API", "\`app/api/**/route.ts\`")])
gate = Column("First gate", [Node("\`proxy.ts\`", "Reads the JWT cookie, redirects or 401/403s by role")])
checks = Column("Second check", [Node("Admin layout", "Re-checks session and role"), Node("Route handlers", "Role test in 37 files"), Node("RSC pages", "Cached or \`force-dynamic\`")])
data = Column("Data", [Node("Prisma 7", "PostgreSQL")])
boundary = Compare("Server / client boundary", ["Aspect | Server | Client", "Rendering | RSC by default | \`\\"use client\\"\` files", "Server Actions | One stub file | Not used"])
request = Flow("Request lifecycle", ["Enter | \`proxy.ts\` reads the JWT cookie", "Gate | \`/admin\` → signin; \`/api/admin\` → 401/403", "Render | RSC page queries Prisma directly"])
start = Pairs("Where to start reading", ["Routing + gates | \`proxy.ts\`, \`app/admin/layout.tsx\`", "Write path | \`app/api/orders/route.ts:107\`"])
docs = Note("Docs lag the code", ["Doc | \`DOCS/01-ARCHITECTURE.md\`", "Reality | \`middleware.ts\` is now \`proxy.ts\`"], "Trust the source over the doc.")
`;

const kinds = (parts: UiPart[]) => parts.map((p) => (p.kind === "block" ? p.layout.kind : p.kind));

describe("reply language", () => {
  it("reads a whole answer: every part, in root order, with nothing skipped", () => {
    const layout = parseUi(GADGET, true);
    expect(layout.problems).toEqual([]);
    expect(kinds(layout.parts)).toEqual(["stats", "facts", "text", "diagram", "compare", "flow", "pairs", "note"]);

    const [stats, facts, , diagram, compare, flow, , note] = layout.parts;
    expect(stats.kind === "stats" && stats.stats.map((s) => s.value)).toEqual(["94", "189", "149", "37"]);
    expect(stats.kind === "stats" && stats.stats[1].label).toBe('"use client" files');
    expect(facts.kind === "block" && facts.layout.kind === "facts" && facts.layout.title).toBe("Stack");
    expect(facts.kind === "block" && facts.layout.kind === "facts" && facts.layout.facts).toHaveLength(3);
    expect(compare.kind === "block" && compare.layout.kind === "compare" && compare.layout.options).toEqual(["Server", "Client"]);
    expect(flow.kind === "block" && flow.heading).toBe("Request lifecycle");
    expect(note.kind === "block" && note.layout.kind === "note" && note.layout.lines.at(-1)).toEqual({ kind: "text", text: "Trust the source over the doc." });

    if (diagram.kind !== "diagram") throw new Error("expected a diagram");
    expect(diagram.columns.map((c) => c.nodes.length)).toEqual([4, 1, 3, 1]);
    // Fan in 4 → 1, fan out 1 → 3, fan in 3 → 1.
    expect(diagram.edges).toHaveLength(4 + 3 + 3);
  });

  it("draws each part when its line ends, never a half-written line or a fault mid-stream", () => {
    let drawn = 0;
    for (let at = 1; at <= GADGET.length; at += 7) {
      const layout = parseUi(GADGET.slice(0, at), false);
      expect(layout.problems).toEqual([]);
      expect(layout.parts.length).toBeGreaterThanOrEqual(drawn);
      drawn = layout.parts.length;
    }
    expect(parseUi(GADGET, false).parts).toHaveLength(8);

    // The last line has no newline yet: it is still being written.
    const partial = 'root = Page([a, b])\na = Text("first")\nb = Text("seco';
    expect(kinds(parseUi(partial, false).parts)).toEqual(["text"]);
  });

  it("waits for a name the root lists, and reports it once the fence closes", () => {
    const source = 'root = Page([a, later])\na = Text("here")\n';
    expect(parseUi(source, false)).toMatchObject({ problems: [] });
    expect(parseUi(source, false).parts).toHaveLength(1);
    expect(parseUi(source, true).problems).toEqual(["later — used but never written"]);
  });

  it("reads a statement the model wrapped over several lines once its brackets close", () => {
    const source = 'root = Page([stack])\nstack = Facts("Stack", [\n  "Runtime | Rust",\n  "Interface | React"\n])\n';
    expect(kinds(parseUi(source.slice(0, source.indexOf('  "Interface')), false).parts)).toEqual([]);
    const layout = parseUi(source, true);
    expect(layout.problems).toEqual([]);
    expect(layout.parts[0].kind === "block" && layout.parts[0].layout.kind === "facts" && layout.parts[0].layout.facts).toHaveLength(2);
  });

  it("never reads a title as a row, even one with a pipe in it", () => {
    const layout = parseUi('root = Page([f, s])\nf = Facts("A | B", ["Runtime | Rust"])\ns = Flow("Order", ["Validate", "Commit | One transaction"])\n', true);
    expect(layout.problems).toEqual([]);
    const [facts, flow] = layout.parts;
    expect(facts.kind === "block" && facts.layout.kind === "facts" && [facts.layout.title, facts.layout.facts.length]).toEqual(["A | B", 1]);
    expect(flow.kind === "block" && flow.heading).toBe("Order");
    expect(flow.kind === "block" && flow.layout.kind === "flow" && flow.layout.steps).toHaveLength(2);
  });

  it("names what it could not read and still draws the rest", () => {
    const layout = parseUi('root = Page([a, b, c, d])\na = Chart("x")\nb = Text("kept")\nc = Facts("T", ["only one field"])\nd = Text("unclosed\nstray line\n', true);
    expect(kinds(layout.parts)).toEqual(["text"]);
    expect(layout.problems).toEqual(
      expect.arrayContaining([
        'a — unknown part "Chart"',
        expect.stringContaining("c: only one field"),
        expect.stringContaining("never closed"),
      ]),
    );
  });

  // 2026-10-23: a 23-row Tree, one row per line, ran past the old 24-line
  // limit and was dropped as "never closed"; rows with the detail split in two
  // fields were dropped too.
  it("reads a long part written one row per line", () => {
    const rows = Array.from({ length: 23 }, (_, i) => `  "${i === 0 ? 0 : 1} | Module ${i}",`).join("\n");
    const layout = parseUi(`modules = Tree([\n${rows}\n  "1 | client | Electron 41 | the main product",\n  "0 | services |"\n])\n`, true);
    expect(layout.problems).toEqual([]);
    const [tree] = layout.parts;
    const nodes = tree.kind === "block" && tree.layout.kind === "tree" ? tree.layout.nodes : [];
    expect(nodes).toHaveLength(2);
    expect(nodes[0].children.at(-1)).toEqual({ title: "client", caption: "Electron 41 · the main product", children: [] });
  });

  it("reports a part written but never placed", () => {
    expect(parseUi('root = Page([a])\na = Text("x")\nlost = Text("y")\n', true).problems).toEqual(["lost — written but not placed in root"]);
  });

  it("without a root, draws every top-level part in the order written", () => {
    const layout = parseUi('Text("intro")\ncol = Column("C", [Node("n")])\nd = Diagram("D", [col])\nnote = Note("N", ["File | a.ts"])\n', true);
    expect(layout.problems).toEqual([]);
    expect(kinds(layout.parts)).toEqual(["text", "diagram", "note"]);
  });

  it("uses a diagram's named links instead of the fan, and names a link that goes nowhere", () => {
    const layout = parseUi(
      'root = Page([d])\nd = Diagram("D", [Column("A", [Node("x", ["p"]), Node("y", "caption", ["q", "missing"])]), Column("B", [Node("p"), Node("q")])])\n',
      true,
    );
    const [diagram] = layout.parts;
    expect(diagram.kind === "diagram" && diagram.edges).toEqual([
      { from: [0, 0], to: [1, 0] },
      { from: [0, 1], to: [1, 1] },
    ]);
    expect(diagram.kind === "diagram" && diagram.columns[0].nodes[1]).toEqual({ title: "y", caption: "caption" });
    expect(layout.problems).toEqual(['d — "y" links to "missing", which is not in the next column']);
  });

  it("reads a link card and source chips, and refuses anything that is not a web address", () => {
    const layout = parseUi(
      [
        "root = Page([card, cited, bad, bad2])",
        'card = Link("Open BS RoFormer on MVSep", "https://www.mvsep.com/en", "Official online audio separator", "Paid only")',
        'cited = Sources(["https://mvsep.com/algorithms", "Model page | https://github.com/ZFTurbo/x", "javascript:alert(1)"])',
        'bad = Link("Local", "file:///C:/secret.txt")',
        'bad2 = Link("No address")',
      ].join("\n") + "\n",
      true,
    );
    const [card, cited] = layout.parts;
    expect(card).toEqual({
      kind: "link",
      key: "card",
      title: "Open BS RoFormer on MVSep",
      source: { url: "https://www.mvsep.com/en", host: "mvsep.com" },
      caption: "Official online audio separator",
      badge: "Paid only",
    });
    expect(cited.kind === "sources" && cited.sources).toEqual([
      { url: "https://mvsep.com/algorithms", host: "mvsep.com" },
      { url: "https://github.com/ZFTurbo/x", host: "github.com", title: "Model page" },
    ]);
    expect(layout.parts).toHaveLength(2);
    expect(layout.problems).toEqual([
      'cited — "javascript:alert(1)" is not an http(s) address',
      'bad — "file:///C:/secret.txt" is not an http(s) address',
      'bad2 — a link is Link("Title", "https://…", "Optional line", "Optional badge")',
    ]);
  });

  it("refuses names that refer to each other in a loop", () => {
    const layout = parseUi("root = Page([a])\na = b\nb = a\n", true);
    expect(layout.parts).toEqual([]);
    expect(layout.problems.some((p) => p.includes("loop"))).toBe(true);
  });

  it("reads escapes, trailing commas and a trailing semicolon", () => {
    expect(readStatement('t = Text("say \\"hi\\"",);')).toEqual({ name: "t", value: { t: "call", name: "Text", args: [{ t: "str", v: 'say "hi"' }] } });
    expect(() => readStatement('t = Text("a") extra')).toThrow(/after the part/);
  });
});
