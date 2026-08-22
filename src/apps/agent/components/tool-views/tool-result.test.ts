import { describe, expect, it } from "vitest";

import { parseToolResult } from "@/apps/agent/components/tool-views/tool-result";
import { toolStatus } from "@/apps/agent/components/tools/tool-call";

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

  it("shows a green-only stat for a newly created file", () => {
    const parsed = parseToolResult(
      "file_write",
      { path: "src/fresh.ts" },
      JSON.stringify({
        success: true,
        path: "src/fresh.ts",
        fullPath: "E:\\repo\\src\\fresh.ts",
        message: "File written: src/fresh.ts",
        linesAdded: 12,
        linesRemoved: 0,
        oldContent: "",
        newContent: "line\n".repeat(12),
      }),
    );

    expect(parsed.stat).toEqual({ added: 12, removed: 0 });
    expect(parsed.diff?.oldText).toBe("");
  });

  it("derives the stat from before/after when a persisted result predates counts", () => {
    const parsed = parseToolResult(
      "file_write",
      { path: "src/a.ts" },
      JSON.stringify({
        success: true,
        path: "src/a.ts",
        message: "File written: src/a.ts",
        oldContent: "one\ntwo\nthree",
        newContent: "one\nTWO\nthree\nfour",
      }),
    );

    expect(parsed.stat).toEqual({ added: 2, removed: 1 });
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

describe("code tool results", () => {
  // Observed on screen: every `code` row read "Done" and expanding one showed
  // only its arguments, because the JSON fell through to the generic handler.
  // One tool answering five different questions has to say WHICH answer it is.
  it("summarises an outline by symbol count and lists the symbols", () => {
    const parsed = parseToolResult(
      "code",
      { op: "outline", path: "src/db.ts" },
      JSON.stringify({
        success: true,
        op: "outline",
        path: "src/db.ts",
        symbols: 42,
        outline: [
          { file: "src/db.ts", line: 12, kind: "class", symbol: "Store" },
          { file: "src/db.ts", line: 40, kind: "function", symbol: "open" },
        ],
      }),
    );

    expect(parsed.summary).toBe("42 symbols");
    expect(parsed.code).toContain("class Store");
    expect(parsed.code).toContain("function open");
  });

  it("points a single definition straight at its file and line", () => {
    const parsed = parseToolResult(
      "code",
      { op: "definition", name: "Store" },
      JSON.stringify({
        success: true,
        op: "definition",
        name: "Store",
        found: 1,
        definitions: [{ symbol: "Store", kind: "class", file: "src/db.ts", line: 12 }],
      }),
    );

    expect(parsed.summary).toBe("src/db.ts:12");
  });

  it("separates the coupling kinds instead of reporting one total", () => {
    const parsed = parseToolResult(
      "code",
      { op: "usages", name: "Store" },
      JSON.stringify({
        success: true,
        op: "usages",
        resolved: true,
        totalUsages: 9,
        acrossFiles: 3,
        coupling: [
          { kind: "writes (reaches past the interface)", count: 2 },
          { kind: "calls", count: 7 },
        ],
        usedBy: [{ caller: "boot", count: 4 }],
      }),
    );

    expect(parsed.summary).toBe("9 uses · 3 files");
    expect(parsed.code).toContain("writes (reaches past the interface)");
    expect(parsed.code).toContain("boot");
  });

  it("says a usages answer was ambiguous rather than claiming success", () => {
    const parsed = parseToolResult(
      "code",
      { op: "usages", name: "handle" },
      JSON.stringify({
        success: true,
        op: "usages",
        resolved: false,
        reason: "ambiguous",
        candidates: [
          { symbol: "handle", kind: "function", file: "a/h.ts", line: 3, callers: 1 },
          { symbol: "handle", kind: "function", file: "b/h.ts", line: 3, callers: 5 },
        ],
      }),
    );

    expect(parsed.summary).toBe("2 candidates — ambiguous");
    expect(parsed.code).toContain("(5 callers)");
  });

  it("reports the module graph by group count and names its cycles", () => {
    const parsed = parseToolResult(
      "code",
      { op: "modules" },
      JSON.stringify({
        success: true,
        op: "modules",
        granularity: "dir",
        groups: 12,
        mostDependedOn: [{ name: "src/core", fanIn: 4, fanOut: 0, files: 3 }],
        cycles: [{ size: 2, members: ["src/a", "src/b"] }],
      }),
    );

    expect(parsed.summary).toBe("12 groups · 1 cycle");
    expect(parsed.code).toContain("src/core");
    expect(parsed.code).toContain("cycle: src/a → src/b");
  });
});

describe("structured failures", () => {
  // The reported bug: a refusal rendered as a green check with its JSON body
  // dumped into the card, because nothing above the last-resort branch claimed
  // a `success:false` payload and `toolStatus` only looked for `[error]`.
  const refusal = JSON.stringify({
    success: false,
    multiFile: true,
    error: "Could not find that text in src/app.css, which has not been read this session.",
    path: "src/app.css",
    fullPath: "/proj/src/app.css",
    hint: "Call file_read on this path, then retry the batch.",
    needsRead: true,
  });

  it("reads as failed rather than done", () => {
    expect(toolStatus({ id: "1", name: "file_edit", arguments: "{}", result: refusal })).toBe(
      "failed",
    );
  });

  it("summarises with the tool's own error instead of dumping the object", () => {
    const parsed = parseToolResult("file_edit", {}, refusal);
    expect(parsed.summary).toContain("Could not find that text");
    expect(parsed.code).toContain("Call file_read on this path");
    // The raw JSON must not reach the card.
    expect(parsed.code).not.toContain('"needsRead"');
  });

  it("leaves a successful call alone", () => {
    const ok = JSON.stringify({ success: true, message: "Edited 2 files" });
    expect(toolStatus({ id: "2", name: "file_edit", arguments: "{}", result: ok })).toBe("done");
  });

  // A per-file flag inside a multi-file read is a partial result, not a failed
  // call — marking the whole card failed would misreport 9 successful reads.
  it("ignores a nested per-item success flag", () => {
    const partial = JSON.stringify({
      success: true,
      files: [
        { path: "a.ts", success: true, content: "x" },
        { path: "b.ts", success: false, error: "not found" },
      ],
    });
    expect(toolStatus({ id: "3", name: "multi_file_read", arguments: "{}", result: partial })).toBe(
      "done",
    );
  });

  it("does not guess from a truncated payload", () => {
    expect(
      toolStatus({ id: "4", name: "grep", arguments: "{}", result: '{"success": fal' }),
    ).toBe("done");
  });
});

describe("web search and page fetch", () => {
  it("parses a results page into a ranked list rather than dumping raw JSON", () => {
    const parsed = parseToolResult(
      "auroro_websearch",
      { action: "search", query: "rust async trait" },
      JSON.stringify({
        success: true,
        action: "search",
        query: "rust async trait",
        search: {
          query: "rust async trait",
          engine: "duckduckgo-lite",
          count: 2,
          results: [
            {
              rank: 1,
              title: "async_trait - Rust - Docs.rs",
              url: "https://docs.rs/async-trait/latest/async_trait/",
              displayUrl: "docs.rs/async-trait/latest/async_trait/",
              snippet: "Type erasure for async trait methods.",
            },
            {
              rank: 2,
              title: "Traits - The Rust Reference",
              url: "https://doc.rust-lang.org/reference/items/traits.html",
            },
          ],
        },
      }),
    );

    expect(parsed.web?.kind).toBe("search");
    expect(parsed.web?.heading).toBe("rust async trait");
    expect(parsed.web?.source).toBe("duckduckgo-lite");
    expect(parsed.web?.hits).toHaveLength(2);
    expect(parsed.web?.hits?.[0].displayUrl).toBe("docs.rs/async-trait/latest/async_trait/");
    // A result with no summary is still a result.
    expect(parsed.web?.hits?.[1].snippet).toBeUndefined();
    expect(parsed.summary).toBe("2 results");
    // The generic text fallback must not also fire — that is the raw dump.
    expect(parsed.code).toBeNull();
  });

  it("drops a result with no url instead of rendering a dead row", () => {
    const parsed = parseToolResult(
      "auroro_websearch",
      { action: "search", query: "x" },
      JSON.stringify({
        success: true,
        search: { query: "x", engine: "duckduckgo-lite", results: [{ rank: 1, title: "No link" }] },
      }),
    );
    expect(parsed.web?.hits).toHaveLength(0);
  });

  it("says when another source had to be tried first", () => {
    const parsed = parseToolResult(
      "auroro_websearch",
      { action: "search", query: "x" },
      JSON.stringify({
        success: true,
        search: {
          query: "x",
          engine: "duckduckgo-html",
          results: [{ rank: 1, title: "A", url: "https://a.dev" }],
          fallbacks: [{ engine: "duckduckgo-lite", reason: "timed out" }],
        },
      }),
    );
    expect(parsed.web?.note).toBe("One other source returned nothing first.");
  });

  it("parses a fetched page as a document, keeping its markdown", () => {
    const parsed = parseToolResult(
      "auroro_websearch",
      { action: "fetch", url: "https://example.com/docs" },
      JSON.stringify({
        success: true,
        action: "fetch",
        url: "https://example.com/docs",
        document: {
          url: "https://example.com/docs",
          kind: "article",
          title: "Quick start",
          content: "# Quick start\n\nInstall it, then sign in.",
          totalChars: 40,
          returnedChars: 40,
          offset: 0,
          hasMore: false,
        },
      }),
    );

    expect(parsed.web?.kind).toBe("document");
    expect(parsed.web?.heading).toBe("Quick start");
    expect(parsed.web?.documentKind).toBe("article");
    expect(parsed.web?.content).toContain("# Quick start");
    expect(parsed.web?.hasMore).toBe(false);
    expect(parsed.summary).toBe("example.com");
    expect(parsed.code).toBeNull();
  });

  // The card tells the reader the page continues; without this it reads as a
  // document that ended mid-sentence.
  it("carries the paging state and the note through", () => {
    const parsed = parseToolResult(
      "auroro_websearch",
      { action: "fetch", url: "https://example.com/long" },
      JSON.stringify({
        success: true,
        document: {
          url: "https://example.com/long",
          finalUrl: "https://docs.example.com/long",
          kind: "page",
          content: "part one",
          totalChars: 90000,
          offset: 0,
          hasMore: true,
          nextOffset: 30000,
          note: "no article body was found on this page",
        },
      }),
    );
    expect(parsed.web?.hasMore).toBe(true);
    expect(parsed.web?.totalChars).toBe(90000);
    expect(parsed.web?.note).toContain("no article body");
    // The URL shown is where the request actually landed.
    expect(parsed.web?.source).toBe("https://docs.example.com/long");
  });

  // The tool's own message ("… returned 404 Not Found — the page is gone")
  // is more use than an empty results panel.
  it("leaves a failed call to the card's error path", () => {
    const parsed = parseToolResult(
      "auroro_websearch",
      { action: "fetch", url: "https://example.com/gone" },
      JSON.stringify({
        success: false,
        error: "https://example.com/gone returned 404 Not Found — the page is gone",
      }),
    );
    expect(parsed.web).toBeNull();
  });
});
