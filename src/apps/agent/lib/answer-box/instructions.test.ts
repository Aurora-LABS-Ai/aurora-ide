import { describe, expect, it } from "vitest";

import { ANSWER_BOX_EXAMPLES, answerBoxInstructions } from "./instructions";
import { parseBox } from "./parse";
import { splitReply } from "./split";

describe("what the model is told about answer boxes", () => {
  it("only shows examples the parser reads without a single error", () => {
    for (const [name, source] of Object.entries(ANSWER_BOX_EXAMPLES)) {
      expect({ name, errors: parseBox(source, { complete: true }).errors }).toEqual({ name, errors: [] });
    }
  });

  it("puts each example in a fence the splitter turns into a box", () => {
    const boxes = splitReply(answerBoxInstructions("chat")).filter((s) => s.kind === "box");
    expect(boxes).toHaveLength(3);
    for (const box of boxes) {
      if (box.kind !== "box") continue;
      expect(box.closed).toBe(true);
      expect(parseBox(box.source, { complete: true }).errors).toEqual([]);
    }
  });

  it("names every line kind the parser accepts", () => {
    const text = answerBoxInstructions("build");
    for (const kind of ["stepper", "number", "choice", "let", "title", "row", "total", "metric", "item", "note"]) {
      expect(text).toContain(`\`${kind} `);
    }
  });

  it("differs between the two sides only in when to reach for one", () => {
    const chat = answerBoxInstructions("chat");
    const build = answerBoxInstructions("build");
    expect(chat).not.toBe(build);
    expect(chat).toContain("splitting a bill");
    expect(build).toContain("Most coding answers do not need one.");
  });
});
