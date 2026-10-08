/**
 * The agent's live reply over its file: visible while it streams, gone the
 * moment the file holds it, never shown twice.
 */

import { describe, expect, it } from "vitest";

import {
  applyLiveEvent,
  EMPTY_LIVE,
  mergeLive,
  settleWithRead,
  type LiveTranscript,
} from "@/apps/agent/lib/subagents/live-transcript";
import type { DbMessage } from "@/apps/agent/services/threads/thread-service";

type Event = Parameters<typeof applyLiveEvent>[1];

const fold = (events: Event[], readSeq = 0, start: LiveTranscript = EMPTY_LIVE) =>
  events.reduce((state, event) => applyLiveEvent(state, event, readSeq, 1_000).state, start);

const disk: DbMessage[] = [
  { id: "u1", role: "user", content: "Check the CSS.", timestamp: "2026-10-08T10:00:00Z" },
];

describe("live transcript", () => {
  it("shows thinking while it streams, before anything is on disk", () => {
    const state = fold([
      { type: "stream_attempt_started" },
      { type: "thinking", text: "The header " },
      { type: "thinking", text: "uses a grid." },
    ]);
    const merged = mergeLive(disk, state);
    expect(merged).toHaveLength(2);
    const live = merged[1];
    expect(live.role).toBe("assistant");
    expect(live.timeline).toEqual([
      expect.objectContaining({ kind: "thinking", text: "The header uses a grid." }),
    ]);
  });

  it("drops the live reply once a re-read issued after it began holds more messages", () => {
    let state = fold([{ type: "stream_attempt_started" }, { type: "text_delta", delta: "Done." }], 1);
    // A re-read that was already in flight when the reply began (#1) does not
    // set its base: it may not reflect the message before this one.
    state = settleWithRead(state, 1, 2);
    expect(state.reply?.base).toBeNull();
    state = settleWithRead(state, 2, 2);
    expect(state.reply?.base).toBe(2);
    expect(mergeLive(disk, state)).toHaveLength(2);
    state = settleWithRead(state, 3, 3);
    expect(state.reply).toBeNull();
  });

  it("draws a tool call from the file once it is there, with its live clock and result", () => {
    let state = fold([
      { type: "stream_attempt_started" },
      { type: "tool_use", id: "c1", name: "file_read", input: { path: "src/index.css" } },
      { type: "tool_execution_start", id: "c1", name: "file_read", input: { path: "src/index.css" } },
    ]);
    const onDisk: DbMessage[] = [
      ...disk,
      {
        id: "a1",
        role: "assistant",
        content: "",
        timestamp: "2026-10-08T10:00:05Z",
        tool_calls: [{ id: "c1", name: "file_read", arguments: '{"path":"src/index.css"}' }],
      },
    ];
    let merged = mergeLive(onDisk, state);
    expect(merged).toHaveLength(2);
    expect(merged[1].tool_calls?.[0].startedAt).toBe(1_000);

    state = applyLiveEvent(
      state,
      {
        type: "tool_execution_result",
        id: "c1",
        name: "file_read",
        input: {},
        content: "body",
        is_error: false,
      },
      0,
      1_400,
    ).state;
    merged = mergeLive(onDisk, state);
    expect(merged[1].tool_calls?.[0].result).toBe("body");
    expect(merged[1].tool_calls?.[0].durationMs).toBe(400);
  });

  it("marks a failed tool the way the main transcript does", () => {
    const state = fold([
      { type: "stream_attempt_started" },
      { type: "tool_use", id: "c1", name: "shell_execute", input: { command: "pnpm test" } },
      { type: "tool_execution_start", id: "c1", name: "shell_execute", input: {} },
      {
        type: "tool_execution_result",
        id: "c1",
        name: "shell_execute",
        input: {},
        content: "exit 1",
        is_error: true,
      },
    ]);
    expect(state.reply?.calls[0].result).toBe("[error] exit 1");
  });

  it("forgets a reply the runtime discarded for a retry", () => {
    const state = fold([
      { type: "stream_attempt_started" },
      { type: "text_delta", delta: "half a sen" },
      { type: "partial_reply_discarded", attempt: 1, max_attempts: 3, reason: "dropped" },
    ]);
    expect(mergeLive(disk, state)).toEqual(disk);
  });

  it("asks for a re-read when a model call starts or ends and when a message is taken in", () => {
    expect(applyLiveEvent(EMPTY_LIVE, { type: "stream_attempt_started" }, 0).reread).toBe(true);
    expect(applyLiveEvent(EMPTY_LIVE, { type: "message_stop", stop_reason: "end_turn" }, 0).reread).toBe(
      true,
    );
    expect(
      applyLiveEvent(EMPTY_LIVE, { type: "queued_message_injected", text: "also the docs" }, 0).reread,
    ).toBe(true);
    expect(applyLiveEvent(EMPTY_LIVE, { type: "thinking", text: "x" }, 0).reread).toBe(false);
  });
});
