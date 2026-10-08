/**
 * A sub-agent's transcript as it happens [pure].
 *
 * The agent's conversation file only gains a message when the model has
 * FINISHED it, so a view that read only the file sat blank for the whole of a
 * three-minute think and then jumped. The agent's stream (`agent_event` under
 * its turn id) carries every thinking and text delta and every tool call as
 * they happen; this module folds that stream into one live assistant message
 * laid over what the file already holds.
 *
 * The file stays the truth. The live reply is dropped the moment a re-read
 * of the file holds more messages than it did when the reply began: from
 * then on the reply is on disk, drawn from there. A tool's running state
 * (its clock, its result before the tool message is written) is kept by id
 * and laid onto whichever copy of the call is on screen.
 */

import type { AgentEventEnvelope } from "@/apps/agent/services/runtime/agent-runtime-client";
import type { DbMessage } from "@/apps/agent/services/threads/thread-service";
import {
  appendContent,
  appendThinking,
  upsertToolEvent,
  type TimelineEvent,
} from "@/apps/agent/components/conversation/timeline";
import type { ToolCall } from "@/apps/agent/components/tools/tool-call";

type AssistantEvent = AgentEventEnvelope["event"];

export interface ToolRuntime {
  startedAt?: number;
  result?: string;
  durationMs?: number;
}

export interface LiveReply {
  events: TimelineEvent[];
  calls: ToolCall[];
  startedAt: number;
  /**
   * Messages the file held when this reply began, learned from the first
   * re-read issued AFTER it began (`baseFromRead`). `null` until then.
   */
  base: number | null;
  /** Re-reads numbered at or below this predate the reply. */
  baseFromRead: number;
}

export interface LiveTranscript {
  reply: LiveReply | null;
  tools: Record<string, ToolRuntime>;
}

export const EMPTY_LIVE: LiveTranscript = { reply: null, tools: {} };

/** What a live event asks of the caller beyond the new state. */
export interface LiveStep {
  state: LiveTranscript;
  /** Re-read the file now: something just landed there or is about to. */
  reread: boolean;
}

const callFromInput = (id: string, name: string, input: unknown): ToolCall => ({
  id,
  name,
  arguments: typeof input === "string" ? input : JSON.stringify(input ?? {}),
});

function withCall(reply: LiveReply, call: ToolCall): LiveReply {
  const index = reply.calls.findIndex((c) => c.id === call.id);
  const calls =
    index < 0
      ? [...reply.calls, call]
      : reply.calls.map((c, i) => (i === index ? { ...c, ...call } : c));
  const merged = calls.find((c) => c.id === call.id) ?? call;
  return { ...reply, calls, events: upsertToolEvent(reply.events, merged) };
}

/**
 * Fold one event in. `readSeq` is the number of the latest re-read issued so
 * far; a reply that starts now takes its base from a later one.
 */
export function applyLiveEvent(
  state: LiveTranscript,
  event: AssistantEvent,
  readSeq: number,
  now: number = Date.now(),
): LiveStep {
  const reply =
    state.reply ??
    ({ events: [], calls: [], startedAt: now, base: null, baseFromRead: readSeq } as LiveReply);
  switch (event.type) {
    case "stream_attempt_started":
      // A new model call. The previous reply, if it is still here, is on
      // disk by now or about to be; the re-read settles it.
      return {
        state: {
          ...state,
          reply: { events: [], calls: [], startedAt: now, base: null, baseFromRead: readSeq },
        },
        reread: true,
      };
    case "thinking":
      return {
        state: { ...state, reply: { ...reply, events: appendThinking(reply.events, event.text, now) } },
        reread: false,
      };
    case "text_delta":
      return {
        state: { ...state, reply: { ...reply, events: appendContent(reply.events, event.delta) } },
        reread: false,
      };
    case "tool_use_delta":
      return {
        state: {
          ...state,
          reply: withCall(reply, { id: event.id, name: event.name, arguments: event.arguments }),
        },
        reread: false,
      };
    case "tool_use":
      return {
        state: { ...state, reply: withCall(reply, callFromInput(event.id, event.name, event.input)) },
        reread: false,
      };
    case "tool_execution_start": {
      const tools = { ...state.tools, [event.id]: { ...state.tools[event.id], startedAt: now } };
      const live = state.reply?.calls.some((c) => c.id === event.id)
        ? withCall(state.reply, { ...callFromInput(event.id, event.name, event.input), startedAt: now })
        : state.reply;
      return { state: { reply: live, tools }, reread: false };
    }
    case "tool_execution_result": {
      const prior = state.tools[event.id];
      const result = event.is_error ? `[error] ${event.content}` : event.content;
      const durationMs = prior?.startedAt !== undefined ? Math.max(0, now - prior.startedAt) : undefined;
      const tools = { ...state.tools, [event.id]: { ...prior, result, durationMs } };
      const live = state.reply?.calls.some((c) => c.id === event.id)
        ? withCall(state.reply, {
            ...callFromInput(event.id, event.name, event.input),
            result,
            durationMs,
          })
        : state.reply;
      return { state: { reply: live, tools }, reread: false };
    }
    case "partial_reply_discarded":
      return { state: { ...state, reply: null }, reread: false };
    case "message_stop":
    case "queued_message_injected":
      return { state, reread: true };
    default:
      return { state, reread: false };
  }
}

/**
 * A re-read of the file came back. `seq` is its number, `count` the messages
 * it held. Drops the live reply once the file holds it.
 */
export function settleWithRead(state: LiveTranscript, seq: number, count: number): LiveTranscript {
  const reply = state.reply;
  if (!reply) return state;
  if (reply.base === null) {
    if (seq <= reply.baseFromRead) return state;
    return { ...state, reply: { ...reply, base: count } };
  }
  if (count > reply.base) return { ...state, reply: null };
  return state;
}

/** The file's messages with the live reply and tool states laid over them. */
export function mergeLive(messages: DbMessage[], live: LiveTranscript): DbMessage[] {
  const hasTools = Object.keys(live.tools).length > 0;
  const patched = hasTools
    ? messages.map((m) => {
        if (!m.tool_calls?.some((c) => live.tools[c.id] && !c.result)) return m;
        return {
          ...m,
          tool_calls: m.tool_calls.map((c) => {
            const rt = live.tools[c.id];
            if (!rt || c.result) return c;
            return { ...c, startedAt: rt.startedAt, result: rt.result ?? c.result, durationMs: rt.durationMs };
          }),
          // The timeline holds the copy the card renders on the reload path
          // only by id, so the patched `tool_calls` above is what it joins.
        };
      })
    : messages;
  const reply = live.reply;
  if (!reply || reply.events.length === 0) return patched;
  // A call the file already holds is drawn from there, with its live state.
  const onDisk = new Set(patched.flatMap((m) => (m.tool_calls ?? []).map((c) => c.id)));
  const events = reply.events.filter((e) => e.kind !== "tool" || !onDisk.has(e.id));
  if (events.length === 0) return patched;
  const text = events
    .filter((e): e is Extract<TimelineEvent, { kind: "content" }> => e.kind === "content")
    .map((e) => e.text)
    .join("");
  return [
    ...patched,
    {
      id: `live-${reply.startedAt}`,
      role: "assistant",
      content: text,
      timestamp: new Date(reply.startedAt).toISOString(),
      timeline: events,
      tool_calls: reply.calls.filter((c) => !onDisk.has(c.id)),
    },
  ];
}
