import { describe, expect, it } from "vitest";

import type { DbMessage } from "../../services/thread-service";
import {
  appendNotice,
  buildRows,
  buildTurns,
  turnWorkedMs,
  formatWorkedDuration,
} from "./timeline";

describe("agent-window mid-turn injection reload", () => {
  it("renders the persisted injection timeline between assistant segments", () => {
    const messages: DbMessage[] = [
      {
        id: "assistant-tool",
        role: "assistant",
        content: "Checking it.",
        timestamp: "2026-07-10T00:00:00.000Z",
      },
      {
        id: "injection",
        role: "assistant",
        content: "",
        timestamp: "2026-07-10T00:00:01.000Z",
        timeline: [
          {
            kind: "user_injection",
            id: "injection-1",
            text: "Use the returned id.",
          },
        ],
      },
      {
        id: "assistant-next",
        role: "assistant",
        content: "Continuing with that id.",
        timestamp: "2026-07-10T00:00:02.000Z",
      },
    ];

    const [turn] = buildTurns(messages);
    expect(buildRows(turn.events).map((row) => row.type)).toEqual([
      "content",
      "user_injection",
      "content",
    ]);
  });
});

describe("agent-window prompt chip reload", () => {
  it("keeps exact file and slash-command metadata on the user turn", () => {
    const chips = [
      {
        kind: "file" as const,
        title: "brand values.tsx",
        value: "src/brand values.tsx",
        path: "E:/work/src/brand values.tsx",
      },
      { kind: "skill" as const, title: "frontend-design" },
    ];
    const [turn] = buildTurns([
      {
        id: "user-1",
        role: "user",
        content: "Check @src/brand values.tsx",
        timestamp: "2026-07-11T00:00:00.000Z",
        attachedPromptChips: chips,
      },
    ]);

    expect(turn.attachedPromptChips).toEqual(chips);
  });
});

describe("turn duration", () => {
  const msg = (
    role: string,
    timestamp: string,
    extra: Partial<DbMessage> = {},
  ): DbMessage =>
    ({ id: `${role}-${timestamp}`, role, content: "x", timestamp, ...extra }) as DbMessage;

  it("measures from the user's send, not the first token", () => {
    // Queueing and model latency are part of how long the user waited; starting
    // the clock at the first assistant token would hide them.
    const turns = buildTurns([
      msg("user", "2026-07-28T10:00:00.000Z"),
      msg("assistant", "2026-07-28T10:04:00.000Z"),
    ]);
    const assistant = turns.find((t) => t.role === "assistant")!;
    expect(assistant.startedAt).toBe("2026-07-28T10:00:00.000Z");
    expect(turnWorkedMs(assistant)).toBe(4 * 60 * 1000);
  });

  it("runs to the last message of a multi-message turn", () => {
    const turns = buildTurns([
      msg("user", "2026-07-28T10:00:00.000Z"),
      msg("assistant", "2026-07-28T10:00:30.000Z"),
      msg("assistant", "2026-07-28T10:02:00.000Z"),
      msg("assistant", "2026-07-28T10:10:00.000Z"),
    ]);
    const assistant = turns.filter((t) => t.role === "assistant");
    expect(assistant).toHaveLength(1);
    expect(turnWorkedMs(assistant[0])).toBe(10 * 60 * 1000);
  });

  it("scopes each turn to its own user message", () => {
    const turns = buildTurns([
      msg("user", "2026-07-28T10:00:00.000Z"),
      msg("assistant", "2026-07-28T10:01:00.000Z"),
      msg("user", "2026-07-28T11:00:00.000Z"),
      msg("assistant", "2026-07-28T11:00:20.000Z"),
    ]);
    const assistant = turns.filter((t) => t.role === "assistant");
    // The hour the user spent away must not land on the second turn.
    expect(turnWorkedMs(assistant[0])).toBe(60 * 1000);
    expect(turnWorkedMs(assistant[1])).toBe(20 * 1000);
  });

  it("returns null rather than a bogus number", () => {
    const orphan = buildTurns([msg("assistant", "2026-07-28T10:00:00.000Z")])[0];
    expect(turnWorkedMs(orphan)).toBeNull();

    const userTurn = buildTurns([msg("user", "2026-07-28T10:00:00.000Z")])[0];
    expect(turnWorkedMs(userTurn)).toBeNull();

    // Clock skew (assistant stamped before the user) must not read as negative.
    const skewed = buildTurns([
      msg("user", "2026-07-28T10:05:00.000Z"),
      msg("assistant", "2026-07-28T10:00:00.000Z"),
    ]).find((t) => t.role === "assistant")!;
    expect(turnWorkedMs(skewed)).toBeNull();

    const unparsable = buildTurns([
      msg("user", "not-a-date"),
      msg("assistant", "also-not-a-date"),
    ]).find((t) => t.role === "assistant")!;
    expect(turnWorkedMs(unparsable)).toBeNull();
  });

  it("formats durations at a glanceable granularity", () => {
    expect(formatWorkedDuration(400)).toBe("<1s");
    expect(formatWorkedDuration(12_000)).toBe("12s");
    expect(formatWorkedDuration(59_400)).toBe("59s");
    expect(formatWorkedDuration(4 * 60_000)).toBe("4m");
    expect(formatWorkedDuration(10 * 60_000)).toBe("10m");
    expect(formatWorkedDuration(64 * 60_000)).toBe("1h 4m");
    expect(formatWorkedDuration(120 * 60_000)).toBe("2h");
  });
});

describe("runtime notices in the timeline", () => {
  it("appends a notice as its own row, never as message content", () => {
    const tl = appendNotice([], "This reply is cut off — the model reached its output limit.");
    expect(tl).toEqual([
      {
        kind: "notice",
        id: expect.any(String),
        text: "This reply is cut off — the model reached its output limit.",
      },
    ]);

    // It must survive buildRows as a distinct row type. Rendering it as
    // `content` would put the product's voice inside the model's reply.
    const rows = buildRows(tl);
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe("notice");
  });

  it("collapses an immediately repeated notice", () => {
    // The runtime can announce a failure and then fail with the same message.
    const once = appendNotice([], "stream ended before the model finished");
    const twice = appendNotice(once, "stream ended before the model finished");
    expect(twice).toBe(once);
    expect(twice).toHaveLength(1);
  });

  it("keeps a notice in place between tool runs instead of breaking their group", () => {
    const tl = appendNotice(
      [
        { kind: "tool", id: "a", call: { id: "a", name: "file_read" } as never },
        { kind: "tool", id: "b", call: { id: "b", name: "grep" } as never },
      ],
      "output limit reached",
    );
    const rows = buildRows(tl);
    // Two tools group into one row, then the notice follows it.
    expect(rows.map((r) => r.type)).toEqual(["tools", "notice"]);
  });
});

describe("persisted notices reload into the turn they describe", () => {
  it("folds a role:notice message into the preceding assistant turn", () => {
    // What Rust writes for a turn cut off at the output limit: the assistant
    // message, then a System/Notice marker mapped to `role: "notice"`.
    const turns = buildTurns([
      { id: "u", role: "user", content: "build it", timestamp: "2026-07-29T16:00:00.000Z" },
      {
        id: "a",
        role: "assistant",
        content: "",
        thinking: "a very long think that never got to an answer",
        timestamp: "2026-07-29T16:01:00.000Z",
      },
      {
        id: "n",
        role: "notice",
        content: "This reply is cut off — the model reached its output limit.",
        timestamp: "2026-07-29T16:01:01.000Z",
      },
    ] as never);

    // Exactly two turns: the notice must NOT become a third bubble.
    expect(turns.map((t) => t.role)).toEqual(["user", "assistant"]);
    const rows = buildRows(turns[1].events);
    expect(rows.map((r) => r.type)).toEqual(["thinking", "notice"]);
    expect(rows[1]).toMatchObject({
      type: "notice",
      text: "This reply is cut off — the model reached its output limit.",
    });
  });

  it("drops an orphan notice instead of rendering it as an assistant reply", () => {
    // No assistant turn to describe — it must not surface product copy in a
    // bubble that looks like the model talking.
    const turns = buildTurns([
      { id: "n", role: "notice", content: "output limit reached", timestamp: "2026-07-29T16:00:00.000Z" },
    ] as never);
    expect(turns).toEqual([]);
  });
});

describe("todo rows in the transcript", () => {
  const todoCall = (id: string, op: string) =>
    ({
      kind: "tool" as const,
      id,
      call: {
        id,
        name: "todo",
        arguments: JSON.stringify({ op }),
      },
    });
  const toolEvent = (id: string, name: string) =>
    ({
      kind: "tool" as const,
      id,
      call: { id, name, arguments: "{}" },
    });

  it("shows set and update — a checklist that moves must leave a trace", () => {
    const rows = buildRows([todoCall("a", "set"), todoCall("b", "update")]);
    expect(rows).toHaveLength(1);
    expect(rows[0].type === "tools" && rows[0].tools).toHaveLength(2);
  });

  it("drops a read — a lookup changes nothing a reader could care about", () => {
    const rows = buildRows([
      { kind: "content", id: "c1", text: "Starting." },
      todoCall("r", "read"),
    ]);
    expect(rows.map((r) => r.type)).toEqual(["content"]);
  });

  it("does not split a run of real tools around a dropped read", () => {
    // Dropping the event must not also flush the group — otherwise a lookup
    // between two edits would break them into two separate cards.
    const rows = buildRows([
      toolEvent("a", "file_read"),
      todoCall("r", "read"),
      toolEvent("b", "file_edit"),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].type === "tools" && rows[0].tools.map((c) => c.name)).toEqual([
      "file_read",
      "file_edit",
    ]);
  });

  it("shows a todo call whose arguments never parsed", () => {
    // A call that is unreadable is exactly the one worth seeing — silence
    // would be indistinguishable from a tool that failed to run.
    const rows = buildRows([
      { kind: "tool", id: "x", call: { id: "x", name: "todo", arguments: "{op:" } },
    ]);
    expect(rows[0].type === "tools" && rows[0].tools).toHaveLength(1);
  });
});
