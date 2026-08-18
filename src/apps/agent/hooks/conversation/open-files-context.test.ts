import { describe, expect, it } from "vitest";

import { buildOpenFilesContext } from "@/apps/agent/hooks/conversation/useAgentWindowSend";

/**
 * `<open_files>` tells the agent which files the user has open in the right
 * dock. It is re-sent on EVERY turn, which sets both of its rules: names only,
 * never content; and it must actually appear when a file is open.
 *
 * The second rule is here because the first implementation read the file
 * tree's `selectedPath` instead of the dock's tab list, so the block was never
 * built at all. The running agent reported it verbatim — "this turn didn't
 * include the <open_files> block" — while a file sat open beside it.
 */
describe("the open-files block", () => {
  it("is absent when nothing is open, rather than an empty block", () => {
    expect(buildOpenFilesContext([], null)).toBeNull();
    expect(buildOpenFilesContext(["  ", ""], null)).toBeNull();
  });

  it("names every open file", () => {
    const block = buildOpenFilesContext(
      ["C:/ws/README.md", "C:/ws/src/app.ts"],
      "C:/ws/src/app.ts",
    );
    expect(block).toContain("C:/ws/README.md");
    expect(block).toContain("C:/ws/src/app.ts");
    expect(block).toContain('count="2"');
  });

  it("marks the file being shown, and only that one", () => {
    const block = buildOpenFilesContext(
      ["C:/ws/a.ts", "C:/ws/b.ts"],
      "C:/ws/b.ts",
    )!;
    expect(block).toMatch(/- C:\/ws\/b\.ts {2}\(showing\)/);
    expect(block).toMatch(/- C:\/ws\/a\.ts$/m);
    expect(block.match(/\(showing\)/g)).toHaveLength(1);
  });

  it("marks nothing when the active dock tab is not a file", () => {
    // The dock's active tab can be the tree, the browser or a terminal. Calling
    // the first file "showing" then would be a small lie on every turn.
    const block = buildOpenFilesContext(["C:/ws/a.ts", "C:/ws/b.ts"], null)!;
    expect(block).not.toContain("(showing)");
  });

  it("carries no file content — only paths", () => {
    const block = buildOpenFilesContext(["C:/ws/secret.env"], null)!;
    // One line per file plus the wrapper: a block that ever grows bodies would
    // become the most expensive thing in the conversation.
    expect(block.split("\n").filter((l) => l.startsWith("- "))).toHaveLength(1);
    expect(block).toMatch(/read one with file_read/i);
  });
});
