import { describe, expect, it } from "vitest";

import { parseToolResult } from "./tool-result";

describe("persisted file tool results", () => {
  it("recovers a truncated file read as highlighted source content", () => {
    const parsed = parseToolResult(
      "file_read",
      { path: "src/example.ts" },
      '{"content":"export const answer = 42;\\nexport const next =\n\n[truncated 9000 bytes — tool returned 17192 bytes total, kept first 8192]',
    );

    expect(parsed.codePath).toBe("src/example.ts");
    expect(parsed.code).toBe("export const answer = 42;\nexport const next =");
    expect(parsed.code).not.toContain('{"content"');
  });

  it("uses edit arguments to reconstruct every file when persisted JSON was cut", () => {
    const parsed = parseToolResult(
      "file_edit",
      {
        edits: [
          { path: "src/a.ts", old_string: "const a = 1;", new_string: "const a = 2;" },
          { path: "src/b.ts", old_string: "const b = 1;", new_string: "const b = 2;" },
        ],
      },
      '{"files":[{"newContent":"const a = 2;\n\n[truncated 12000 bytes — tool returned 20192 bytes total, kept first 8192]',
    );

    expect(parsed.code).toBeNull();
    expect(parsed.diffs).toEqual([
      {
        path: "src/a.ts",
        oldText: "const a = 1;",
        newText: "const a = 2;",
      },
      {
        path: "src/b.ts",
        oldText: "const b = 1;",
        newText: "const b = 2;",
      },
    ]);
  });

  it("keeps batch read contents for per-file syntax highlighting", () => {
    const parsed = parseToolResult(
      "file_read",
      { paths: ["src/a.ts", "src/b.py"] },
      JSON.stringify({
        success: true,
        filesRead: 2,
        files: [
          { path: "src/a.ts", success: true, content: "export const a = 1;", lines: 1 },
          { path: "src/b.py", success: true, content: "answer = 42", lines: 1 },
        ],
      }),
    );

    expect(parsed.multiFile).toEqual([
      {
        path: "src/a.ts",
        success: true,
        content: "export const a = 1;",
        lines: 1,
        fullPath: undefined,
        error: undefined,
        truncated: false,
      },
      {
        path: "src/b.py",
        success: true,
        content: "answer = 42",
        lines: 1,
        fullPath: undefined,
        error: undefined,
        truncated: false,
      },
    ]);
  });

  it("does not repeat a completed file path in the toolbar summary", () => {
    const parsed = parseToolResult(
      "file_write",
      { path: "E:\\work\\temp_file_1.txt" },
      JSON.stringify({
        success: true,
        path: "E:\\work\\temp_file_1.txt",
        fullPath: "E:\\work\\temp_file_1.txt",
        message: "File written: E:\\work\\temp_file_1.txt",
      }),
    );

    expect(parsed.summary).toBeNull();
  });
});
