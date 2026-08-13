import { beforeEach, describe, expect, it } from "vitest";

import { useAgentTerminalStore } from "@/apps/agent/store/ui/useAgentTerminalStore";
import {
  listTerminalSessions,
  readTerminalSession,
  terminalRuntime,
  type PtyRuntime,
} from "@/apps/agent/services/terminal/terminal-sessions";

/**
 * A stand-in for xterm's buffer. Only `translateToString` and the cursor
 * fields are read, and modelling them is what lets the head/tail and elision
 * rules be tested without a DOM or a real PTY.
 */
function fakeRuntime(lines: string[], lastCommandLine?: number): PtyRuntime {
  const active = {
    length: lines.length,
    baseY: 0,
    cursorY: 0,
    getLine: (i: number) =>
      i < lines.length ? { translateToString: () => lines[i] } : undefined,
  };
  return {
    pty: undefined as unknown as PtyRuntime["pty"],
    term: { buffer: { active } } as unknown as PtyRuntime["term"],
    fit: undefined as unknown as PtyRuntime["fit"],
    lastCommandLine,
  };
}

function seedSession(id: string, overrides: Record<string, unknown> = {}) {
  useAgentTerminalStore.setState({
    sessions: [
      {
        id,
        title: "pwsh 1",
        profile: "pwsh",
        cwd: "E:/repo",
        running: true,
        ...overrides,
      } as never,
    ],
    activeId: id,
  });
}

beforeEach(() => {
  terminalRuntime.clear();
  useAgentTerminalStore.setState({ sessions: [], activeId: null });
});

describe("reading the user's terminals", () => {
  it("reads only the last command's output by default", () => {
    // The lines before the marker are an earlier command. Handing those over
    // as if they were the failure under discussion is the whole risk here.
    seedSession("t1");
    terminalRuntime.set(
      "t1",
      fakeRuntime(["$ old command", "old output", "$ cargo build", "error: boom"], 2),
    );

    const result = readTerminalSession("t1");
    expect(result?.scope).toBe("last_command");
    expect(result?.text).toBe("$ cargo build\nerror: boom");
    expect(result?.text).not.toContain("old output");
  });

  it("reads the whole scrollback when asked", () => {
    seedSession("t1");
    terminalRuntime.set("t1", fakeRuntime(["first", "second", "third"], 2));
    expect(readTerminalSession("t1", { scope: "all" })?.text).toBe("first\nsecond\nthird");
  });

  it("keeps both ends and says how much it dropped", () => {
    // A compiler puts the real error at the top and the summary at the bottom,
    // so both ends survive — and the gap has to announce itself, or the two
    // sides read as consecutive output.
    seedSession("t1");
    const lines = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`);
    terminalRuntime.set("t1", fakeRuntime(lines, 0));

    const result = readTerminalSession("t1", { headLines: 5, tailLines: 5 });
    const out = result?.text.split("\n") ?? [];
    expect(out[0]).toBe("line 1");
    expect(out[4]).toBe("line 5");
    expect(out[5]).toBe("… 190 lines hidden …");
    expect(out.at(-1)).toBe("line 200");
    expect(result?.hiddenLines).toBe(190);
  });

  it("does not elide when everything fits", () => {
    seedSession("t1");
    terminalRuntime.set("t1", fakeRuntime(["a", "b", "c"], 0));
    const result = readTerminalSession("t1", { headLines: 40, tailLines: 40 });
    expect(result?.text).toBe("a\nb\nc");
    expect(result?.hiddenLines).toBe(0);
    expect(result?.text).not.toContain("hidden");
  });

  it("falls back to the full buffer before the user has run anything", () => {
    // No Enter pressed yet means "the last command" has no answer; returning
    // nothing would read as an empty terminal.
    seedSession("t1");
    terminalRuntime.set("t1", fakeRuntime(["banner", "prompt"], undefined));
    expect(readTerminalSession("t1")?.text).toBe("banner\nprompt");
  });

  it("ignores trailing blank padding but keeps interior blank lines", () => {
    seedSession("t1");
    terminalRuntime.set("t1", fakeRuntime(["one", "", "two", "", "", ""], 0));
    expect(readTerminalSession("t1")?.text).toBe("one\n\ntwo");
  });

  it("returns null for an id that is not open", () => {
    seedSession("t1");
    terminalRuntime.set("t1", fakeRuntime(["x"], 0));
    expect(readTerminalSession("t9")).toBeNull();
  });

  it("lists what is open, and reports a session with no live buffer", () => {
    seedSession("t1");
    expect(listTerminalSessions()).toEqual([
      {
        id: "t1",
        title: "pwsh 1",
        shell: "pwsh",
        cwd: "E:/repo",
        running: true,
        lines: 0,
        attached: false,
      },
    ]);

    terminalRuntime.set("t1", fakeRuntime(["a", "b"], 0));
    const [entry] = listTerminalSessions();
    expect(entry.attached).toBe(true);
    expect(entry.lines).toBe(2);
  });
});

