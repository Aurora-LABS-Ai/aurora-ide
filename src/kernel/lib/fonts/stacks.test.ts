import { describe, expect, it } from "vitest";

import {
  AGENT_UI_FONT_STACK,
  CODE_FONT_STACK,
  primaryFamily,
  quoteFamily,
  stackWithPrimary,
} from "./stacks";

describe("quoteFamily", () => {
  it("quotes multi-word names and leaves identifiers and quoted names alone", () => {
    expect(quoteFamily("Segoe UI")).toBe('"Segoe UI"');
    expect(quoteFamily("monospace")).toBe("monospace");
    expect(quoteFamily('"Cascadia Code"')).toBe('"Cascadia Code"');
    expect(quoteFamily("Source Sans 3")).toBe('"Source Sans 3"');
  });
});

describe("primaryFamily", () => {
  it("returns the first family, unquoted", () => {
    expect(primaryFamily(AGENT_UI_FONT_STACK)).toBe("Inter Variable");
    expect(primaryFamily(CODE_FONT_STACK)).toBe("JetBrains Mono");
    expect(primaryFamily("monospace")).toBe("monospace");
  });
});

describe("stackWithPrimary", () => {
  it("puts the picked family first and keeps the fallback chain", () => {
    const stack = stackWithPrimary("Cambria", AGENT_UI_FONT_STACK);
    expect(stack.startsWith("Cambria,")).toBe(true);
    expect(stack).toContain("sans-serif");
  });

  it("quotes multi-word picks", () => {
    expect(stackWithPrimary("Comic Sans MS", "sans-serif")).toBe(
      '"Comic Sans MS", sans-serif',
    );
  });

  it("does not duplicate a family already in the base stack", () => {
    const stack = stackWithPrimary("JetBrains Mono", CODE_FONT_STACK);
    const count = stack.split(",").filter((f) => f.includes("JetBrains")).length;
    expect(count).toBe(1);
    expect(primaryFamily(stack)).toBe("JetBrains Mono");
  });

  it("returns the base stack unchanged for an empty pick", () => {
    expect(stackWithPrimary("  ", CODE_FONT_STACK)).toBe(CODE_FONT_STACK);
  });
});
