import { describe, expect, it } from "vitest";

import type { DbMessage } from "@/apps/agent/services/threads/thread-service";
import {
  appendCompaction,
  appendContent,
  appendNotice,
  appendProcessBeat,
  appendThinking,
  beginReconnect,
  buildRows,
  buildSections,
  buildTurns,
  CHAPTER_TITLE_MAX,
  clearReconnect,
  shortenChapterTitle,
  textOf,
  turnWorkedMs,
  formatReplyTime,
  formatWorkedDuration,
  finishCompaction,
  settleImageEvent,
  type DirectImageEvent,
  type TimelineEvent,
  type TimelineRow,
} from "@/apps/agent/components/conversation/timeline";

describe("compaction terminal states", () => {
  it("settles failure without inventing an after-token count", () => {
    const started = appendCompaction([], "compact-1");
    const settled = finishCompaction(started, "compact-1", {
      status: "failed",
      beforeTokens: 269_000,
      reason: "empty_summary",
    });

    expect(settled[0]).toMatchObject({
      kind: "compaction",
      status: "failed",
      beforeTokens: 269_000,
      afterTokens: 0,
      reason: "empty_summary",
    });
  });
});

/**
 * The marker a manual `/compact` writes, read back the way the transcript
 * reads it.
 *
 * This is a different path from the one above: mid-turn compaction builds a
 * timeline EVENT and never round-trips through JSON, while `/compact` appends
 * a `compaction` message whose content is a small JSON blob. The parser used
 * to accept every terminal status out of that blob and not `running`, so a
 * compaction that had only just started rendered as a finished one — the
 * completed styling (no shimmer), no clock, and, with both counts still zero,
 * the bare words "Context compacted" three minutes before it was true.
 */
describe("a compaction marker read back from a message", () => {
  const marker = (payload: Record<string, unknown>): DbMessage =>
    ({
      id: "compact-msg",
      role: "compaction",
      content: JSON.stringify(payload),
      timestamp: "2026-09-10T04:00:00.000Z",
    }) as DbMessage;

  it("keeps a running compaction running", () => {
    const [turn] = buildTurns([
      marker({ beforeTokens: 0, afterTokens: 0, status: "running", startedAt: 1_700_000_000_000 }),
    ]);
    expect(turn.compaction).toMatchObject({
      status: "running",
      startedAt: 1_700_000_000_000,
    });
    expect(turn.compaction?.durationMs).toBeUndefined();
  });

  it("carries the drop and how long it took once settled", () => {
    const [turn] = buildTurns([
      marker({
        beforeTokens: 222_000,
        afterTokens: 59_800,
        status: "completed",
        startedAt: 1_700_000_000_000,
        durationMs: 182_000,
      }),
    ]);
    expect(turn.compaction).toMatchObject({
      status: "completed",
      beforeTokens: 222_000,
      afterTokens: 59_800,
      durationMs: 182_000,
    });
  });

  it("reads a stopped one as stopped, with its reason", () => {
    const [turn] = buildTurns([
      marker({ beforeTokens: 90_000, afterTokens: 0, status: "cancelled", reason: "user_stop" }),
    ]);
    expect(turn.compaction).toMatchObject({ status: "cancelled", reason: "user_stop" });
  });

  it("treats a missing clock as absent rather than as zero", () => {
    // What a marker restored from the session file looks like: it has the
    // drop and nothing else. A zero here would draw "0s" over a compaction
    // whose duration nobody recorded.
    const [turn] = buildTurns([
      marker({ beforeTokens: 222_000, afterTokens: 59_800, status: "completed" }),
    ]);
    expect(turn.compaction?.startedAt).toBeUndefined();
    expect(turn.compaction?.durationMs).toBeUndefined();
  });

  it("falls back to done on a marker it cannot read", () => {
    const [turn] = buildTurns([
      { id: "x", role: "compaction", content: "not json", timestamp: "" } as DbMessage,
    ]);
    expect(turn.compaction?.status).toBe("completed");
  });
});

describe("a dropped stream mid-turn", () => {
  it("rolls back to the attempt boundary even when content merged with an earlier reply", () => {
    const committed: TimelineEvent[] = [{ kind: "content", id: "c1", text: "Finished earlier." }];
    const live: TimelineEvent[] = [{ kind: "content", id: "c1", text: "Finished earlier.Partial retry" }];
    expect(beginReconnect(live, "r1", 1, 6, committed)).toEqual([
      ...committed, { kind: "reconnect", id: "r1", attempt: 1, maxAttempts: 6 },
    ]);
  });

  it("preserves a completed tool with empty output at the attempt boundary", () => {
    const committed: TimelineEvent[] = [
      { kind: "content", id: "c1", text: "Ran the command." },
      { kind: "tool", id: "t1", call: { id: "t1", name: "shell_execute", arguments: "{}", result: "" } },
    ];
    expect(beginReconnect([...committed, { kind: "content", id: "c2", text: "Partial" }], "r1", 1, 6, committed))
      .toEqual([...committed, { kind: "reconnect", id: "r1", attempt: 1, maxAttempts: 6 }]);
  });

  const toolCall = (id: string, result: string | null) => ({
    kind: "tool" as const,
    id,
    call: { id, name: "file_read", arguments: "{}", result },
  });

  /** The scenario from the field: inspect → "let me read file" → read → drop. */
  const afterTwoToolRounds: TimelineEvent[] = [
    { kind: "content", id: "c1", text: "Let me inspect the project." },
    toolCall("t1", "ok: 42 files"),
    { kind: "content", id: "c2", text: "Now let me read one file." },
    toolCall("t2", "ok: contents"),
  ];

  it("keeps every finished tool call and drops only the half-written reply", () => {
    const withPartial: TimelineEvent[] = [
      ...afterTwoToolRounds,
      { kind: "content", id: "c3", text: "The project is " },
    ];

    const out = beginReconnect(withPartial, "r1", 1, 3);

    expect(out.map((e) => e.kind)).toEqual([
      "content",
      "tool",
      "content",
      "tool",
      "reconnect",
    ]);
    // The work that already happened must not re-run or vanish.
    expect(out.filter((e) => e.kind === "tool")).toHaveLength(2);
    expect(out.at(-1)).toEqual({ kind: "reconnect", id: "r1", attempt: 1, maxAttempts: 3 });
  });

  it("drops a tool card whose arguments were still streaming", () => {
    // The retry gets a fresh call id from the provider, so a half-streamed
    // card left behind would sit there forever next to its own replacement.
    const out = beginReconnect(
      [...afterTwoToolRounds, { kind: "content", id: "c3", text: "Now " }, toolCall("t3", null)],
      "r1",
      1,
      3,
    );
    expect(out.filter((e) => e.kind === "tool").map((e) => e.id)).toEqual(["t1", "t2"]);
    expect(out.some((e) => e.kind === "content" && e.text === "Now ")).toBe(false);
  });

  it("never eats the user's mid-turn message", () => {
    const out = beginReconnect(
      [
        { kind: "user_injection", id: "u1", text: "also check the tests" },
        { kind: "content", id: "c1", text: "Sure, I " },
      ],
      "r1",
      1,
      3,
    );
    expect(out.map((e) => e.kind)).toEqual(["user_injection", "reconnect"]);
  });

  it("replaces the previous marker instead of stacking one per attempt", () => {
    const first = beginReconnect(
      [{ kind: "content", id: "c1", text: "The project is " }],
      "r1",
      1,
      3,
    );
    const second = beginReconnect(first, "r2", 2, 3);
    expect(second.filter((e) => e.kind === "reconnect")).toHaveLength(1);
    expect(second.at(-1)).toMatchObject({ id: "r2", attempt: 2 });
  });

  it("rebuilds the flat copy text so the discarded fragment cannot survive in it", () => {
    // `content` feeds Copy and the reload fallback. A string cannot be
    // un-appended, so it is re-derived — otherwise the dropped half-sentence
    // is invisible in the transcript and still present everywhere else.
    const out = beginReconnect(
      [
        { kind: "content", id: "c1", text: "Let me inspect." },
        toolCall("t1", "ok"),
        { kind: "thinking", id: "k1", text: "hmm" },
        { kind: "content", id: "c2", text: "The project is " },
      ],
      "r1",
      1,
      3,
    );
    expect(textOf(out, "content")).toBe("Let me inspect.");
    expect(textOf(out, "thinking")).toBe("");
  });

  it("leaves nothing behind once the retry streams", () => {
    const reconnecting = beginReconnect(
      [{ kind: "content", id: "c1", text: "The project is " }],
      "r1",
      1,
      3,
    );
    const recovered = clearReconnect(reconnecting);
    expect(recovered).toEqual([]);
    // Same array back when there is nothing to clear — this runs on every
    // text flush, and a new array each time would re-render the transcript.
    const settled: TimelineEvent[] = [{ kind: "content", id: "c1", text: "done" }];
    expect(clearReconnect(settled)).toBe(settled);
  });

  it("renders as its own row carrying the attempt count", () => {
    const rows = buildRows(beginReconnect([], "r1", 2, 3));
    expect(rows).toEqual([{ type: "reconnect", id: "r1", attempt: 2, maxAttempts: 3 }]);
  });
});

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

/**
 * Every row in a turn is rendered with `key={row.id}`, and consecutive assistant
 * messages are merged into ONE turn with their event lists concatenated — so a
 * row id only has to be unique within its own message to pass every other test
 * here, and still collide once the merge happens.
 *
 * It went wrong exactly that way: a machine-started turn seeded its beat as a
 * separate assistant message with an id from `genId()` while every streamed
 * event uses `nextEventId()`. React reported two children with the same key,
 * dropped children, and the turn stopped rendering as it streamed — with no
 * error anywhere near the code that caused it.
 */
/**
 * A background process ending while the conversation was idle STARTS a turn.
 * On disk that is a user-role message holding one process-event block; the
 * reload path and the live path both hand the transcript a `process` row.
 *
 * The row has to open a fresh assistant turn. The first live run seeded the
 * beat into the streaming assistant message with no row above it, so it was
 * consecutive with the previous reply, the two merged, and the answer streamed
 * into a bubble that had already settled and scrolled past — the turn ran, was
 * on disk, and never appeared until the thread was reopened.
 */
describe("a turn opened by a background process", () => {
  const previousExchange: DbMessage[] = [
    { id: "u1", role: "user", content: "run it in background", timestamp: "2026-09-08T00:00:00.000Z" },
    {
      id: "a1",
      role: "assistant",
      content: "It's running.",
      timestamp: "2026-09-08T00:00:05.000Z",
      timeline: [{ kind: "content", id: "ev1", text: "It's running." }],
    },
  ];
  const processRow: DbMessage = {
    id: "p1",
    role: "process",
    content: "Finished count_seconds.py · exit 0",
    timestamp: "2026-09-08T00:00:35.000Z",
  };
  const reply: DbMessage = {
    id: "a2",
    role: "assistant",
    content: "It finished cleanly.",
    timestamp: "2026-09-08T00:00:39.000Z",
    timeline: [
      { kind: "thinking", id: "ev2", text: "…" },
      { kind: "content", id: "ev3", text: "It finished cleanly." },
    ],
  };

  it("is its own AURORA turn, never folded into the reply before it", () => {
    const turns = buildTurns([...previousExchange, processRow, reply]);

    expect(turns.map((t) => t.role)).toEqual(["user", "assistant", "assistant"]);
    const [, before, opened] = turns;
    // The settled reply is untouched…
    expect(before.content).toBe("It's running.");
    expect(before.events).toHaveLength(1);
    // …and the new turn carries the beat first, then everything streamed.
    expect(opened.startedBy).toBe("process");
    expect(buildRows(opened.events).map((row) => row.type)).toEqual([
      "process_beat",
      "thinking",
      "content",
    ]);
    expect(opened.content).toBe("It finished cleanly.");
  });

  it("draws the beat in the checklist beat's shape with the one-line summary", () => {
    const [, , opened] = buildTurns([...previousExchange, processRow, reply]);
    const [beat] = buildRows(opened.events);

    expect(beat).toMatchObject({
      type: "process_beat",
      text: "Finished count_seconds.py · exit 0",
    });
  });

  it("stands alone while the reply has not started streaming yet", () => {
    // The live path appends the row and the streaming seed in two store
    // updates; a frame can render between them.
    const turns = buildTurns([...previousExchange, processRow]);

    expect(turns).toHaveLength(3);
    expect(turns[2].role).toBe("assistant");
    expect(buildRows(turns[2].events).map((row) => row.type)).toEqual(["process_beat"]);
  });

  it("clocks the turn from the moment the process ended", () => {
    const [, , opened] = buildTurns([...previousExchange, processRow, reply]);

    expect(turnWorkedMs(opened)).toBe(4_000);
  });

  it("keeps every row id unique with the streamed events behind the beat", () => {
    const [, , opened] = buildTurns([...previousExchange, processRow, reply]);
    const ids = buildRows(opened.events).map((row) => row.id);

    expect(new Set(ids).size).toBe(ids.length);
  });

  it("marks a turn a person opened as theirs", () => {
    const [, before] = buildTurns(previousExchange);

    expect(before.startedBy).toBe("user");
  });
});

describe("row ids survive the assistant merge", () => {
  it("keeps every row id unique across merged assistant messages", () => {
    const messages: DbMessage[] = [
      {
        id: "beat",
        role: "assistant",
        content: "",
        timestamp: "2026-09-08T00:00:00.000Z",
        timeline: [{ kind: "process_beat", id: "ev1", text: "Failed slow failer · exit 1" }],
      },
      {
        id: "streamed",
        role: "assistant",
        content: "",
        timestamp: "2026-09-08T00:00:01.000Z",
        timeline: [
          { kind: "thinking", id: "ev2", text: "…" },
          { kind: "content", id: "ev3", text: "Reading the log." },
        ],
      },
    ];

    const [turn] = buildTurns(messages);
    const ids = buildRows(turn.events).map((row) => row.id);

    expect(new Set(ids).size).toBe(ids.length);
  });

  it("keeps rendering when two messages mint the same id", () => {
    // The shape of the bug: two messages, each numbering its events from one,
    // merged into a single turn. React saw duplicate keys, dropped children,
    // and the transcript stopped updating while the reply was still streaming.
    const messages: DbMessage[] = [
      {
        id: "beat",
        role: "assistant",
        content: "",
        timestamp: "2026-09-08T00:00:00.000Z",
        timeline: [{ kind: "process_beat", id: "ev1", text: "Failed slow failer · exit 1" }],
      },
      {
        id: "streamed",
        role: "assistant",
        content: "",
        timestamp: "2026-09-08T00:00:01.000Z",
        timeline: [{ kind: "content", id: "ev1", text: "Reading the log." }],
      },
    ];

    const [turn] = buildTurns(messages);
    const rows = buildRows(turn.events);
    const ids = rows.map((row) => row.id);

    // Both rows survive — losing one is the bug, not the duplicate id itself.
    expect(rows).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    expect(rows.map((row) => row.type)).toEqual(["process_beat", "content"]);
  });

  it("leaves ids untouched when there is nothing to fix", () => {
    const messages: DbMessage[] = [
      {
        id: "only",
        role: "assistant",
        content: "",
        timestamp: "2026-09-08T00:00:00.000Z",
        timeline: [
          { kind: "content", id: "ev1", text: "one" },
          { kind: "content", id: "ev2", text: "two" },
        ],
      },
    ];

    const [turn] = buildTurns(messages);
    expect(buildRows(turn.events).map((row) => row.id)).toEqual(["ev1", "ev2"]);
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

  it("adds up generated tokens across every message of a turn, never input", () => {
    const turns = buildTurns([
      msg("user", "2026-07-28T10:00:00.000Z"),
      msg("assistant", "2026-07-28T10:00:05.000Z", {
        usage: { input_tokens: 90_000, output_tokens: 400 },
      }),
      msg("assistant", "2026-07-28T10:00:09.000Z", {
        usage: { input_tokens: 91_000, output_tokens: 1_103, estimated: true },
      }),
      // A request that reported nothing adds nothing, and is not a zero.
      msg("assistant", "2026-07-28T10:00:12.000Z"),
      msg("user", "2026-07-28T10:01:00.000Z"),
      msg("assistant", "2026-07-28T10:01:04.000Z"),
    ]);
    const [first, second] = turns.filter((t) => t.role === "assistant");
    expect(first.outputTokens).toBe(1_503);
    expect(first.outputTokensEstimated).toBe(true);
    expect(second.outputTokens).toBeUndefined();
  });

  it("dates a reply time only when it is from another day", () => {
    const now = new Date(2026, 8, 23, 16, 0);
    const time = (d: Date) => d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    const today = new Date(2026, 8, 23, 14, 14);
    expect(formatReplyTime(today, now)).toBe(time(today));
    const earlier = new Date(2026, 8, 21, 14, 14);
    expect(formatReplyTime(earlier, now)).not.toBe(time(earlier));
    expect(formatReplyTime(earlier, now).endsWith(time(earlier))).toBe(true);
    expect(formatReplyTime(earlier, now)).not.toContain("2026");
    expect(formatReplyTime(new Date(2025, 8, 21, 14, 14), now)).toContain("2025");
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

describe("checklist rows in the transcript", () => {
  const todoCall = (id: string, name: string) =>
    ({
      kind: "tool" as const,
      id,
      call: {
        id,
        name,
        arguments: "{}",
      },
    });
  const toolEvent = (id: string, name: string) =>
    ({
      kind: "tool" as const,
      id,
      call: { id, name, arguments: "{}" },
    });

  it("shows TaskCreate and TaskUpdate — a checklist that moves must leave a trace", () => {
    // Each card names only what CHANGED, so every one carries its own news.
    // The list itself is not repeated here: it has one home, the header
    // indicator, which is live rather than a record of a moment.
    const rows = buildRows([todoCall("a", "TaskCreate"), todoCall("b", "TaskUpdate")]);
    expect(rows).toHaveLength(1);
    expect(rows[0].type === "tools" && rows[0].tools).toHaveLength(2);
  });

  it("drops TaskList — a lookup changes nothing a reader could care about", () => {
    const rows = buildRows([
      { kind: "content", id: "c1", text: "Starting." },
      todoCall("r", "TaskList"),
    ]);
    expect(rows.map((r) => r.type)).toEqual(["content"]);
  });

  it("does not split a run of real tools around a dropped read", () => {
    // Dropping the event must not also flush the group — otherwise a lookup
    // between two edits would break them into two separate cards.
    const rows = buildRows([
      toolEvent("a", "file_read"),
      todoCall("r", "TaskList"),
      toolEvent("b", "file_edit"),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].type === "tools" && rows[0].tools.map((c) => c.name)).toEqual([
      "file_read",
      "file_edit",
    ]);
  });

  it("shows a checklist call whose arguments never parsed", () => {
    // A call that is unreadable is exactly the one worth seeing — silence
    // would be indistinguishable from a tool that failed to run. The name
    // alone decides now, so a half-streamed call is judged correctly.
    const rows = buildRows([
      {
        kind: "tool",
        id: "x",
        call: { id: "x", name: "TaskCreate", arguments: '{"subject":' },
      },
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
    //
    // Only a MISSING title still rejects. An over-long one is shortened and
    // succeeds — see the shortening tests below.
    const rows = buildRows([
      chapter("c1", JSON.stringify({ title: "  " }), "[error] `title` is required"),
    ]);
    expect(rows.map((r) => r.type)).toEqual(["tools"]);
  });

  /**
   * The heading is drawn from the STREAMED arguments, before any tool result
   * exists, so the shortening has to happen here as well as in Rust. Left to
   * the runtime alone, the transcript would keep showing the full over-long
   * title the model sent while the model was told it got a shortened one.
   */
  it("shortens an over-long title rather than showing a paragraph", () => {
    const long = "Read the reload path and then fix the tool join before running every test";
    const [row] = buildRows([chapter("c1", JSON.stringify({ title: long }))]);
    const title = row.type === "chapter" ? row.title : "";
    expect([...title].length).toBeLessThanOrEqual(CHAPTER_TITLE_MAX);
    expect(title).toBe("Read the reload path and then fix the tool join before…");
  });

  it("leaves a title that fits completely alone", () => {
    const exact = "x".repeat(CHAPTER_TITLE_MAX);
    expect(shortenChapterTitle(exact)).toBe(exact);
    expect(shortenChapterTitle("Run the tests")).toBe("Run the tests");
  });

  /** Agreeing with Rust is the point — the two shorten the same input alike. */
  it("matches the runtime's shortening rules", () => {
    // One word longer than the budget: hard cut, because there is no boundary
    // to prefer and showing nothing is worse.
    const oneWord = shortenChapterTitle("x".repeat(120));
    expect([...oneWord].length).toBe(CHAPTER_TITLE_MAX);
    expect(oneWord.endsWith("…")).toBe(true);

    // An early lone space must not shorten the whole heading to "a…".
    const early = shortenChapterTitle(`a ${"x".repeat(80)}`);
    expect([...early].length).toBeGreaterThanOrEqual(CHAPTER_TITLE_MAX / 2);
  });

  /** Code points, not UTF-16 units: `.length` would cut a pair in half. */
  it("counts characters, not UTF-16 units", () => {
    const emoji = "🚀".repeat(40);
    expect(shortenChapterTitle(emoji)).toBe(emoji);
    expect([...shortenChapterTitle("🚀".repeat(80))].length).toBe(CHAPTER_TITLE_MAX);
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
      {
        type: "chapter",
        id: "c1",
        title: "Wire the reload",
        // Reload has no live clock, so the chapter takes its owning message's
        // timestamp — that is what lets a reopened chat still show how long
        // each chapter took.
        at: Date.parse("2026-08-04T07:00:00.000Z"),
      },
      { type: "content", id: "e1", text: "Done." },
    ]);
  });

  it("times each chapter from its own start to the next one's", () => {
    const minute = 60_000;
    const t0 = Date.parse("2026-08-04T07:00:00.000Z");
    const rows: TimelineRow[] = [
      { type: "chapter", id: "c1", title: "First", at: t0 },
      { type: "content", id: "e1", text: "a" },
      { type: "chapter", id: "c2", title: "Second", at: t0 + 2 * minute },
      { type: "content", id: "e2", text: "b" },
    ];
    // The turn ended three minutes in, which is what closes the LAST chapter.
    const sections = buildSections(rows, t0 + 3 * minute);
    expect(sections.map((s) => s.chapter?.durationMs)).toEqual([2 * minute, minute]);
  });

  it("reports no time for a chapter it cannot measure honestly", () => {
    const t0 = Date.parse("2026-08-04T07:00:00.000Z");
    // Streaming turn: no end passed, so the final chapter has a start and no
    // close. It must report nothing rather than a number that keeps growing.
    const open = buildSections([{ type: "chapter", id: "c1", title: "Live", at: t0 }]);
    expect(open[0].chapter?.durationMs).toBeUndefined();

    // A legacy turn with no clock on the chapter at all.
    const legacy = buildSections(
      [{ type: "chapter", id: "c1", title: "Old" }],
      t0 + 60_000,
    );
    expect(legacy[0].chapter?.durationMs).toBeUndefined();
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

  /**
   * The same separator, arriving in the SAME block as the narration.
   *
   * `appendContent` merges consecutive content deltas, so a model that writes a
   * sentence and then a `...` separator produces one block, not two. It has real
   * words in it, so the silence check passes it — and the trailing dots then
   * rendered as their own paragraph under the sentence.
   */
  it("drops a trailing dots separator without touching the prose above it", () => {
    const rows = buildRows([
      {
        kind: "content",
        id: "c",
        text: "Let me read the key wiring files to trace the IPC contract.\n\n...",
      },
    ]);
    expect(rows).toEqual([
      {
        type: "content",
        id: "c",
        text: "Let me read the key wiring files to trace the IPC contract.",
      },
    ]);
  });

  it("leaves a dots line in the middle of a block alone", () => {
    // Inside a fence it is elided code, and removing it would change what the
    // author wrote. Only an edge can be a separator.
    const body = "Here is the shape:\n\n```py\ndef f():\n    ...\n```\n\nThat is all.";
    const rows = buildRows([{ kind: "content", id: "c", text: body }]);
    expect(rows).toEqual([{ type: "content", id: "c", text: body }]);
  });

  it("never mistakes a horizontal rule for filler", () => {
    // `---` is a thematic break and `***` is emphasis; both are real markdown.
    const body = "Summary.\n\n---\n\n## Details";
    const rows = buildRows([{ kind: "content", id: "c", text: body }]);
    expect(rows).toEqual([{ type: "content", id: "c", text: body }]);
  });

  /**
   * Real thread `300e570b`: fifteen text blocks of exactly "..." between the
   * tool calls, one per gap, each rendering as a stray row of dots.
   */
  it("renders no row for a content segment that is only filler dots", () => {
    const rows = buildRows([
      { kind: "tool", id: "t1", call: { id: "t1", name: "file_read", arguments: "{}" } },
      { kind: "content", id: "d1", text: "..." },
      { kind: "tool", id: "t2", call: { id: "t2", name: "file_write", arguments: "{}" } },
      { kind: "content", id: "d2", text: "…" },
      { kind: "tool", id: "t3", call: { id: "t3", name: "grep", arguments: "{}" } },
    ]);
    // Not just dropped — the run must stay ONE group, exactly like whitespace.
    expect(rows.map((r) => r.type)).toEqual(["tools"]);
    const tools = rows[0];
    if (tools.type !== "tools") throw new Error("expected a tools row");
    expect(tools.tools.map((t) => t.id)).toEqual(["t1", "t2", "t3"]);
  });

  /** The filter must never eat something a reader could act on. */
  it("keeps a short real sentence that merely contains dots", () => {
    const rows = buildRows([
      { kind: "content", id: "c1", text: "Done." },
      { kind: "content", id: "c2", text: "...and the tests pass." },
    ]);
    expect(rows.map((r) => r.type)).toEqual(["content", "content"]);
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

describe("a picture made directly", () => {
  const pending: DirectImageEvent = {
    kind: "image",
    id: "img-1",
    status: "pending",
    width: 1536,
    height: 1024,
    prompt: "a lighthouse at dusk",
    model: "gpt-image-1.5",
  };

  it("is its own row, and breaks a tool run like any spoken content", () => {
    const rows = buildRows([pending]);
    expect(rows).toEqual([{ type: "image", id: "img-1", image: pending }]);
  });

  /** The hole the placeholder reserved is the row the picture lands in. */
  it("settles in place, keeping its position and id", () => {
    const tl: TimelineEvent[] = [
      { kind: "content", id: "c", text: "before" },
      pending,
      { kind: "content", id: "d", text: "after" },
    ];
    const next = settleImageEvent(tl, "img-1", (e) => ({
      ...e,
      status: "ready",
      asset: "lighthouse.png",
      path: "C:/x/lighthouse.png",
      mediaType: "image/png",
      artifactId: "art-1",
    }));
    expect(next.map((e) => e.id)).toEqual(["c", "img-1", "d"]);
    const settled = next[1];
    expect(settled.kind).toBe("image");
    if (settled.kind === "image") {
      expect(settled.status).toBe("ready");
      expect(settled.asset).toBe("lighthouse.png");
      expect(settled.width).toBe(1536);
    }
  });

  it("leaves every other event untouched", () => {
    const other: TimelineEvent = { kind: "notice", id: "n", text: "x" };
    const next = settleImageEvent([other, pending], "nope", (e) => ({ ...e, status: "failed" }));
    expect(next[0]).toBe(other);
    expect(next[1]).toBe(pending);
  });

  /** The reload path emits the same shape from a persisted `ContentBlock::Image`. */
  it("renders a reopened chat's picture from its ordered timeline", () => {
    const messages: DbMessage[] = [
      { id: "u1", role: "user", content: "a lighthouse", timestamp: "2026-09-04T10:00:00Z" },
      {
        id: "a1",
        role: "assistant",
        content: "[image lighthouse.png 1536x1024]",
        timestamp: "2026-09-04T10:00:20Z",
        tool_calls: [],
        timeline: [
          {
            kind: "image",
            id: "a1-image-0",
            status: "ready",
            asset: "lighthouse.png",
            path: "C:/x/lighthouse.png",
            mediaType: "image/png",
            width: 1536,
            height: 1024,
            prompt: "a lighthouse",
            model: "gpt-image-1.5",
            artifactId: "art-1",
          },
        ],
      },
    ];
    const turns = buildTurns(messages);
    const reply = turns.find((turn) => turn.role === "assistant");
    expect(reply).toBeDefined();
    const rows = buildRows(reply!.events);
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe("image");
  });
});

/**
 * A background process ending rides the same mid-turn slot a user's message
 * does. It used to come out of that slot as a `user_injection` — the user's own
 * row, tooltipped "You added this mid-turn", over a sentence beginning "The
 * user stopped…". It has to reach the transcript as its own kind of row.
 */
describe("background process beats", () => {
  it("keeps a process ending out of the user's row", () => {
    const events = appendProcessBeat([], "Finished pnpm build · exit 0");
    const rows = buildRows(events);

    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe("process_beat");
    expect(rows.some((row) => row.type === "user_injection")).toBe(false);
  });

  it("sits where it happened, between the tool result and what came after", () => {
    // The order is the point: the agent was told mid-turn, and the transcript
    // has to show the interruption at the moment it interrupted.
    let events: TimelineEvent[] = appendContent([], "Kicking off the build.");
    events = appendProcessBeat(events, "Finished pnpm build · exit 0");
    events = appendContent(events, "Build's clean.");

    expect(buildRows(events).map((row) => row.type)).toEqual([
      "content",
      "process_beat",
      "content",
    ]);
  });
});
