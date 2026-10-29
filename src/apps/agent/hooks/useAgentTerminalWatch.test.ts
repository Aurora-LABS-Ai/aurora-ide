import { describe, expect, it } from "vitest";

import { terminalExitNotice } from "@/apps/agent/hooks/useAgentTerminalWatch";

const base = { id: 2, title: "Codex Web", exitCode: 1, ownerThread: "t-1" };

describe("terminalExitNotice", () => {
  // What the agent was told on 2026-10-28 when the person closed a tab they no
  // longer needed: "Failed Codex Web · exit 1", and to read output that was
  // already gone.
  it("tells the agent the user closed it, not that it failed", () => {
    const notice = terminalExitNotice({ ...base, endedBy: "user" });
    expect(notice.summary).toBe("Closed Codex Web · by you");
    expect(notice.summary).not.toMatch(/Failed/);
    expect(notice.detail).toMatch(/The user closed your terminal "Codex Web" \(id 2\)/);
    expect(notice.detail).toMatch(/not a crash/);
    expect(notice.detail).toMatch(/Do not start it again unless the user asks/);
    expect(notice.detail).not.toMatch(/Read what it printed/);
  });

  it("still reports a terminal that ended by itself by its exit code", () => {
    expect(terminalExitNotice(base).summary).toBe("Failed Codex Web · exit 1");
    expect(terminalExitNotice({ ...base, exitCode: 0 }).summary).toBe("Finished Codex Web · exit 0");
    expect(terminalExitNotice(base).detail).toMatch(/Read what it printed with terminal \{"id": "2"\}/);
  });
});
