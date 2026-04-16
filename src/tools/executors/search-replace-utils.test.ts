import { describe, expect, it } from "vitest";

import {
  planMultiSearchReplace,
  planSearchReplace,
} from "./search-replace-utils";

describe("search-replace-utils", () => {
  it("handles CRLF files when the requested replacement uses LF", () => {
    const result = planSearchReplace(
      "const one = 1;\r\nconst two = 2;\r\n",
      {
        old_string: "const two = 2;\n",
        new_string: "const two = 3;\n",
        replace_all: false,
      },
    );

    expect(result.success).toBe(true);
    if (!result.success) {
      throw new Error("Expected replacement to succeed");
    }

    expect(result.content).toBe("const one = 1;\r\nconst two = 3;\r\n");
    expect(result.totalReplacements).toBe(1);
    expect(result.lineEndingNormalized).toBe(true);
  });

  it("reports overlapping batch replacements clearly", () => {
    const result = planMultiSearchReplace(
      [
        "function greet() {",
        "  const first = 'hello';",
        "  const second = 'world';",
        "  return first + second;",
        "}",
      ].join("\n"),
      [
        {
          old_string: [
            "function greet() {",
            "  const first = 'hello';",
            "  const second = 'world';",
          ].join("\n"),
          new_string: [
            "function greet() {",
            "  const first = 'hi';",
            "  const second = 'world';",
          ].join("\n"),
        },
        {
          old_string: [
            "  const second = 'world';",
            "  return first + second;",
          ].join("\n"),
          new_string: [
            "  const second = 'earth';",
            "  return first + second;",
          ].join("\n"),
        },
      ],
    );

    expect(result.success).toBe(false);
    if (result.success) {
      throw new Error("Expected overlap detection to fail");
    }

    expect(result.reason).toBe("overlap");
    expect(result.failedAt).toBe(2);
    expect(result.conflictingReplacement).toBe(1);
  });

  it("applies multiple non-overlapping replacements in one pass", () => {
    const result = planMultiSearchReplace(
      [
        "import { oldOne } from './one';",
        "import { oldTwo } from './two';",
        "",
        "const value = oldOne + oldTwo;",
      ].join("\n"),
      [
        {
          old_string: "import { oldOne } from './one';",
          new_string: "import { newOne } from './one';",
        },
        {
          old_string: "const value = oldOne + oldTwo;",
          new_string: "const value = newOne + oldTwo;",
        },
      ],
    );

    expect(result.success).toBe(true);
    if (!result.success) {
      throw new Error("Expected batch replacement to succeed");
    }

    expect(result.content).toBe(
      [
        "import { newOne } from './one';",
        "import { oldTwo } from './two';",
        "",
        "const value = newOne + oldTwo;",
      ].join("\n"),
    );
    expect(result.totalReplacements).toBe(2);
    expect(result.replacementDetails).toEqual([
      { index: 1, occurrences: 1, replaced: 1 },
      { index: 2, occurrences: 1, replaced: 1 },
    ]);
  });
});
