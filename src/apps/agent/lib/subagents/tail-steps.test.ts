/**
 * The tail's lines: the shape of an agent's work in order, never noise.
 */

import { describe, expect, it } from "vitest";

import { tailSteps } from "@/apps/agent/lib/subagents/tail-steps";
import type { DbMessage } from "@/apps/agent/services/threads/thread-service";

const at = "2026-10-08T10:00:00Z";

describe("tailSteps", () => {
  it("reads the parent's brief, thoughts, tools and replies in order", () => {
    const messages: DbMessage[] = [
      { id: "u1", role: "user", content: "Fix the\n  shell colours.", timestamp: at },
      {
        id: "a1",
        role: "assistant",
        content: "",
        timestamp: at,
        timeline: [
          { kind: "thinking", id: "t1", text: "Check tokens.css first." },
          {
            kind: "tool",
            id: "c1",
            call: { id: "c1", name: "file_read", arguments: '{"path":"src/tokens.css"}', result: "x" },
          },
          { kind: "content", id: "k0", text: "..." },
          { kind: "content", id: "k1", text: "Shell reads the panel token now." },
        ],
      },
    ];
    const steps = tailSteps(messages, [{ id: "p1", text: "Also the nav.", queuedAtMs: 1 }]);
    expect(steps.map((s) => s.kind)).toEqual(["parent", "thought", "tool", "said", "parent"]);
    expect(steps[0]).toMatchObject({ text: "Fix the shell colours." });
    expect(steps[4]).toMatchObject({ text: "Also the nav.", waiting: true });
  });

  it("is empty for an agent that has done nothing yet", () => {
    expect(tailSteps([])).toEqual([]);
  });
});
