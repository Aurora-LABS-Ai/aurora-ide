/**
 * The instruction can only teach lines the parser reads: every example in it
 * must parse with no problems, and the fences in the prose must be cut out the
 * same way a reply's are.
 */
import { describe, expect, it } from "vitest";

import { splitReply } from "@/apps/agent/lib/answer-box/split";
import { REPLY_LAYOUT_EXAMPLES, REPLY_LAYOUT_INSTRUCTIONS } from "./instructions";
import { parseLayout } from "./parse";

describe("reply layout instructions", () => {
  it("every example parses clean", () => {
    const facts = parseLayout("aurora-facts", REPLY_LAYOUT_EXAMPLES.facts, true);
    const flow = parseLayout("aurora-flow", REPLY_LAYOUT_EXAMPLES.flow, true);
    const note = parseLayout("aurora-note", REPLY_LAYOUT_EXAMPLES.note, true);
    const bars = parseLayout("aurora-bars", REPLY_LAYOUT_EXAMPLES.bars, true);
    const pairs = parseLayout("aurora-pairs", REPLY_LAYOUT_EXAMPLES.pairs, true);
    for (const block of [facts, flow, note, bars, pairs]) expect(block.problems).toEqual([]);
    expect(facts.kind === "facts" && facts.facts).toHaveLength(4);
    expect(flow.kind === "flow" && flow.steps.map((s) => s.items.length)).toEqual([1, 1, 4, 1, 1]);
    expect(note.kind === "note" && note.title).toBe("The route-group trap");
    expect(bars.kind === "bars" && bars.bars.map((b) => [b.value, b.max])).toEqual([[31, 97], [155, 193]]);
    expect(pairs.kind === "pairs" && pairs.title).toBe("Route structure");
    expect(pairs.kind === "pairs" && pairs.pairs).toHaveLength(5);
  });

  it("its five fences are the five the reply splitter cuts out", () => {
    const layouts = splitReply(REPLY_LAYOUT_INSTRUCTIONS, { layouts: true }).filter((s) => s.kind === "layout");
    expect(layouts.map((s) => (s.kind === "layout" ? s.language : ""))).toEqual([
      "aurora-facts",
      "aurora-flow",
      "aurora-note",
      "aurora-bars",
      "aurora-pairs",
    ]);
    expect(layouts.every((s) => s.kind === "layout" && s.closed)).toBe(true);
  });

  it("stays plain text with the setting off", () => {
    expect(splitReply(REPLY_LAYOUT_INSTRUCTIONS).every((s) => s.kind === "markdown")).toBe(true);
  });
});
