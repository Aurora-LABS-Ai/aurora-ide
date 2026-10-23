import { describe, expect, it } from "vitest";

import { boxKey, splitReply } from "./split";

describe("splitReply with the reply language", () => {
  it("cuts an aurora-ui fence only when layouts are on", () => {
    const text = 'Intro.\n\n```aurora-ui\nroot = Page([a])\na = Text("x")\n```\n\nOutro.';
    expect(splitReply(text, { layouts: true }).map((s) => s.kind)).toEqual(["markdown", "layout", "markdown"]);
    const [, layout] = splitReply(text, { layouts: true });
    expect(layout.kind === "layout" && [layout.language, layout.closed]).toEqual(["aurora-ui", true]);
    expect(splitReply(text).every((s) => s.kind === "markdown")).toBe(true);
  });

  // MiniMax M3.1, 2026-10-23: the layout written right, the fence left unnamed,
  // and the whole architecture drawn as a code block.
  it("draws an unnamed fence that opens with a layout statement", () => {
    const text = 'Intro.\n\n```\nstack = Facts("Shape", ["Root | `package.json`"])\n\nmodules = Tree([\n  "0 | apps"\n])\n```\n\nOutro.';
    const cut = splitReply(text, { layouts: true });
    expect(cut.map((s) => s.kind)).toEqual(["markdown", "layout", "markdown"]);
    expect(cut[1]).toMatchObject({ language: "aurora-ui", closed: true });
    expect((cut[1] as { source: string }).source.startsWith('stack = Facts("Shape"')).toBe(true);
    // Still streaming: the open fence is already a layout.
    const live = splitReply('```\nstack = Facts("Shape", ["Root | x"])\n', { layouts: true });
    expect(live).toMatchObject([{ kind: "layout", language: "aurora-ui", closed: false }]);
  });

  it("keeps an unnamed fence of ordinary code as code", () => {
    for (const code of ["```\nnpm install\n```", "```\nText(\"hi\")\n```", "```text\nconst root = Page()\n```", "```\n```"]) {
      expect(splitReply(`A.\n${code}\nB.`, { layouts: true })).toEqual([{ kind: "markdown", text: `A.\n${code}\nB.` }]);
    }
    // An unnamed fence with nothing in it yet stays text while it streams.
    expect(splitReply("A.\n```\n", { layouts: true })).toEqual([{ kind: "markdown", text: "A.\n```\n" }]);
    // Switch off: never a layout.
    expect(splitReply('```\nstack = Facts("S", ["A | B"])\n```').every((s) => s.kind === "markdown")).toBe(true);
  });
});

describe("splitting a reply into markdown and boxes", () => {
  it("leaves a reply with no box alone", () => {
    expect(splitReply("Just **text**.")).toEqual([{ kind: "markdown", text: "Just **text**." }]);
  });

  it("cuts a closed box out between two pieces of prose", () => {
    const reply = "Before.\n\n```aurora-box\nrow \"A\" = 1\n```\n\nAfter.";
    const segments = splitReply(reply);
    expect(segments.map((s) => s.kind)).toEqual(["markdown", "box", "markdown"]);
    expect(segments[1]).toMatchObject({ source: 'row "A" = 1', closed: true });
    expect((segments[2] as { text: string }).text.trim()).toBe("After.");
  });

  it("marks a box whose fence has not closed yet as still being written", () => {
    const segments = splitReply("Before.\n```aurora-box\nrow \"A\" = 1\nrow \"B");
    expect(segments[1]).toMatchObject({ kind: "box", closed: false, source: 'row "A" = 1\nrow "B' });
  });

  it("does not open a box inside another code block", () => {
    const reply = "Example:\n````markdown\n```aurora-box\nrow \"A\" = 1\n```\n````\nDone.";
    expect(splitReply(reply)).toEqual([{ kind: "markdown", text: reply }]);
  });

  it("keeps an ordinary code block as markdown, whatever follows", () => {
    const reply = "```ts\nconst a = 1;\n```\n```aurora-box\nrow \"A\" = 1\n```";
    expect(splitReply(reply).map((s) => s.kind)).toEqual(["markdown", "box"]);
  });

  it("cuts layout fences out only when asked, and keeps them as markdown otherwise", () => {
    const reply = "Intro.\n```aurora-facts\nA | 1\n```\nMiddle.\n```aurora-flow\nX\nY\n```";
    expect(splitReply(reply).map((s) => s.kind)).toEqual(["markdown"]);
    const cut = splitReply(reply, { layouts: true });
    expect(cut.map((s) => s.kind)).toEqual(["markdown", "layout", "markdown", "layout"]);
    expect(cut[1]).toMatchObject({ language: "aurora-facts", source: "A | 1", closed: true });
    expect(cut[3]).toMatchObject({ language: "aurora-flow", closed: true });
  });

  it("reports an unclosed layout fence as still streaming", () => {
    const cut = splitReply("```aurora-note\nTitle\nA | B", { layouts: true });
    expect(cut).toEqual([{ kind: "layout", language: "aurora-note", source: "Title\nA | B", closed: false, raw: "```aurora-note\nTitle\nA | B" }]);
  });

  it.each(["compare", "checklist", "timeline", "tree"])("keeps a documented %s fence inside an outer code block", (kind) => {
    const reply = `Example:\n\`\`\`\`markdown\n\`\`\`aurora-${kind}\nA | B | C\n\`\`\`\n\`\`\`\``;
    expect(splitReply(reply, { layouts: true })).toEqual([{ kind: "markdown", text: reply }]);
  });

  it("recognizes tilde layout fences while leaving unknown formats as code", () => {
    const reply = "~~~aurora-tree\n0 | Root\n~~~\n```aurora-unknown\nA | B\n```";
    const parts = splitReply(reply, { layouts: true });
    expect(parts[0]).toMatchObject({ kind: "layout", language: "aurora-tree", source: "0 | Root", closed: true });
    expect(parts[1]).toMatchObject({ kind: "markdown", text: "```aurora-unknown\nA | B\n```" });
  });

  it("keys a box by its text, so the live and reloaded copies match", () => {
    expect(boxKey('row "A" = 1')).toBe(boxKey('row "A" = 1\n'));
    expect(boxKey('row "A" = 1')).not.toBe(boxKey('row "A" = 2'));
    expect(boxKey("x")).toMatch(/^b[0-9a-f]{8}[0-9a-z]+$/);
  });
});
