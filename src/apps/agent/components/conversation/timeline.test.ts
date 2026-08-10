import { describe, expect, it } from "vitest";

import type { DbMessage } from "@/apps/agent/services/threads/thread-service";
import {
  appendNotice,
  appendThinking,
  buildRows,
  buildSections,
  buildTurns,
  turnWorkedMs,
  formatWorkedDuration,
  type TimelineEvent,
} from "@/apps/agent/components/conversation/timeline";

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

describe("agent-window reloaded turn order", () => {
  /** What Rust's reload path emits: order in `timeline`, payload in `tool_calls`. */
  const reloaded = (): DbMessage => ({
    id: "assistant-1",
    role: "assistant",
    content: "Reading the hook first.\nNow the fix.",
    timestamp: "2026-08-04T00:00:00.000Z",
    tool_calls: [
      { id: "t1", name: "file_read", arguments: '{"path":"a.ts"}', result: "214 lines" },
      { id: "t2", name: "search_replace", arguments: '{"path":"a.ts"}', result: "ok" },
    ],
    timeline: [
      { kind: "content", id: "assistant-1-e0", text: "Reading the hook first." },
      { kind: "tool", id: "t1" },
      { kind: "content", id: "assistant-1-e2", text: "Now the fix." },
      { kind: "tool", id: "t2" },
    ],
  });

  it("renders content and tools in the order the model emitted them", () => {
    const [turn] = buildTurns([reloaded()]);
    expect(buildRows(turn.events).map((row) => row.type)).toEqual([
      "content",
      "tools",
      "content",
      "tools",
    ]);
  });

  it("joins each tool event to its call and result from tool_calls", () => {
    const [turn] = buildTurns([reloaded()]);
    const rows = buildRows(turn.events);
    const first = rows[1];
    const second = rows[3];
    if (first.type !== "tools" || second.type !== "tools") {
      throw new Error("expected both tool runs to render");
    }
    expect(first.tools[0].name).toBe("file_read");
    expect(first.tools[0].result).toBe("214 lines");
    expect(second.tools[0].name).toBe("search_replace");
  });

  it("drops a tool event whose call is missing rather than render a blank card", () => {
    const message = reloaded();
    message.tool_calls = [message.tool_calls![0]];
    const [turn] = buildTurns([message]);
    const rows = buildRows(turn.events);
    expect(rows.map((row) => row.type)).toEqual(["content", "tools", "content"]);
  });

  it("still synthesises a turn that carries no ordered timeline", () => {
    const [turn] = buildTurns([
      {
        id: "legacy",
        role: "assistant",
        content: "Done.",
        timestamp: "2026-08-04T00:00:00.000Z",
        thinking: "considering",
        tool_calls: [{ id: "t1", name: "grep", arguments: "{}", result: "3 matches" }],
      },
    ]);
    expect(buildRows(turn.events).map((row) => row.type)).toEqual([
      "thinking",
      "content",
      "tools",
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
    expect(formatWorkedDuration(12_000)).toBe("12s");
    expect(formatWorkedDuration(59_400)).toBe("59s");
    expect(formatWorkedDuration(64 * 60_000)).toBe("1h 4m");
    expect(formatWorkedDuration(120 * 60_000)).toBe("2h");
  });

  it("states a sub-second span instead of bounding it", () => {
    // A reasoning block emits many short segments; a column of identical `<1s`
    // hedges tells the reader less than the tenths do, and the value is
    // measured, so there is nothing to hedge about.
    expect(formatWorkedDuration(400)).toBe("0.4s");
    expect(formatWorkedDuration(900)).toBe("0.9s");
    expect(formatWorkedDuration(120)).toBe("0.1s");
  });

  it("never claims a span that happened took no time", () => {
    // First and last token in the same tick. Bounded, not rounded to `0.0s`.
    expect(formatWorkedDuration(0)).toBe("<0.1s");
    expect(formatWorkedDuration(20)).toBe("<0.1s");
  });

  it("hands over to whole seconds at the boundary", () => {
    expect(formatWorkedDuration(999)).toBe("1.0s");
    expect(formatWorkedDuration(1_000)).toBe("1s");
    expect(formatWorkedDuration(1_400)).toBe("1s");
  });

  it("keeps the seconds remainder past a minute", () => {
    // The step from 59s to "4m" used to throw away up to 59 seconds, which is
    // most of the difference between two reasoning passes at this scale.
    expect(formatWorkedDuration(64_000)).toBe("1m 4s");
    expect(formatWorkedDuration(4 * 60_000 + 14_000)).toBe("4m 14s");
    expect(formatWorkedDuration(59 * 60_000 + 59_000)).toBe("59m 59s");
  });

  it("drops a zero remainder rather than printing it", () => {
    // Same rule that already made 2h read as "2h" and not "2h 0m": a zero
    // remainder is not information.
    expect(formatWorkedDuration(4 * 60_000)).toBe("4m");
    expect(formatWorkedDuration(10 * 60_000)).toBe("10m");
  });
});

describe("reasoning segment timing", () => {
  it("starts a segment's clock on its first delta", () => {
    const tl = appendThinking([], "Let me ", 1_000);
    expect(tl).toEqual([
      { kind: "thinking", id: expect.any(String), text: "Let me ", startedAt: 1_000, durationMs: 0 },
    ]);
  });

  it("extends the duration as the segment keeps streaming", () => {
    let tl = appendThinking([], "Let me ", 1_000);
    tl = appendThinking(tl, "check ", 4_000);
    tl = appendThinking(tl, "the hook.", 8_500);
    expect(tl).toHaveLength(1);
    expect(tl[0]).toMatchObject({ text: "Let me check the hook.", durationMs: 7_500 });
  });

  it("does not restate a rehydrated segment's clock from the current time", () => {
    // A segment reloaded from disk carries a duration but no start. Recomputing
    // from `now` would report however long this WINDOW has been open as the
    // time the model spent reasoning hours ago.
    const reloaded: TimelineEvent[] = [
      { kind: "thinking", id: "ev-old", text: "old reasoning", durationMs: 7_000 },
    ];
    const tl = appendThinking(reloaded, " more", 9_999_999);
    expect(tl[0]).toMatchObject({ durationMs: 7_000 });
  });

  it("carries the timing onto the render row", () => {
    const rows = buildRows(appendThinking([], "thinking", 1_000));
    expect(rows[0]).toMatchObject({ type: "thinking", startedAt: 1_000, durationMs: 0 });
  });

  it("leaves a segment with no measurement undefined, not zero", () => {
    // "measured as instant" (<1s) and "never measured" (no number at all) are
    // different facts and the block renders them differently.
    const rows = buildRows([{ kind: "thinking", id: "ev1", text: "legacy" }]);
    expect(rows[0]).toMatchObject({ type: "thinking", durationMs: undefined });
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

describe("chapters in the transcript", () => {
  const chapter = (id: string, args: string, result?: string) =>
    ({
      kind: "tool" as const,
      id,
      call: { id, name: "chapter", arguments: args, result },
    });
  const tool = (id: string, name: string) =>
    ({ kind: "tool" as const, id, call: { id, name, arguments: "{}" } });

  it("becomes a heading, not a tool card", () => {
    const rows = buildRows([chapter("c1", JSON.stringify({ title: "Read the reload path" }))]);
    expect(rows).toEqual([{ type: "chapter", id: "c1", title: "Read the reload path" }]);
  });

  it("lands between the work either side of it, in emission order", () => {
    // The whole point: a chapter marks where a part of the work STARTS, so it
    // must break the tool run rather than be swept into it.
    const rows = buildRows([
      tool("t1", "file_read"),
      chapter("c1", JSON.stringify({ title: "Fix the tool join" })),
      tool("t2", "file_edit"),
    ]);
    expect(rows.map((r) => r.type)).toEqual(["tools", "chapter", "tools"]);
  });

  it("reads a title that is still streaming, so the heading types in", () => {
    // Partial JSON: `JSON.parse` would fail here, and the call would flash as a
    // tool card for a frame before turning into a heading.
    const rows = buildRows([chapter("c1", '{"title": "Read the rel')]);
    expect(rows).toEqual([{ type: "chapter", id: "c1", title: "Read the rel" }]);
  });

  it("holds the row back until the title has any characters at all", () => {
    // A heading with nothing in it is worse than a heading that arrives a frame
    // late — and it arrives at this same position either way.
    for (const args of ["", "{", '{"ti', '{"title": "', '{"title": "   ']) {
      expect(buildRows([chapter("c1", args)])).toEqual([]);
    }
  });

  it("does not split a tool run while its title is unreadable", () => {
    const rows = buildRows([tool("t1", "file_read"), chapter("c1", "{"), tool("t2", "file_edit")]);
    expect(rows).toHaveLength(1);
    expect(rows[0].type === "tools" && rows[0].tools).toHaveLength(2);
  });

  it("falls back to a tool card when the runtime rejected it", () => {
    // A rejected chapter is a heading the user never got. Rendering the title
    // anyway would show a heading the runtime refused; hiding the call entirely
    // would leave nothing to notice.
    const rows = buildRows([
      chapter("c1", JSON.stringify({ title: "x".repeat(80) }), "[error] `title` is 80 characters"),
    ]);
    expect(rows.map((r) => r.type)).toEqual(["tools"]);
  });

  it("still shows the heading before the call is acknowledged", () => {
    // No result yet is pending, not failed — the announcement is the point, and
    // it has to be visible before the work it announces.
    const rows = buildRows([chapter("c1", JSON.stringify({ title: "Run the tests" }))]);
    expect(rows[0]).toMatchObject({ type: "chapter", title: "Run the tests" });
  });

  it("survives a reload, at the point it was called", () => {
    // Reloaded tool events carry only their id; the payload is joined from
    // `tool_calls`. A chapter must come back as a heading in the same place.
    const [turn] = buildTurns([
      {
        id: "m1",
        role: "assistant",
        content: "Done.",
        timestamp: "2026-08-04T07:00:00.000Z",
        timeline: [
          { kind: "tool", id: "c1" },
          { kind: "content", id: "e1", text: "Done." },
        ],
        tool_calls: [
          { id: "c1", name: "chapter", arguments: '{"title":"Wire the reload"}', result: "{}" },
        ],
      },
    ] as never);
    expect(buildRows(turn.events)).toEqual([
      { type: "chapter", id: "c1", title: "Wire the reload" },
      { type: "content", id: "e1", text: "Done." },
    ]);
  });
});

describe("agent-window whitespace between batched tool calls", () => {
  /**
   * The exact shape a real model emits when it batches reads into ONE assistant
   * message (taken from a session JSONL): a thinking block, then a tool call per
   * file with a bare newline text block between each pair.
   */
  const batchedReads = (): TimelineEvent[] => [
    { kind: "thinking", id: "th", text: "Let me read the entry points." },
    { kind: "content", id: "w0", text: "\n\n" },
    { kind: "tool", id: "t1", call: { id: "t1", name: "file_read", arguments: '{"path":"a.ts"}' } },
    { kind: "content", id: "w1", text: "\n" },
    { kind: "tool", id: "t2", call: { id: "t2", name: "file_read", arguments: '{"path":"b.ts"}' } },
    { kind: "content", id: "w2", text: "\n" },
    { kind: "tool", id: "t3", call: { id: "t3", name: "file_read", arguments: '{"path":"c.ts"}' } },
    { kind: "content", id: "w3", text: "\n" },
    { kind: "tool", id: "t4", call: { id: "t4", name: "file_read", arguments: '{"path":"d.ts"}' } },
    { kind: "content", id: "w4", text: "\n" },
    { kind: "tool", id: "t5", call: { id: "t5", name: "file_read", arguments: '{"path":"e.ts"}' } },
  ];

  it("keeps newline-separated tool calls in ONE run", () => {
    const rows = buildRows(batchedReads());
    expect(rows.map((r) => r.type)).toEqual(["thinking", "tools"]);
    const tools = rows[1];
    if (tools.type !== "tools") throw new Error("expected a tools row");
    expect(tools.tools.map((t) => t.id)).toEqual(["t1", "t2", "t3", "t4", "t5"]);
  });

  it("renders no row for a whitespace-only content segment", () => {
    const rows = buildRows([
      { kind: "content", id: "w", text: "\n\n" },
      { kind: "content", id: "c", text: "Real prose." },
    ]);
    expect(rows).toEqual([{ type: "content", id: "c", text: "Real prose." }]);
  });

  it("still splits a run when the model actually says something", () => {
    const rows = buildRows([
      { kind: "tool", id: "t1", call: { id: "t1", name: "file_read", arguments: "{}" } },
      { kind: "content", id: "c", text: "That file was empty, trying the sibling." },
      { kind: "tool", id: "t2", call: { id: "t2", name: "file_read", arguments: "{}" } },
    ]);
    expect(rows.map((r) => r.type)).toEqual(["tools", "content", "tools"]);
  });
});

describe("agent-window chapter sections", () => {
  const tool = (id: string): TimelineEvent => ({
    kind: "tool",
    id,
    call: { id, name: "file_read", arguments: "{}" },
  });

  it("gives a chapter every row until the next chapter", () => {
    const rows = buildRows([
      { kind: "content", id: "intro", text: "Starting." },
      { kind: "tool", id: "c1", call: { id: "c1", name: "chapter", arguments: '{"title":"Read"}' } },
      tool("t1"),
      { kind: "content", id: "mid", text: "Found it." },
      { kind: "tool", id: "c2", call: { id: "c2", name: "chapter", arguments: '{"title":"Fix"}' } },
      tool("t2"),
    ]);
    const sections = buildSections(rows);

    expect(sections.map((s) => s.chapter?.title ?? null)).toEqual([null, "Read", "Fix"]);
    expect(sections[0].rows.map((r) => r.row.id)).toEqual(["intro"]);
    expect(sections[1].rows.map((r) => r.row.id)).toEqual(["tools-t1", "mid"]);
    expect(sections[2].rows.map((r) => r.row.id)).toEqual(["tools-t2"]);
  });

  it("keeps each row's index in the FLAT list so the spine stays turn-wide", () => {
    const rows = buildRows([
      { kind: "tool", id: "c1", call: { id: "c1", name: "chapter", arguments: '{"title":"A"}' } },
      tool("t1"),
      { kind: "tool", id: "c2", call: { id: "c2", name: "chapter", arguments: '{"title":"B"}' } },
      tool("t2"),
    ]);
    const sections = buildSections(rows);

    // Last row of chapter A is index 1, which is NOT rows.length - 1 (3).
    expect(sections[0].rows[0].index).toBe(1);
    expect(sections[1].rows[0].index).toBe(3);
    expect(rows.length - 1).toBe(3);
  });

  it("emits no empty leading section when the turn opens on a chapter", () => {
    const rows = buildRows([
      { kind: "tool", id: "c1", call: { id: "c1", name: "chapter", arguments: '{"title":"A"}' } },
      tool("t1"),
    ]);
    expect(buildSections(rows)).toHaveLength(1);
    expect(buildSections(rows)[0].chapter?.title).toBe("A");
  });

  it("returns one chapterless section for a turn with no chapters", () => {
    const rows = buildRows([{ kind: "content", id: "c", text: "Just an answer." }]);
    const sections = buildSections(rows);
    expect(sections).toHaveLength(1);
    expect(sections[0].chapter).toBeNull();
    expect(sections[0].rows.map((r) => r.row.id)).toEqual(["c"]);
  });

  it("keeps a trailing chapter that has no rows yet", () => {
    const rows = buildRows([
      { kind: "tool", id: "c1", call: { id: "c1", name: "chapter", arguments: '{"title":"Next"}' } },
    ]);
    const sections = buildSections(rows);
    expect(sections).toHaveLength(1);
    expect(sections[0].chapter?.title).toBe("Next");
    expect(sections[0].rows).toEqual([]);
  });
});
