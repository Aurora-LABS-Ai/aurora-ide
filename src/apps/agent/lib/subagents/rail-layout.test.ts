import { describe, expect, it } from "vitest";

import type { SubagentSnapshot } from "@/apps/agent/services/subagents/commands";
import { railSlots, stackCards } from "./rail-layout";

const agent = (agentId: string, status: SubagentSnapshot["status"], startedAtMs: number) =>
  ({
    agentId,
    parentThreadId: "p",
    agentType: "general",
    description: "",
    status,
    background: true,
    startedAtMs,
    usage: { inputTokens: 0, outputTokens: 0, toolCalls: 0, iterations: 0, durationMs: 0 },
    notified: false,
    runs: 1,
  }) satisfies SubagentSnapshot;

describe("railSlots", () => {
  it("gives every agent a cell while they fit, in start order", () => {
    const list = [agent("a", "completed", 1), agent("b", "running", 2), agent("c", "failed", 3)];
    expect(railSlots(list).shown.map((a) => a.agentId)).toEqual(["a", "b", "c"]);
    expect(railSlots(list).hidden).toEqual([]);
  });

  it("past five, keeps running agents and then the newest, still in start order", () => {
    const list = [
      agent("a", "running", 1),
      agent("b", "completed", 2),
      agent("c", "completed", 3),
      agent("d", "running", 4),
      agent("e", "completed", 5),
      agent("f", "completed", 6),
      agent("g", "completed", 7),
    ];
    const { shown, hidden } = railSlots(list);
    // Four cells and the "+N" cell.
    expect(shown.map((a) => a.agentId)).toEqual(["a", "d", "f", "g"]);
    expect(hidden.map((a) => a.agentId)).toEqual(["e", "c", "b"]);
  });
});

describe("stackCards", () => {
  const bounds = { top: 0, bottom: 700 };

  it("ends a lone card level with its cell", () => {
    expect(stackCards([{ id: "a", height: 200, anchorBottom: 500 }], bounds)).toEqual({ a: 306 });
  });

  it("puts the card of a higher cell above the lower one, never overlapping", () => {
    const tops = stackCards(
      [
        { id: "upper", height: 200, anchorBottom: 500 },
        { id: "lower", height: 200, anchorBottom: 544 },
      ],
      bounds,
    );
    expect(tops.lower).toBe(350);
    expect(tops.upper + 200).toBeLessThanOrEqual(tops.lower - 8);
  });

  it("slides the stack down when the top runs out, as in the sketch", () => {
    const tops = stackCards(
      [
        { id: "upper", height: 280, anchorBottom: 520 },
        { id: "lower", height: 300, anchorBottom: 560 },
      ],
      bounds,
    );
    expect(tops.upper).toBe(8);
    expect(tops.lower).toBe(8 + 280 + 8);
    expect(tops.lower + 300).toBeLessThanOrEqual(692);
  });

  it("keeps cards inside the window when they cannot all fit", () => {
    const tops = stackCards(
      [
        { id: "a", height: 400, anchorBottom: 600 },
        { id: "b", height: 400, anchorBottom: 640 },
      ],
      bounds,
    );
    for (const top of Object.values(tops)) expect(top).toBeGreaterThanOrEqual(8);
    expect(tops.b + 400).toBeLessThanOrEqual(692);
  });
});
