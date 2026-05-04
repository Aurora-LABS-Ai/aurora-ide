import { describe, expect, it } from "vitest";

import {
  DEFAULT_LINE_WINDOW,
  MAX_SINGLE_READ_LINES,
  normalizeLineRange,
  sliceLineRange,
  splitLines,
} from "./file-read-policy";

describe("file read policy", () => {
  it("does not require a range for small files", () => {
    expect(normalizeLineRange({}, 10)).toBeNull();
  });

  it("returns a bounded default window for large files", () => {
    const range = normalizeLineRange({}, 2_000);

    expect(range).toEqual({
      endLine: DEFAULT_LINE_WINDOW,
      explicit: false,
      startLine: 1,
    });
  });

  it("honors exact line ranges with a safety cap", () => {
    const range = normalizeLineRange(
      { startLine: 100, endLine: 5_000 },
      10_000,
    );

    expect(range).toEqual({
      endLine: 100 + MAX_SINGLE_READ_LINES - 1,
      explicit: true,
      startLine: 100,
    });
  });

  it("slices lines with truncation metadata", () => {
    const lines = splitLines("one\ntwo\nthree\nfour");
    const result = sliceLineRange(lines, {
      endLine: 3,
      explicit: true,
      startLine: 2,
    });

    expect(result).toEqual({
      content: "two\nthree",
      endLine: 3,
      omittedLinesAfter: 1,
      omittedLinesBefore: 1,
      startLine: 2,
      truncated: true,
    });
  });
});
