import { describe, expect, it } from "vitest";

import {
  numberOrUndefined,
  parseAliases,
  parseParams,
  stringifyAliases,
} from "./provider-advanced-fields";

describe("model aliases", () => {
  it("reads alias=id lines, skipping blanks and lines with no id or no alias", () => {
    expect(parseAliases("fast = claude-3-5-haiku-20241022\n\n=nothing\nbroken\nbest=opus")).toEqual({
      fast: "claude-3-5-haiku-20241022",
      best: "opus",
    });
  });

  it("round-trips through the text form", () => {
    const record = { fast: "haiku", best: "opus" };
    expect(parseAliases(stringifyAliases(record))).toEqual(record);
    expect(stringifyAliases(undefined)).toBe("");
  });
});

describe("extra request parameters", () => {
  it("accepts a JSON object and treats empty text as none", () => {
    expect(parseParams('{"top_p": 0.9}')).toEqual({ value: { top_p: 0.9 } });
    expect(parseParams("   ")).toEqual({ value: {} });
  });

  it("refuses arrays, scalars and broken JSON with a reason, never a throw", () => {
    expect(parseParams("[1,2]").error).toMatch(/JSON object/);
    expect(parseParams("42").error).toMatch(/JSON object/);
    expect(parseParams("{oops").error).toMatch(/Not valid JSON/);
  });
});

describe("numberOrUndefined", () => {
  it("means unset for empty or unparseable text", () => {
    expect(numberOrUndefined("0.7")).toBe(0.7);
    expect(numberOrUndefined("  ")).toBeUndefined();
    expect(numberOrUndefined("abc")).toBeUndefined();
  });
});
