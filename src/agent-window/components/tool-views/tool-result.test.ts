import { describe, expect, it } from "vitest";

import { parseToolResult } from "./tool-result";

describe("glob results", () => {
  it("parses matches into a path list rather than falling through to raw JSON", () => {
    const parsed = parseToolResult(
      "glob",
      { pattern: "**/*.ts" },
      JSON.stringify({
        success: true,
        tool: "glob",
        pattern: "**/*.ts",
        files: ["src/api/mod.ts", "src/api/client.ts", "index.ts"],
        count: 3,
        truncated: false,
      }),
    );

    expect(parsed.glob?.files).toEqual(["src/api/mod.ts", "src/api/client.ts", "index.ts"]);
    expect(parsed.glob?.pattern).toBe("**/*.ts");
    expect(parsed.glob?.total).toBe(3);
    expect(parsed.summary).toBe("3 files");
    // Must NOT be mistaken for a generic file list, which drops the directory.
    expect(parsed.fileList).toBeNull();
    expect(parsed.code).toBeNull();
  });

  it("keeps the true total and the recovery note when the list was capped", () => {
    const parsed = parseToolResult(
      "glob",
      { pattern: "**/*", limit: 2 },
      JSON.stringify({
        success: true,
        tool: "glob",
        pattern: "**/*",
        files: ["a.ts", "b.ts"],
        count: 340,
        truncated: true,
        note: "Showing 2 of 340 matches (newest first). Narrow `pattern`…",
      }),
    );

    expect(parsed.glob?.files).toHaveLength(2);
    expect(parsed.glob?.total).toBe(340);
    expect(parsed.glob?.truncated).toBe(true);
    expect(parsed.glob?.note).toContain("340");
    // The header must report the real total, not the shown count.
    expect(parsed.summary).toBe("340 files");
  });

  it("treats no matches as an answer, not an empty payload", () => {
    const parsed = parseToolResult(
      "glob",
      { pattern: "**/*.zzz" },
      JSON.stringify({
        success: true,
        tool: "glob",
        pattern: "**/*.zzz",
        files: [],
        count: 0,
        truncated: false,
        note: "No files matched. Check the pattern uses forward slashes…",
      }),
    );

    expect(parsed.glob).not.toBeNull();
    expect(parsed.glob?.files).toEqual([]);
    expect(parsed.summary).toBe("No matches");
    expect(parsed.glob?.note).toContain("No files matched");
  });
});

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

  it("recovers complete workspace nodes from legacy history cut mid-JSON", () => {
    const parsed = parseToolResult(
      "workspace_tree",
      { depth: 2 },
      '{"success":true,"rootPath":"E:\\\\repo","tree":[{"name":"src","path":"E:\\\\repo\\\\src","type":"directory","children":[{"name":"a.ts","path":"E:\\\\repo\\\\src\\\\a.ts","type":"file","lineCount":3}]},{"name":"README.md","path":"E:\\\\repo\\\\README.md"\n\n[truncated 9000 bytes — tool returned 17192 bytes total, kept first 8192]',
    );

    expect(parsed.code).toBeNull();
    expect(parsed.tree?.rootPath).toBe("E:\\repo");
    expect(parsed.tree?.tree).toHaveLength(1);
    expect(parsed.tree?.tree[0]).toMatchObject({
      name: "src",
      path: "E:\\repo\\src",
      type: "directory",
    });
    expect(parsed.tree?.tree[0].children?.[0]).toMatchObject({
      name: "a.ts",
      path: "E:\\repo\\src\\a.ts",
      type: "file",
      lineCount: 3,
    });
  });

  it("strips history-compaction markers from diffs instead of diffing them", () => {
    const marker = (n: number) => `\n\n[truncated ${n} bytes in persisted history]`;
    const parsed = parseToolResult(
      "file_edit",
      { target_paths: ["src/hero.tsx"] },
      JSON.stringify({
        success: true,
        multiFile: true,
        filesEdited: 1,
        files: [
          {
            path: "src/hero.tsx",
            oldContent: `const a = 1;${marker(4923)}`,
            newContent: `const a = 2;${marker(4933)}`,
            linesAdded: 17,
            linesRemoved: 17,
          },
        ],
      }),
    );

    expect(parsed.diffs).toHaveLength(1);
    expect(parsed.diffs![0].oldText).toBe("const a = 1;");
    expect(parsed.diffs![0].newText).toBe("const a = 2;");
    expect(parsed.diffs![0].truncated).toBe(true);
    // Untruncated results carry no flag.
    const clean = parseToolResult(
      "file_edit",
      { path: "src/a.ts" },
      JSON.stringify({ success: true, oldContent: "x", newContent: "y", path: "src/a.ts" }),
    );
    expect(clean.diff?.truncated).toBeUndefined();
  });

  it("strips history-compaction markers from persisted batch reads", () => {
    const parsed = parseToolResult(
      "file_read",
      { paths: ["src/a.ts"] },
      JSON.stringify({
        success: true,
        filesRead: 1,
        files: [
          {
            path: "src/a.ts",
            success: true,
            content: "export const a = 1;\n\n[truncated 9000 bytes in persisted history]",
            lines: 300,
          },
        ],
      }),
    );

    expect(parsed.multiFile![0].content).toBe("export const a = 1;");
    expect(parsed.multiFile![0].truncated).toBe(true);
  });

  it("surfaces the exit code in a failed shell summary", () => {
    const parsed = parseToolResult(
      "shell_execute",
      { command: "pnpm test" },
      JSON.stringify({
        success: false,
        exitCode: 1,
        command: "pnpm test",
        stdout: "",
        stderr: "1 test failed",
      }),
    );

    expect(parsed.summary).toBe("Command failed · exit 1");
    expect(parsed.shell?.exitCode).toBe(1);
  });

  it("carries per-file line counts on multi-file edit diffs", () => {
    const parsed = parseToolResult(
      "file_edit",
      { target_paths: ["src/a.ts", "src/b.ts"] },
      JSON.stringify({
        success: true,
        multiFile: true,
        filesEdited: 2,
        files: [
          {
            path: "src/a.ts",
            oldContent: "old a",
            newContent: "new a",
            linesAdded: 3,
            linesRemoved: 1,
          },
          {
            path: "src/b.ts",
            oldContent: "old b",
            newContent: "new b",
            linesAdded: 7,
            linesRemoved: 2,
          },
        ],
      }),
    );

    expect(parsed.diffs?.map((d) => [d.added, d.removed])).toEqual([
      [3, 1],
      [7, 2],
    ]);
    expect(parsed.stat).toEqual({ added: 10, removed: 3 });
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
