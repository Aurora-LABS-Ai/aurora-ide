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
  it("the prompt's lines parse clean, as one layout", () => {
    const layout = parseUi(UI_PROMPT_LINES.join("\n"), true);
    expect(layout.problems).toEqual([]);
    expect(layout.parts.map((p) => (p.kind === "block" ? p.layout.kind : p.kind))).toEqual(["facts", "flow", "note"]);
    for (const line of UI_PROMPT_LINES) expect(REPLY_LAYOUT_INSTRUCTIONS).toContain(line);
  });

  it("the guide's example is one aurora-ui fence that parses clean", () => {
    const layouts = splitReply(GUIDE, { layouts: true }).filter((s) => s.kind === "layout");
    expect(layouts.map((s) => (s.kind === "layout" ? s.language : ""))).toEqual(["aurora-ui"]);
    const [fence] = layouts;
    if (fence.kind !== "layout") throw new Error("unreachable");
    expect(fence.closed).toBe(true);
    const layout = parseUi(fence.source, true);
    expect(layout.problems).toEqual([]);
    expect(layout.parts.map((p) => p.kind)).toEqual(["stats", "block", "diagram", "block", "block", "block"]);
  });

  it("the guide names every part, and the prompt points at it", () => {
    for (const part of UI_PARTS) expect(GUIDE).toContain(`${part}(`);
    expect(GUIDE).toContain("aurora-report");
    expect(REPLY_LAYOUT_INSTRUCTIONS).toContain('topic: "reply-layout"');
    expect(REPLY_LAYOUT_INSTRUCTIONS).toContain('topic: "reports"');
  });

  it("teaches one fence, never the single-block fences or a header row", () => {
    expect(REPLY_LAYOUT_INSTRUCTIONS).toContain("aurora-ui");
    expect(REPLY_LAYOUT_INSTRUCTIONS).not.toMatch(/aurora-(facts|flow|note|bars|pairs|compare|checklist|timeline|tree)\b/);
    // 2026-10-16: "rows `Label | Value | Detail`" came back as a literal
    // `Surface | Location | Notes` first row in every block.
    expect(REPLY_LAYOUT_INSTRUCTIONS).not.toMatch(/Label \| Value|Step \| Detail|Key \| Value/);
    expect(REPLY_LAYOUT_INSTRUCTIONS).toContain("no header row");
  });

  it("keeps the standing prompt short and fence-free", () => {
    expect(REPLY_LAYOUT_INSTRUCTIONS.length).toBeLessThan(1200);
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
