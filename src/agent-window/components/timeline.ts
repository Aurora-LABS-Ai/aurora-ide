/**
 * Agent Window — assistant turn timeline (leaf, non-component).
 *
 * The whole reason this exists: an assistant turn is NOT "thinking, then all
 * tools, then all text". The model interleaves — it says something, calls a
 * tool, says more, calls more tools. Rendering must preserve that CHRONOLOGY
 * (the IDE does this via `message.timeline` + `buildTimelineRows`). This module
 * is the agent window's analogue:
 *
 *   - a live turn streams an ordered `TimelineEvent[]` onto the assistant
 *     message (see the send hook's append/upsert helpers below);
 *   - a reloaded turn (from disk, no live timeline) is SYNTHESISED per message
 *     as thinking → content(preamble) → tools, which matches how an assistant
 *     message with tool calls is emitted;
 *   - consecutive assistant messages are merged into ONE turn so a turn split
 *     across several persisted messages still renders as a single bubble;
 *   - `buildRows` then groups *consecutive* tool events so a long run collapses
 *     to one "N calls" row while text between runs stays in place.
 */

import type {
  AttachedCommandChip,
  AttachedPromptChip,
  AttachedSelectedElement,
  DbMessage,
} from "../../services/thread-service";
import { streamedToolStringArguments, toolStatus, type ToolCall } from "./tool-call";

/** Group a run of tool calls when there are at least this many (matches IDE). */
export const TOOL_GROUP_MIN = 6;

export type TimelineEvent =
  | { kind: "thinking"; id: string; text: string }
  | { kind: "content"; id: string; text: string }
  | { kind: "tool"; id: string; call: ToolCall }
  | { kind: "user_injection"; id: string; text: string }
  | { kind: "compaction"; id: string; beforeTokens: number; afterTokens: number; running: boolean }
  | { kind: "notice"; id: string; text: string };

export type TimelineRow =
  | { type: "thinking"; id: string; text: string }
  | { type: "content"; id: string; text: string }
  | { type: "tools"; id: string; tools: ToolCall[] }
  | { type: "user_injection"; id: string; text: string }
  | { type: "compaction"; id: string; beforeTokens: number; afterTokens: number; running: boolean }
  | { type: "notice"; id: string; text: string }
  /** A `chapter` call — the agent naming the part of the work it is starting. */
  | { type: "chapter"; id: string; title: string };

export interface AgwTurn {
  id: string;
  role: "user" | "assistant" | "compaction";
  /** User text, or the assistant turn's concatenated content (for copy). */
  content: string;
  /** Assistant only — ordered events for rendering. */
  events: TimelineEvent[];
  /** Assistant only — true while the reasoning phase is live. */
  isThinking: boolean;
  /** User only — inspector-picked element chips. */
  attachedSelectedElements?: AttachedSelectedElement[] | null;
  /** User only — `/`-attached skill / rule / MCP chips. */
  attachedCommands?: AttachedCommandChip[] | null;
  /** User only — exact file and directive pills from the composer. */
  attachedPromptChips?: AttachedPromptChip[] | null;
  /**
   * Compaction only — the inline "Context compacted" marker. `running` shows
   * the live shimmer; `beforeTokens`/`afterTokens` label the drop once done.
   * The summary itself is never carried to the UI.
   */
  compaction?: { beforeTokens: number; afterTokens: number; running: boolean };
  /**
   * Assistant only — when the work started, i.e. the timestamp of the user
   * message that prompted this turn. Paired with {@link AgwTurn.endedAt} it
   * gives the wall-clock the agent spent on this turn.
   */
  startedAt?: string;
  /** Assistant only — timestamp of the last message merged into this turn. */
  endedAt?: string;
}

const parseTs = (value: string | undefined): number | null => {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
};

/**
 * Wall-clock the agent spent on one assistant turn, in ms.
 *
 * Derived from timestamps the runtime already persists on every message, so
 * this is correct for reloaded history as well as a live turn — nothing extra
 * is recorded.
 *
 * `null` when the turn has no usable span (a turn with no preceding user
 * message, or clock values that would produce a negative duration).
 */
export function turnWorkedMs(turn: AgwTurn): number | null {
  if (turn.role !== "assistant") return null;
  const start = parseTs(turn.startedAt);
  const end = parseTs(turn.endedAt);
  if (start === null || end === null) return null;
  const span = end - start;
  return span > 0 ? span : null;
}

/**
 * Compact duration label: `12s`, `4m`, `1h 4m`.
 *
 * Sub-second work reads as `<1s` rather than `0s` — a turn that ran at all
 * should never claim it took no time.
 */
export function formatWorkedDuration(ms: number): string {
  if (ms < 1000) return "<1s";
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
}

let seq = 0;
/** Monotonic id for freshly-created timeline segments (stable across appends). */
export function nextEventId(): string {
  seq += 1;
  return `ev${seq}`;
}

// ── Live updaters (used by the send hook) ────────────────────────────

export function appendThinking(tl: TimelineEvent[], text: string): TimelineEvent[] {
  const last = tl[tl.length - 1];
  if (last && last.kind === "thinking") {
    return [...tl.slice(0, -1), { ...last, text: last.text + text }];
  }
  return [...tl, { kind: "thinking", id: nextEventId(), text }];
}

export function appendContent(tl: TimelineEvent[], text: string): TimelineEvent[] {
  const last = tl[tl.length - 1];
  if (last && last.kind === "content") {
    return [...tl.slice(0, -1), { ...last, text: last.text + text }];
  }
  return [...tl, { kind: "content", id: nextEventId(), text }];
}

/** Append a mid-turn user injection (the user's queued message, drained by the
 *  runtime at a tool-result boundary). Renders inline between tool/text rows so
 *  the note appears exactly where the model saw it. */
export function appendUserInjection(tl: TimelineEvent[], text: string): TimelineEvent[] {
  return [...tl, { kind: "user_injection", id: nextEventId(), text }];
}

/** Append a runtime notice (e.g. "the reply was cut off at the output limit")
 *  at the CURRENT point in the assistant timeline. It sits inline, in its own
 *  marker — never folded into the message text, because a limit the RUNTIME
 *  hit is not something the model said. Deduped against the last event so a
 *  repeated notice within one turn doesn't stack. */
export function appendNotice(tl: TimelineEvent[], text: string): TimelineEvent[] {
  const last = tl[tl.length - 1];
  if (last?.kind === "notice" && last.text === text) return tl;
  return [...tl, { kind: "notice", id: nextEventId(), text }];
}

/** Append a compaction marker at the CURRENT point in the assistant timeline,
 *  so content streamed afterward renders BELOW it (the marker sits exactly
 *  where compaction fired mid-turn). Returns the event id so the caller can
 *  flip `running`/counts on completion. */
export function appendCompaction(tl: TimelineEvent[], id: string): TimelineEvent[] {
  return [...tl, { kind: "compaction", id, beforeTokens: 0, afterTokens: 0, running: true }];
}

/** Mark a compaction event done with its before→after counts. */
export function updateCompaction(
  tl: TimelineEvent[],
  id: string,
  beforeTokens: number,
  afterTokens: number,
): TimelineEvent[] {
  return tl.map((e) =>
    e.kind === "compaction" && e.id === id
      ? { kind: "compaction", id, beforeTokens, afterTokens, running: false }
      : e,
  );
}

export function upsertToolEvent(tl: TimelineEvent[], call: ToolCall): TimelineEvent[] {
  const idx = tl.findIndex((e) => e.kind === "tool" && e.id === call.id);
  if (idx >= 0) {
    const next = [...tl];
    next[idx] = { kind: "tool", id: call.id, call };
    return next;
  }
  return [...tl, { kind: "tool", id: call.id, call }];
}

// ── Reload path (synthesise a timeline from persisted fields) ─────────

/**
 * A timeline as it arrives from the RELOAD path (Rust `session_to_db_messages`).
 * Identical to the live shape except that a tool event carries its ID ONLY —
 * the call, and the result a later Tool message folds into it, live in
 * `tool_calls`. Joining by id at read time keeps exactly one copy of that
 * payload, so the order and the call can never disagree.
 */
type OrderedTimelineEvent =
  | Exclude<TimelineEvent, { kind: "tool" }>
  | { kind: "tool"; id: string; call?: ToolCall };

function isOrderedTimeline(raw: unknown): raw is OrderedTimelineEvent[] {
  return (
    Array.isArray(raw) &&
    raw.length > 0 &&
    raw.every((e) => e && typeof e === "object" && "kind" in (e as object))
  );
}

/**
 * Join a timeline's ORDER with the call payloads on the message.
 *
 * Returns the input untouched when every tool event already carries its call,
 * which is always true of a live stream — so a streaming turn pays nothing for
 * this on any frame.
 */
function hydrateToolEvents(
  events: OrderedTimelineEvent[],
  calls: ToolCall[],
): TimelineEvent[] {
  if (!events.some((e) => e.kind === "tool" && !e.call)) {
    // Checked above: every tool event carries its call, so this IS the live shape.
    return events as TimelineEvent[];
  }
  const byId = new Map(calls.map((c) => [c.id, c]));
  const out: TimelineEvent[] = [];
  for (const e of events) {
    if (e.kind !== "tool") {
      out.push(e);
      continue;
    }
    const call = e.call ?? byId.get(e.id);
    // An id with no payload cannot render anything truthful, and `tool_calls`
    // is the authority on what ran — so drop it rather than show a blank card.
    if (call) out.push({ kind: "tool", id: e.id, call });
  }
  return out;
}

function eventsOf(m: DbMessage): TimelineEvent[] {
  const ordered = (m as { timeline?: unknown }).timeline;
  if (isOrderedTimeline(ordered)) {
    return hydrateToolEvents(ordered, (m.tool_calls ?? []) as ToolCall[]);
  }
  // No ordered timeline (a legacy thread, or a message with no blocks): fall
  // back to the shape an assistant message with tool calls is emitted in.
  const out: TimelineEvent[] = [];
  if (m.thinking) out.push({ kind: "thinking", id: `${m.id}-t`, text: m.thinking });
  if (m.content) out.push({ kind: "content", id: `${m.id}-c`, text: m.content });
  for (const tc of m.tool_calls ?? []) {
    out.push({ kind: "tool", id: tc.id, call: tc });
  }
  return out;
}

/** Collapse the flat message list into render turns (assistant runs merged). */
export function buildTurns(messages: DbMessage[]): AgwTurn[] {
  const turns: AgwTurn[] = [];
  // The user message that prompted the current assistant run. An assistant
  // turn's clock starts when the user asked, not when the first token landed —
  // otherwise queueing and model latency vanish from the number.
  let lastUserTs: string | undefined;
  for (const m of messages) {
    if (m.role === "compaction") {
      // Inline compaction marker. `content` is a small JSON of counts +
      // running flag (the summary is never sent to the UI). Renders as its
      // own card and breaks the assistant-merge run so later turns stay split.
      let beforeTokens = 0;
      let afterTokens = 0;
      let running = false;
      try {
        const p = JSON.parse(m.content || "{}");
        beforeTokens = Number(p.beforeTokens) || 0;
        afterTokens = Number(p.afterTokens) || 0;
        running = p.running === true;
      } catch {
        /* malformed marker — render an empty (done) card */
      }
      turns.push({
        id: m.id,
        role: "compaction",
        content: "",
        events: [],
        isThinking: false,
        compaction: { beforeTokens, afterTokens, running },
      });
      continue;
    }
    if (m.role === "notice") {
      // A persisted runtime notice ("this reply is cut off at the output
      // limit"). It describes the assistant turn it follows, so fold it into
      // that turn's events — identical placement to the live path, which
      // appends it to the streaming message's timeline. Only when there is no
      // assistant turn to attach to does it stand alone.
      const host = turns[turns.length - 1];
      if (host && host.role === "assistant") {
        host.events.push({ kind: "notice", id: m.id, text: m.content || "" });
      }
      // No assistant turn to describe (a truncated first turn that never
      // persisted): drop it rather than let it fall through and render as an
      // assistant bubble containing product copy.
      continue;
    }
    if (m.role === "user") {
      lastUserTs = m.timestamp;
      turns.push({
        id: m.id,
        role: "user",
        content: m.content || "",
        events: [],
        isThinking: false,
        attachedSelectedElements: m.attachedSelectedElements ?? null,
        attachedCommands: m.attachedCommands ?? null,
        attachedPromptChips: m.attachedPromptChips ?? null,
      });
      continue;
    }
    const prev = turns[turns.length - 1];
    if (prev && prev.role === "assistant") {
      if (m.content) {
        prev.content = prev.content ? `${prev.content}\n\n${m.content}` : m.content;
      }
      prev.events.push(...eventsOf(m));
      prev.isThinking = m.isThinking ?? prev.isThinking;
      // Consecutive assistant messages are one turn, so the clock runs to the
      // LAST of them rather than stopping at the first reply.
      if (m.timestamp) prev.endedAt = m.timestamp;
    } else {
      turns.push({
        id: m.id,
        role: "assistant",
        content: m.content || "",
        events: eventsOf(m),
        isThinking: !!m.isThinking,
        startedAt: lastUserTs,
        endedAt: m.timestamp,
      });
    }
  }
  return turns;
}

/** Group consecutive tool events into one row; text/thinking break the run. */
/**
 * Tool calls that render NOTHING in the transcript.
 *
 * Only `todo` with `op: "read"`. A read changes nothing — it is the agent
 * looking up where it stands — so a row for it is pure noise in a reply.
 * Set and update DO render (as a one-line beat): they are events, and a
 * checklist that changes with no trace in the transcript reads as if nothing
 * happened. It also made a FAILED todo call invisible, which is how a broken
 * checklist went unnoticed.
 *
 * The bar for adding a case here is high: the call must change nothing a
 * reader could care about. Silence is otherwise indistinguishable from a tool
 * that failed to run.
 */
function isSilentToolCall(call: ToolCall): boolean {
  if (call.name !== "todo") return false;
  try {
    return (JSON.parse(call.arguments || "{}") as { op?: unknown }).op === "read";
  } catch {
    // Arguments still streaming or malformed — show it. An unreadable call is
    // exactly the one worth seeing.
    return false;
  }
}

/**
 * `chapter` is not a tool card — it is the agent naming the part of the work it
 * is starting, and it renders as a heading at the exact point it was called.
 *
 * Nothing else in the transcript needs to know: the call already sits at its own
 * index in the event list, so it lands in the right place live AND after a
 * reload, with no state of its own.
 */
const CHAPTER_TOOL_NAME = "chapter";

/**
 * The title of a `chapter` call, or `null` while it is unreadable.
 *
 * Read with the streaming-aware argument reader rather than `JSON.parse`, so the
 * heading types in as the model writes it. Parsing would fail on every partial
 * frame, and the call would flash as a tool card before becoming a heading.
 */
function chapterTitleOf(call: ToolCall): string | null {
  const [first] = streamedToolStringArguments(call.arguments || "", ["title"]).title ?? [];
  const title = first?.value.trim();
  return title ? title : null;
}

/**
 * Did the runtime REJECT this chapter (blank or over-long title)?
 *
 * `isActivelyStreaming: true` here means "no result yet is pending, not failed":
 * a chapter that has been announced but not yet acknowledged must still show as
 * a heading. Only an explicit error result disqualifies it — and then it falls
 * through to a normal tool card, because a rejected chapter is a heading the
 * user never got, and hiding the failure would leave nothing to notice.
 */
function chapterWasRejected(call: ToolCall): boolean {
  return toolStatus(call, true) === "failed";
}

export function buildRows(events: TimelineEvent[]): TimelineRow[] {
  const rows: TimelineRow[] = [];
  let run: ToolCall[] = [];
  let runStart = "";

  const flush = () => {
    if (run.length > 0) {
      rows.push({ type: "tools", id: `tools-${runStart}`, tools: run });
      run = [];
      runStart = "";
    }
  };

  for (const e of events) {
    if (e.kind === "tool") {
      // Dropped WITHOUT flushing the run, so a silent call sandwiched between
      // two file edits does not split them into two separate groups.
      if (isSilentToolCall(e.call)) continue;
      if (e.call.name === CHAPTER_TOOL_NAME && !chapterWasRejected(e.call)) {
        const title = chapterTitleOf(e.call);
        // Title still on the wire — skip rather than open a blank heading. It
        // lands at this same position as soon as the first characters arrive.
        if (!title) continue;
        flush();
        rows.push({ type: "chapter", id: e.id, title });
        continue;
      }
      if (run.length === 0) runStart = e.id;
      run.push(e.call);
    } else {
      flush();
      if (e.kind === "thinking") {
        rows.push({ type: "thinking", id: e.id, text: e.text });
      } else if (e.kind === "user_injection") {
        rows.push({ type: "user_injection", id: e.id, text: e.text });
      } else if (e.kind === "notice") {
        rows.push({ type: "notice", id: e.id, text: e.text });
      } else if (e.kind === "compaction") {
        rows.push({
          type: "compaction",
          id: e.id,
          beforeTokens: e.beforeTokens,
          afterTokens: e.afterTokens,
          running: e.running,
        });
      } else {
        rows.push({ type: "content", id: e.id, text: e.text });
      }
    }
  }
  flush();
  return rows;
}
