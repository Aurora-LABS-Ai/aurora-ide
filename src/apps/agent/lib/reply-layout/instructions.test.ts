/**
 * The instruction can only teach lines the parser reads: every example in it
 * and in the on-demand guide must parse with no problems, and the fences in
 * the prose must be cut out the same way a reply's are.
 */
import { describe, expect, it } from "vitest";

import { splitReply } from "@/apps/agent/lib/answer-box/split";
import { REPLY_LAYOUT_EXAMPLES, REPLY_LAYOUT_INSTRUCTIONS, UI_PROMPT_LINES } from "./instructions";
import { LAYOUT_FENCE_LANGUAGES, layoutIsEmpty, parseLayout } from "./parse";
import { UI_PARTS, parseUi } from "./ui";
import GUIDE from "./guide.md?raw";

describe("reply layout instructions", () => {
  it("the fixture layout parses clean", () => {
    const layout = parseUi(UI_PROMPT_LINES.join("\n"), true);
    expect(layout.problems).toEqual([]);
    expect(layout.parts.map((p) => (p.kind === "block" ? p.layout.kind : p.kind))).toEqual(["facts", "flow", "note"]);
  });

  // Alvan, 2026-10-23: the prompt says load the guide first, and nothing more.
  // The language lives in the guide alone.
  it("the prompt requires the guide before a layout and teaches no part", () => {
    expect(REPLY_LAYOUT_INSTRUCTIONS).toContain("aurora-ui");
    expect(REPLY_LAYOUT_INSTRUCTIONS).toContain('`canvas_guidelines` with `topic: "reply-layout"` first');
    expect(REPLY_LAYOUT_INSTRUCTIONS).toContain("Never write one from memory");
    for (const part of UI_PARTS) expect(REPLY_LAYOUT_INSTRUCTIONS).not.toContain(`${part}(`);
  });

  it("the guide carries the rules the prompt used to", () => {
    expect(GUIDE).toContain("an unnamed fence is drawn as code");
    expect(GUIDE).toContain("a Tree 32");
    expect(GUIDE).toContain("`C:\\Users\\name`");
    expect(GUIDE).toContain("No header row");
  });

  it("a Windows path keeps its backslashes", () => {
    const layout = parseUi(
      'root = Page([w])\nw = Pairs("Where", ["Location | C:\\Users\\Alvan\\Documents\\tv-remote", "Modules | E:\\repo\\node_modules"])\n',
      true,
    );
    expect(layout.problems).toEqual([]);
    expect(JSON.stringify(layout)).toContain("C:\\\\Users\\\\Alvan\\\\Documents\\\\tv-remote");
    expect(JSON.stringify(layout)).toContain("E:\\\\repo\\\\node_modules");
  });

  it("the guide's example is one aurora-ui fence that parses clean", () => {
    const layouts = splitReply(GUIDE, { layouts: true }).filter((s) => s.kind === "layout");
    expect(layouts.map((s) => (s.kind === "layout" ? s.language : ""))).toEqual(["aurora-ui"]);
    const [fence] = layouts;
    if (fence.kind !== "layout") throw new Error("unreachable");
    expect(fence.closed).toBe(true);
    const layout = parseUi(fence.source, true);
    expect(layout.problems).toEqual([]);
    expect(layout.parts.map((p) => p.kind)).toEqual(["stats", "block", "diagram", "block", "block", "block", "block"]);
  });

  it("the guide names every part and the report contract", () => {
    for (const part of UI_PARTS) expect(GUIDE).toContain(`${part}(`);
    expect(GUIDE).toContain("aurora-report");
  });

  it("teaches one fence, never the single-block fences", () => {
    expect(REPLY_LAYOUT_INSTRUCTIONS).not.toMatch(/aurora-(facts|flow|note|bars|pairs|compare|checklist|timeline|tree)\b/);
  });

  it("keeps the standing prompt short and fence-free", () => {
    expect(REPLY_LAYOUT_INSTRUCTIONS.length).toBeLessThan(500);
    expect(REPLY_LAYOUT_INSTRUCTIONS).not.toContain("```");
  });

  it("stays plain text with the setting off", () => {
    expect(splitReply(REPLY_LAYOUT_INSTRUCTIONS).every((s) => s.kind === "markdown")).toBe(true);
  });

  it("the single-block fixtures old chats hold still parse clean", () => {
    for (const [language, kind] of Object.entries(LAYOUT_FENCE_LANGUAGES)) {
      const block = parseLayout(language as keyof typeof LAYOUT_FENCE_LANGUAGES, REPLY_LAYOUT_EXAMPLES[kind], true);
      expect(block.problems).toEqual([]);
      expect(layoutIsEmpty(block)).toBe(false);
    }
  });
});
