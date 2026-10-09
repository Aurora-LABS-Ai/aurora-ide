/**
 * The tail's lines: the shape of an agent's work in order, never noise.
 */

import { describe, expect, it } from "vitest";

import { stabilizeSteps, tailSteps, type TailStep } from "@/apps/agent/lib/subagents/tail-steps";
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

describe("stabilizeSteps", () => {
  const call = (id: string, result: string | null) => ({
    id,
    name: "file_read",
    arguments: '{"path":"a.rs"}',
    result,
  });
  const base = (): TailStep[] => [
    { kind: "parent", id: "u1", text: "Fix it." },
    { kind: "tool", id: "c1", call: call("c1", "ok") },
    { kind: "tool", id: "c2", call: call("c2", null), live: true },
    { kind: "said", id: "k1", text: "Readi", live: true },
  ];

  it("keeps every step's object when a rebuild changed nothing", () => {
    const prev = base();
    expect(stabilizeSteps(prev, base())).toBe(prev);
  });

  it("keeps the unchanged steps and replaces only the ones that changed", () => {
    const prev = base();
    const next = base();
    (next[2] as { call: { result: string | null } }).call = call("c2", "done");
    (next[3] as { text: string }).text = "Reading the file.";
    const out = stabilizeSteps(prev, next);
    expect(out).not.toBe(prev);
    expect(out[0]).toBe(prev[0]);
    expect(out[1]).toBe(prev[1]);
    expect(out[2]).toBe(next[2]);
    expect(out[3]).toBe(next[3]);
  });

  it("is a new list when a step arrives, with the old steps kept", () => {
    const prev = base();
    const next = [...base(), { kind: "thought", id: "t9", text: "Next." } as TailStep];
    const out = stabilizeSteps(prev, next);
    expect(out).toHaveLength(5);
    expect(out[1]).toBe(prev[1]);
    expect(out[4]).toBe(next[4]);
  });

  it("does not keep a step whose live mark changed", () => {
    const prev = base();
    const next = base();
    delete next[3].live;
    expect(stabilizeSteps(prev, next)[3]).toBe(next[3]);
  });
});
