import { describe, expect, it } from "vitest";

import type { TimelineEvent } from "@/apps/agent/components/conversation/timeline";
import { formatTokenCount, summarizeTurn } from "@/apps/agent/components/conversation/turn-summary";

let n = 0;
const tool = (name: string, args: unknown, result: string | null): TimelineEvent => {
  n += 1;
  return {
    kind: "tool",
    id: `ev${n}`,
    call: { id: `call${n}`, name, arguments: JSON.stringify(args), result },
  };
};
const ok = (extra: Record<string, unknown> = {}) => JSON.stringify({ success: true, ...extra });

describe("turn summary", () => {
  it("is null for a reply that made no tool calls", () => {
    const events: TimelineEvent[] = [{ kind: "content", id: "c", text: "Hi" }];
    expect(summarizeTurn(events, 40)).toBeNull();
  });

  it("counts distinct files, their lines, and commands", () => {
    const events = [
      tool("file_edit", { path: "src/a.ts", old_string: "x", new_string: "y" }, ok({ linesAdded: 3, linesRemoved: 1 })),
      // Same file again, spelled differently: still one file.
      tool("file_edit", { path: ".\\src\\A.ts", old_string: "y", new_string: "z" }, ok({ linesAdded: 2, linesRemoved: 2 })),
      tool("file_write", { path: "src/b.ts", content: "new" }, ok({ linesAdded: 10 })),
      tool("shell_execute", { command: "pnpm test" }, ok({ exitCode: 0, stdout: "ok" })),
      tool("shell_spawn", { command: "pnpm dev" }, ok({ completed: false })),
      tool("file_read", { path: ["src/c.ts"] }, ok({ content: "c" })),
    ];
    expect(summarizeTurn(events, 1503)).toEqual({
      files: 2,
      added: 15,
      removed: 3,
      commands: 2,
      outputTokens: 1503,
      outputTokensEstimated: undefined,
    });
  });

  it("counts every file a batch edit names", () => {
    const events = [
      tool(
        "file_edit",
        { path: "a.ts", edits: [{ old_string: "1", new_string: "2" }, { path: "b.ts", old_string: "3", new_string: "4" }] },
        ok({ linesAdded: 2, linesRemoved: 2 }),
      ),
    ];
    expect(summarizeTurn(events)?.files).toBe(2);
  });

  it("leaves out calls that failed or were rejected", () => {
    const events = [
      tool("file_edit", { path: "a.ts", old_string: "x", new_string: "y" }, "[error] old_string not found"),
      tool("shell_execute", { command: "rm -rf build" }, "[rejected] The user denied this"),
    ];
    const summary = summarizeTurn(events, 200);
    expect(summary).toMatchObject({ files: 0, added: 0, removed: 0, commands: 0, outputTokens: 200 });
  });

  it("carries the estimate flag", () => {
    const events = [tool("file_read", { path: ["a"] }, ok({ content: "a" }))];
    expect(summarizeTurn(events, 90, true)?.outputTokensEstimated).toBe(true);
  });

  it("formats token counts compactly once they stop being readable whole", () => {
    expect(formatTokenCount(1503)).toBe("1,503");
    expect(formatTokenCount(41_200)).toBe("41.2k");
    expect(formatTokenCount(412_000)).toBe("412k");
    expect(formatTokenCount(1_250_000)).toBe("1.3M");
  });
});
