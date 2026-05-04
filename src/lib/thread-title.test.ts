import { describe, expect, it } from "vitest";

import {
  deriveThreadTitle,
  FALLBACK_TITLE,
  MAX_TITLE_CHARS,
  MAX_TITLE_WORDS,
} from "./thread-title";

describe("deriveThreadTitle", () => {
  it("falls back when input is empty or whitespace-only", () => {
    expect(deriveThreadTitle("")).toBe(FALLBACK_TITLE);
    expect(deriveThreadTitle("   \n\t")).toBe(FALLBACK_TITLE);
  });

  it("uses a short message verbatim", () => {
    expect(deriveThreadTitle("Refactor the auth middleware")).toBe(
      "Refactor the auth middleware",
    );
  });

  it("caps long messages at the word limit and adds an ellipsis", () => {
    const title = deriveThreadTitle(
      "Refactor the authentication middleware to use JWT tokens with proper rotation and revocation support",
    );
    expect(title.endsWith("\u2026")).toBe(true);
    const wordCount = title
      .replace(/\u2026$/, "")
      .split(/\s+/)
      .filter(Boolean).length;
    expect(wordCount).toBeLessThanOrEqual(MAX_TITLE_WORDS);
  });

  it("strips fenced code blocks (```)", () => {
    const input = "Fix this bug:\n```rust\nfn broken() {}\n```\nthanks";
    expect(deriveThreadTitle(input)).toBe("Fix this bug: thanks");
  });

  it("strips tilde-fenced code blocks (~~~)", () => {
    const input = "Hello\n~~~\nsecret\n~~~\nworld";
    expect(deriveThreadTitle(input)).toBe("Hello world");
  });

  it("treats unclosed fences as 'strip to end of input'", () => {
    expect(deriveThreadTitle("Look at\n```\nstuff that never closes")).toBe(
      "Look at",
    );
  });

  it("inlines short backtick spans", () => {
    expect(deriveThreadTitle("Update `useThreadStore` to upsert")).toBe(
      "Update useThreadStore to upsert",
    );
  });

  it("drops oversized inline-code spans", () => {
    const title = deriveThreadTitle(
      "Make this work `const x = JSON.parse(very long block here exceeding limit)` please",
    );
    expect(title).toContain("Make this work");
    expect(title).toContain("please");
    expect(title).not.toContain("JSON.parse");
  });

  it("strips JSON blobs that look machine-generated", () => {
    const input = 'Use these settings:\n{"foo": 1, "bar": 2}\nthanks';
    expect(deriveThreadTitle(input)).toBe("Use these settings: thanks");
  });

  it("preserves curly-brace prose without quotes/colons", () => {
    expect(deriveThreadTitle("Wrap this in {curly braces}")).toContain(
      "Wrap this in",
    );
  });

  it("strips bare JSON-array lines", () => {
    expect(deriveThreadTitle('Sort:\n["alpha", "beta"]\ndone')).toBe(
      "Sort: done",
    );
  });

  it("trims markdown heading markers", () => {
    expect(deriveThreadTitle("### Refactor the database layer")).toBe(
      "Refactor the database layer",
    );
  });

  it("trims surrounding quotation marks", () => {
    expect(deriveThreadTitle('"Hello world"')).toBe("Hello world");
    expect(deriveThreadTitle("'Quick fix'")).toBe("Quick fix");
  });

  it("falls back when message is only a code block", () => {
    expect(deriveThreadTitle("```rust\nfn main() {}\n```")).toBe(
      FALLBACK_TITLE,
    );
  });

  it("handles unicode without panicking", () => {
    const title = deriveThreadTitle(
      "Translate \u00ABПривет, мир!\u00BB to Japanese",
    );
    expect(title.startsWith("Translate")).toBe(true);
    expect(Array.from(title).length).toBeLessThanOrEqual(MAX_TITLE_CHARS + 1);
  });

  it("truncates extremely long single-word inputs at the char cap", () => {
    const title = deriveThreadTitle("a".repeat(200));
    expect(title.endsWith("\u2026")).toBe(true);
    expect(Array.from(title).length).toBeLessThanOrEqual(MAX_TITLE_CHARS);
  });

  it("collapses whitespace runs to single spaces", () => {
    expect(deriveThreadTitle("Hello     world\n\n\nfoo\t\tbar")).toBe(
      "Hello world foo bar",
    );
  });

  it("produces a clean title for the realistic 'fix asap + code' pattern", () => {
    const input =
      "fix this issue please asap\n\n```\nerror: cannot find module 'react'\n```";
    expect(deriveThreadTitle(input)).toBe("fix this issue please asap");
  });

  it("strips multi-line JSON pasted after prose", () => {
    const input =
      'Update my settings to:\n{\n  "theme": "dark",\n  "fontSize": 14\n}';
    // Trailing `:` is decorative once the JSON it introduced is gone.
    expect(deriveThreadTitle(input)).toBe("Update my settings to");
  });

  it("keeps internal colons but strips trailing ones", () => {
    expect(
      deriveThreadTitle(
        'Use these settings:\n{"foo": 1, "bar": 2}\nthanks',
      ),
    ).toBe("Use these settings: thanks");
  });
});
