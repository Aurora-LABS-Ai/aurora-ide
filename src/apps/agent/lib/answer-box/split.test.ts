import { describe, expect, it } from "vitest";

import { boxKey, splitReply } from "./split";

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

  it("keys a box by its text, so the live and reloaded copies match", () => {
    expect(boxKey('row "A" = 1')).toBe(boxKey('row "A" = 1\n'));
    expect(boxKey('row "A" = 1')).not.toBe(boxKey('row "A" = 2'));
    expect(boxKey("x")).toMatch(/^b[0-9a-f]{8}[0-9a-z]+$/);
  });
});
