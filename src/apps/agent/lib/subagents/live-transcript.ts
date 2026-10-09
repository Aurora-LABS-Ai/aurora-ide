/**
 * A sub-agent's transcript as it happens [pure].
 *
 * The agent's conversation file only gains a message when the model has
 * FINISHED it, so a view that read only the file sat blank for the whole of a
 * three-minute think and then jumped. The agent's stream (`agent_event` under
 * its turn id) carries every thinking and text delta and every tool call as
 * they happen; this module folds that stream into live assistant messages
 * laid over what the file already holds.
 *
 * The file stays the truth. A live reply is dropped the moment a re-read of
 * the file holds it: by content (the file has its tool calls, or its last
 * thought or text), or failing that once the file holds more messages than
 * it did when the reply began. From then on the reply is on disk, drawn from
 * there. A reply whose model call ended stays drawn until that happens
 * (`ended`): dropping it at the next call's start, before the re-read had
 * landed, blanked the last thought and reply for the length of the read on
 * every tool round (2026-10-09, "the preview cards flicker"). A tool's
 * running state (its clock, its result before the tool message is written)
 * is kept by id and laid onto whichever copy of the call is on screen.
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
  /** The reply of the model call in progress, if any. */
  reply: LiveReply | null;
  /**
   * Replies of model calls that have ended, oldest first, still drawn until a
   * re-read of the file holds them.
   */
  ended: LiveReply[];
  tools: Record<string, ToolRuntime>;
}

export const EMPTY_LIVE: LiveTranscript = { reply: null, ended: [], tools: {} };

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

const freshReply = (now: number, readSeq: number): LiveReply => ({
  events: [],
  calls: [],
  startedAt: now,
  base: null,
  baseFromRead: readSeq,
});

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
  const reply = state.reply ?? freshReply(now, readSeq);
  switch (event.type) {
    case "stream_attempt_started": {
      // A new model call. The previous reply, if it is still here, is on
      // disk by now or about to be; it stays drawn until the re-read that
      // holds it lands, so the tail never blanks between two calls.
      const ended =
        state.reply && state.reply.events.length > 0 ? [...state.ended, state.reply] : state.ended;
      return {
        state: { ...state, ended, reply: freshReply(now, readSeq) },
        reread: true,
      };
    }
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
      return { state: { ...state, reply: live, tools }, reread: false };
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
      return { state: { ...state, reply: live, tools }, reread: false };
    }
    case "partial_reply_discarded":
      // The runtime is re-requesting this call; what streamed is not a
      // message and will never be on disk. Replies that ended before it are.
      return { state: { ...state, reply: null }, reread: false };
    case "message_stop":
    case "queued_message_injected":
      return { state, reread: true };
    default:
      return { state, reread: false };
  }
}

const toolIdsOnDisk = (messages: DbMessage[]): Set<string> =>
  new Set(messages.flatMap((m) => (m.tool_calls ?? []).map((c) => c.id)));

/**
 * Whether the file already holds this reply: every tool call it made, or,
 * for a reply with none, its last thought or text inside one of the file's
 * assistant messages. Content is compared, not counts, because a quick reply
 * can be on disk before the first re-read issued after it began comes back,
 * and a count learned from that read would have kept it drawn twice.
 */
function heldByFile(messages: DbMessage[], reply: LiveReply, onDisk = toolIdsOnDisk(messages)): boolean {
  if (reply.calls.length > 0) return reply.calls.every((c) => onDisk.has(c.id));
  let last: Extract<TimelineEvent, { kind: "content" | "thinking" }> | undefined;
  for (let i = reply.events.length - 1; i >= 0; i -= 1) {
    const e = reply.events[i];
    if (e.kind === "content" || e.kind === "thinking") {
      last = e;
      break;
    }
  }
  const text = last?.text.trim();
  if (!text) return false;
  return messages.some((m) => {
    if (m.role !== "assistant") return false;
    if (last!.kind === "content") return typeof m.content === "string" && m.content.includes(text);
    const timeline = (m as { timeline?: unknown }).timeline;
    if (Array.isArray(timeline)) {
      return timeline.some(
        (e) =>
          !!e &&
          typeof e === "object" &&
          (e as { kind?: unknown }).kind === "thinking" &&
          typeof (e as { text?: unknown }).text === "string" &&
          ((e as { text: string }).text as string).includes(text),
      );
    }
    return typeof m.thinking === "string" && m.thinking.includes(text);
  });
}

/** One reply after a re-read: dropped when the file holds it, else with its base learned. */
function settleReply(
  reply: LiveReply,
  seq: number,
  messages: DbMessage[],
  onDisk: Set<string>,
): LiveReply | null {
  if (heldByFile(messages, reply, onDisk)) return null;
  if (reply.base === null) {
    return seq <= reply.baseFromRead ? reply : { ...reply, base: messages.length };
  }
  return messages.length > reply.base ? null : reply;
}

/**
 * A re-read of the file came back. `seq` is its number, `messages` what it
 * held. Drops every live reply the file now holds.
 */
export function settleWithRead(state: LiveTranscript, seq: number, messages: DbMessage[]): LiveTranscript {
  if (!state.reply && state.ended.length === 0) return state;
  const onDisk = toolIdsOnDisk(messages);
  const reply = state.reply ? settleReply(state.reply, seq, messages, onDisk) : null;
  const ended = state.ended
    .map((r) => settleReply(r, seq, messages, onDisk))
    .filter((r): r is LiveReply => r !== null);
  const endedSame = ended.length === state.ended.length && ended.every((r, i) => r === state.ended[i]);
  if (reply === state.reply && endedSame) return state;
  return { ...state, reply, ended };
}

/** The file's messages with the live replies and tool states laid over them. */
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
  const replies = live.reply ? [...live.ended, live.reply] : live.ended;
  if (replies.length === 0) return patched;
  const onDisk = toolIdsOnDisk(patched);
  const out = [...patched];
  for (const reply of replies) {
    if (reply.events.length === 0) continue;
    // On disk already (a read that holds it has not settled it yet): drawn
    // from there, never twice.
    if (heldByFile(patched, reply, onDisk)) continue;
    // A call the file already holds is drawn from there, with its live state.
    const events = reply.events.filter((e) => e.kind !== "tool" || !onDisk.has(e.id));
    if (events.length === 0) continue;
    const text = events
      .filter((e): e is Extract<TimelineEvent, { kind: "content" }> => e.kind === "content")
      .map((e) => e.text)
      .join("");
    out.push({
      id: `live-${reply.startedAt}`,
      role: "assistant",
      content: text,
      timestamp: new Date(reply.startedAt).toISOString(),
      timeline: events,
      tool_calls: reply.calls.filter((c) => !onDisk.has(c.id)),
    });
  }
  return out;
}
