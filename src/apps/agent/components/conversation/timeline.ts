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
} from "@/apps/agent/services/threads/thread-service";
import { streamedToolStringArguments, toolStatus, type ToolCall } from "@/apps/agent/components/tools/tool-call";

/**
 * Group a run of tool calls when there are at least this many.
 *
 * Three, not the IDE's six. Six was chosen when a run of that length meant the
 * model had explicitly batched — but models routinely spend a whole assistant
 * message on three or four reads, which is a wall of near-identical cards that
 * says "four files" far less clearly than one line naming them does. The
 * threshold is the answer to "how many rows before the shape stops being
 * readable", and that number is smaller than six.
 *
 * Counted in ROWS, not calls (`ToolGroup`): a run of consecutive checklist
 * calls is one row however many calls it holds, so closing two tasks and
 * starting a third — three calls, one line — never gets a header asking the
 * reader what the other two were.
 */
export const TOOL_GROUP_MIN = 3;

export type CompactionStatus = "running" | "completed" | "failed" | "cancelled";

export type TimelineEvent =
  /**
   * A reasoning segment. `startedAt` (epoch ms) exists only on a LIVE segment
   * — it drives the ticking clock while the model is still reasoning, and is
   * unknowable for a turn rebuilt from disk. `durationMs` is the settled
   * answer and is authoritative on BOTH paths: the live appender derives it
   * from its own clock, the reload path reads it off the persisted block.
   * Absent means "not measured" and renders no number, never a zero.
   */
  | { kind: "thinking"; id: string; text: string; startedAt?: number; durationMs?: number }
  | { kind: "content"; id: string; text: string }
  /**
   * `at` (epoch ms) is when this call was first seen. It exists so a `chapter`
   * call can be timed against the NEXT one — a chapter's duration is not a
   * property of its own call (which returns instantly), it is the span until
   * the work it names is handed over.
   *
   * Live it comes from the clock; on reload from the owning message's
   * timestamp, which the runtime already persists. So the number survives a
   * reopened chat exactly like the reasoning duration does, with nothing extra
   * written to disk.
   */
  | { kind: "tool"; id: string; call: ToolCall; at?: number }
  | { kind: "user_injection"; id: string; text: string; chips?: AttachedPromptChip[] | null }
  /** A background process ended (or was stopped) mid-turn. Nobody's words. */
  | { kind: "process_beat"; id: string; text: string }
  /**
   * `startedAt`/`durationMs` exist because compaction is the one thing in the
   * transcript that can run for minutes with nothing to show. Measured
   * 2026-08-27: a 257k-token summary took 3m 22s behind an identical shimmer,
   * and the only way to tell it apart from a hang was to read the session file.
   * Live-only — neither is persisted, so a reopened chat shows the drop alone.
   */
  | {
      kind: "compaction";
      id: string;
      beforeTokens: number;
      afterTokens: number;
      status: CompactionStatus;
      reason?: string;
      startedAt?: number;
      durationMs?: number;
    }
  | { kind: "notice"; id: string; text: string }
  /**
   * The connection died mid-reply and the runtime is re-requesting it.
   * Deliberately transient: it is removed the moment the retry streams
   * anything, and it is never persisted — a recovered hiccup should leave no
   * trace, because nothing actually happened to the conversation.
   *
   * `attempt` is the try that FAILED (1-based), so the one now running is
   * `attempt + 1`.
   */
  | { kind: "reconnect"; id: string; attempt: number; maxAttempts: number }
  /**
   * A picture made DIRECTLY — the conversation's model is an image model, so
   * the reply is the picture and nothing else. `pending` is the live hole the
   * silk placeholder fills at the requested aspect; `ready` carries the stored
   * asset (the reload path emits this from a persisted `ContentBlock::Image`);
   * `failed` keeps the hole's shape and says why. Model-CALLED pictures are
   * not this — they are tool calls, and render as tool cards.
   */
  | DirectImageEvent;

export interface DirectImageEvent {
  kind: "image";
  id: string;
  status: "pending" | "ready" | "failed";
  /** Reserved shape while pending; the real one once ready. */
  width: number;
  height: number;
  prompt?: string | null;
  model?: string | null;
  /** Set once `ready`. */
  asset?: string;
  path?: string;
  mediaType?: string;
  artifactId?: string | null;
  /** Set once `failed`. */
  error?: string;
}

export type TimelineRow =
  | { type: "thinking"; id: string; text: string; startedAt?: number; durationMs?: number }
  | { type: "content"; id: string; text: string }
  | { type: "tools"; id: string; tools: ToolCall[] }
  | { type: "user_injection"; id: string; text: string; chips?: AttachedPromptChip[] | null }
  | { type: "process_beat"; id: string; text: string }
  | {
      type: "compaction";
      id: string;
      beforeTokens: number;
      afterTokens: number;
      status: CompactionStatus;
      reason?: string;
      startedAt?: number;
      durationMs?: number;
    }
  | { type: "notice"; id: string; text: string }
  | { type: "reconnect"; id: string; attempt: number; maxAttempts: number }
  | { type: "image"; id: string; image: DirectImageEvent }
  /** A `chapter` call — the agent naming the part of the work it is starting.
   *  `at` is when it was announced; the span it covers is closed by the next
   *  chapter, or by the end of the turn. */
  | { type: "chapter"; id: string; title: string; at?: number };

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
  compaction?: {
    beforeTokens: number;
    afterTokens: number;
    status: CompactionStatus;
    reason?: string;
    startedAt?: number;
    durationMs?: number;
  };
  /**
   * Assistant only — when the work started, i.e. the timestamp of the user
   * message that prompted this turn. Paired with {@link AgwTurn.endedAt} it
   * gives the wall-clock the agent spent on this turn.
   */
  startedAt?: string;
  /** Assistant only — timestamp of the last message merged into this turn. */
  endedAt?: string;
  /**
   * Assistant only — what opened this turn. A person's message, or a
   * background process ending while the conversation was idle. Retry needs
   * to know: there are no typed words to send again for a process-started
   * turn.
   */
  startedBy?: "user" | "process";
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
 * Compact duration label: `0.4s`, `12s`, `4m 14s`, `1h 4m`.
 *
 * Precision is proportional to magnitude — one step of detail, never two.
 * Under a second the tenth is the number; under a minute the second is; past a
 * minute the second becomes the remainder (`4m 14s`), which is the resolution
 * a reader actually compares reasoning passes at. Past an hour seconds are
 * noise and the remainder becomes minutes instead.
 *
 * Sub-second spans state the measurement (`0.4s`) rather than bounding it.
 * `<1s` was the honest answer while these numbers were whole seconds, but a
 * reasoning block emits many short segments and a column of identical `<1s`
 * hedges says less than the tenths do — and the value IS measured, so there is
 * nothing to hedge about.
 *
 * The one remaining bound is a span too short to attribute: a segment whose
 * first and last token landed in the same tick renders `<0.1s`, never `0s`.
 * Work that happened should never claim it took no time. A whole-minute span
 * drops the `0s` for the same reason `2h` drops `0m`: a zero remainder is not
 * information.
 */
export function formatWorkedDuration(ms: number): string {
  if (ms < 50) return "<0.1s";
  if (ms < 1000) return `${(ms / 1000).toFixed(1)}s`;
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) {
    const seconds = totalSeconds % 60;
    return seconds > 0 ? `${totalMinutes}m ${seconds}s` : `${totalMinutes}m`;
  }
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
}

/**
 * The live event counter lives on `globalThis`, not in a module binding.
 *
 * A module binding restarts at zero every time this file is re-evaluated,
 * and in dev that is every hot reload — while the open conversation still
 * holds `ev1…evN` from before. The next turn then minted the same ids again,
 * React saw duplicate keys and dropped rows, and the transcript stopped
 * updating mid-stream for a reason nowhere near the code being edited.
 */
const SEQ_KEY = "__agwTimelineEventSeq";
/** Monotonic id for freshly-created timeline segments (stable across appends). */
export function nextEventId(): string {
  const scope = globalThis as unknown as Record<string, unknown>;
  const current = typeof scope[SEQ_KEY] === "number" ? (scope[SEQ_KEY] as number) : 0;
  const next = current + 1;
  scope[SEQ_KEY] = next;
  return `ev${next}`;
}

// ── Live updaters (used by the send hook) ────────────────────────────

/**
 * Append a reasoning delta, extending the segment's clock.
 *
 * The span is first token → last token. Nothing signals "reasoning ended" —
 * the segment simply stops being appended to when content or a tool arrives —
 * so the duration has to be re-derived on every delta rather than stamped by
 * an end event that does not exist.
 *
 * `now` is injected so the span is testable without a fake clock.
 */
export function appendThinking(
  tl: TimelineEvent[],
  text: string,
  now: number = Date.now(),
): TimelineEvent[] {
  const last = tl[tl.length - 1];
  if (last && last.kind === "thinking") {
    // Only extend a segment that knows when it started. A segment rehydrated
    // from disk carries a duration but no start, and recomputing from `now`
    // would restate an hours-old reasoning pass as however long the window
    // has been open.
    const durationMs =
      last.startedAt !== undefined ? Math.max(0, now - last.startedAt) : last.durationMs;
    return [...tl.slice(0, -1), { ...last, text: last.text + text, durationMs }];
  }
  return [...tl, { kind: "thinking", id: nextEventId(), text, startedAt: now, durationMs: 0 }];
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
export function appendUserInjection(
  tl: TimelineEvent[],
  text: string,
  chips?: AttachedPromptChip[] | null,
): TimelineEvent[] {
  return [
    ...tl,
    {
      kind: "user_injection",
      id: nextEventId(),
      text,
      ...(chips && chips.length > 0 ? { chips } : {}),
    },
  ];
}

/**
 * Append a background-process beat — a process ended, or someone stopped it,
 * while the turn was running.
 *
 * Deliberately NOT a `user_injection`, which is what this used to be: the same
 * queue slot carries both, so a stopped process arrived as "The user stopped
 * the background process…" inside the user's own row, tooltipped "You added
 * this mid-turn". Nobody said it. It renders in the checklist beat's shape
 * instead — one quiet line naming what happened to what.
 */
export function appendProcessBeat(tl: TimelineEvent[], text: string): TimelineEvent[] {
  return [...tl, { kind: "process_beat", id: nextEventId(), text }];
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
  return [
    ...tl,
    {
      kind: "compaction",
      id,
      beforeTokens: 0,
      afterTokens: 0,
      status: "running",
      // Stamped here rather than in the card, so the clock survives the card
      // unmounting and remounting — which is exactly what happens when someone
      // leaves for Settings to check whether the thing has hung.
      startedAt: Date.now(),
    },
  ];
}

/** Settle a live compaction exactly once with an explicit terminal status. */
export function finishCompaction(
  tl: TimelineEvent[],
  id: string,
  result: {
    status: Exclude<CompactionStatus, "running">;
    beforeTokens: number;
    afterTokens?: number;
    reason?: string;
  },
): TimelineEvent[] {
  return tl.map((e) =>
    e.kind === "compaction" && e.id === id
      ? {
          kind: "compaction",
          id,
          beforeTokens: result.beforeTokens,
          afterTokens: result.status === "completed" ? (result.afterTokens ?? 0) : 0,
          status: result.status,
          reason: result.reason,
          startedAt: e.startedAt,
          // Kept after the fact: how long a compaction took is the number that
          // says whether the next one is worth pinning a cheaper summarizer for.
          durationMs: e.startedAt ? Date.now() - e.startedAt : undefined,
        }
      : e,
  );
}

/**
 * The stream died mid-reply: throw away the half of it that reached the screen
 * and mark the gap with a live "reconnecting" row.
 *
 * Restore the snapshot captured by StreamAttemptStarted before any output
 * arrived. The retry regenerates one model call, so all earlier replies and
 * completed tools must survive exactly, even when adjacent text rows merged.
 * Older producers without attempt events use the trailing-row fallback.
 *
 * The session on disk is already right when this is called: the runtime
 * appends an assistant message only after a clean stream, so the fragment was
 * never persisted. This function exists to bring the SCREEN back in line with
 * a history that never had it.
 */
export function beginReconnect(
  tl: TimelineEvent[],
  id: string,
  attempt: number,
  maxAttempts: number,
  committed?: TimelineEvent[],
): TimelineEvent[] {
  // Live runtime supplies the exact pre-attempt snapshot. Consecutive text
  // can merge across message boundaries, so a trailing-row scan cannot safely
  // recover this boundary. Keep the scan only for older event producers.
  if (committed) {
    return [...clearReconnect(committed), { kind: "reconnect", id, attempt, maxAttempts }];
  }
  let end = tl.length;
  while (end > 0) {
    const e = tl[end - 1];
    const isPartial =
      e.kind === "thinking" ||
      e.kind === "content" ||
      // A tool whose arguments never finished streaming. The retry gets a new
      // call id from the provider, so leaving this would strand a dead card.
      (e.kind === "tool" && e.call.result == null) ||
      // A stale marker from an earlier attempt in the same run of retries.
      e.kind === "reconnect";
    if (!isPartial) break;
    end -= 1;
  }
  return [...tl.slice(0, end), { kind: "reconnect", id, attempt, maxAttempts }];
}

/**
 * Take the reconnect marker away — the retry is streaming, or the turn ended.
 *
 * Called on the first sign of life from the new attempt, so a recovered
 * connection reads as nothing having happened at all.
 */
export function clearReconnect(tl: TimelineEvent[]): TimelineEvent[] {
  return tl.some((e) => e.kind === "reconnect")
    ? tl.filter((e) => e.kind !== "reconnect")
    : tl;
}

/**
 * Re-derive the flat `content` / `thinking` string a message carries alongside
 * its timeline.
 *
 * The two are appended in lockstep while streaming, so they normally agree
 * without anyone reconstructing anything. {@link beginReconnect} is the one
 * place that REMOVES timeline events, and a flat string cannot be un-appended
 * — so it is rebuilt from what survived. Skip this and the discarded fragment
 * lives on invisibly: absent from the transcript, present in Copy and in the
 * reload fallback.
 *
 * Exact by construction: the appenders merge consecutive segments of a kind
 * and store the text verbatim, so joining them returns the original string.
 */
export function textOf(tl: TimelineEvent[], kind: "content" | "thinking"): string {
  let out = "";
  for (const e of tl) if (e.kind === kind) out += e.text;
  return out;
}

/**
 * Replace the direct-image event `id` in place. The hole the placeholder
 * reserved is the same row the picture lands in, which is what makes the
 * arrival a crossfade and not a layout jump.
 */
export function settleImageEvent(
  tl: TimelineEvent[],
  id: string,
  patch: (event: DirectImageEvent) => DirectImageEvent,
): TimelineEvent[] {
  return tl.map((e) => (e.kind === "image" && e.id === id ? patch(e) : e));
}

export function upsertToolEvent(tl: TimelineEvent[], call: ToolCall): TimelineEvent[] {
  const idx = tl.findIndex((e) => e.kind === "tool" && e.id === call.id);
  if (idx >= 0) {
    const next = [...tl];
    const prev = next[idx] as { at?: number };
    // Keep the FIRST sighting. This runs again on every argument delta and once
    // more when the result lands; re-stamping would move a chapter's start to
    // the moment its own row stopped changing, and shorten every span by it.
    next[idx] = { kind: "tool", id: call.id, call, at: prev.at ?? Date.now() };
    return next;
  }
  return [...tl, { kind: "tool", id: call.id, call, at: Date.now() }];
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
  /** Owning message's timestamp — the reload path's clock for tool events. */
  at?: number,
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
    if (call) out.push({ kind: "tool", id: e.id, call, at });
  }
  return out;
}

function eventsOf(m: DbMessage): TimelineEvent[] {
  // Every event in one assistant message shares that message's clock. That is
  // the right granularity for chapters: the agent must run tools between two
  // chapters, and each tool round is its own message, so consecutive chapters
  // never collapse onto a single timestamp.
  const at = m.timestamp ? Date.parse(m.timestamp) : NaN;
  const messageAt = Number.isFinite(at) ? at : undefined;
  const ordered = (m as { timeline?: unknown }).timeline;
  if (isOrderedTimeline(ordered)) {
    return hydrateToolEvents(ordered, (m.tool_calls ?? []) as ToolCall[], messageAt);
  }
  // No ordered timeline (a legacy thread, or a message with no blocks): fall
  // back to the shape an assistant message with tool calls is emitted in.
  const out: TimelineEvent[] = [];
  if (m.thinking) out.push({ kind: "thinking", id: `${m.id}-t`, text: m.thinking });
  if (m.content) out.push({ kind: "content", id: `${m.id}-c`, text: m.content });
  for (const tc of m.tool_calls ?? []) {
    out.push({ kind: "tool", id: tc.id, call: tc, at: messageAt });
  }
  return out;
}

/**
 * A finite positive number out of untyped JSON, or `undefined`.
 *
 * Zero counts as absent on purpose: every field read through this is a clock
 * reading, and an epoch of 0 or a duration of 0 is a field that was never
 * filled in, not a compaction that took no time.
 */
function positiveNumber(raw: unknown): number | undefined {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
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
      let status: CompactionStatus = "completed";
      let reason: string | undefined;
      let startedAt: number | undefined;
      let durationMs: number | undefined;
      try {
        const p = JSON.parse(m.content || "{}");
        beforeTokens = Number(p.beforeTokens) || 0;
        afterTokens = Number(p.afterTokens) || 0;
        // `running` belongs in this list. Leaving it out is what made a manual
        // `/compact` render its FINISHED card the instant it started: the
        // marker says `status: "running"`, that fell past every arm to the
        // legacy `p.running` boolean nothing writes any more, and landed on
        // "completed" — no shimmer, no clock, and (with both counts still
        // zero) the bare words "Context compacted" over a summary that had not
        // been written yet. Automatic mid-turn compaction never showed it
        // because that path builds its marker as a timeline event and never
        // passes through here.
        status =
          p.status === "running" ||
          p.status === "failed" ||
          p.status === "cancelled" ||
          p.status === "completed"
            ? p.status
            : p.running === true
              ? "running"
              : "completed";
        reason = typeof p.reason === "string" ? p.reason : undefined;
        // The live clock, and what it settled to. Both optional: a marker
        // restored from the session file has neither, and the card draws no
        // number rather than a guessed one.
        startedAt = positiveNumber(p.startedAt);
        durationMs = positiveNumber(p.durationMs);
      } catch {
        /* malformed marker — render an empty (done) card */
      }
      turns.push({
        id: m.id,
        role: "compaction",
        content: "",
        events: [],
        isThinking: false,
        compaction: { beforeTokens, afterTokens, status, reason, startedAt, durationMs },
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
    if (m.role === "process") {
      // A background process ended while the conversation was idle, and that
      // ending started this turn. Nobody typed anything, so there is no user
      // bubble: the turn opens as a fresh AURORA turn whose first row is the
      // beat — the same one-line "Finished pnpm test · exit 1" a mid-turn
      // ending draws — and the reply streams in beneath it.
      //
      // Pushed as a NEW turn, never merged into the reply before it. That
      // boundary is the whole point: without it the reply folded into the
      // previous, already-settled bubble and nothing new appeared on screen
      // while the model was answering. The message id is the beat's row id;
      // it never collides with the `ev…` ids the stream mints.
      lastUserTs = m.timestamp;
      turns.push({
        id: m.id,
        role: "assistant",
        content: "",
        events: [{ kind: "process_beat", id: m.id, text: m.content || "" }],
        isThinking: false,
        startedAt: m.timestamp,
        endedAt: m.timestamp,
        startedBy: "process",
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
        startedBy: "user",
      });
    }
  }
  return turns;
}

/** Group consecutive tool events into one row; text/thinking break the run. */
/**
 * Tool calls that render NOTHING in the transcript.
 *
 * Only `TaskList`. Reading the checklist changes nothing — it is the agent
 * looking up where it stands — so a row for it is pure noise in a reply.
 * `TaskCreate` and `TaskUpdate` DO render (as a one-line beat): they are
 * events, and a checklist that changes with no trace in the transcript reads
 * as if nothing happened. It also made a FAILED checklist call invisible,
 * which is how a broken checklist went unnoticed.
 *
 * Matched by name alone now that the three jobs have three names — the old
 * single `todo` tool needed its arguments parsed to tell a read from a write,
 * which meant a half-streamed call could not be judged at all.
 *
 * The bar for adding a case here is high: the call must change nothing a
 * reader could care about. Silence is otherwise indistinguishable from a tool
 * that failed to run.
 */
function isSilentToolCall(call: ToolCall): boolean {
  return call.name === "TaskList";
}

/**
 * True when an assistant text block says nothing a reader could act on.
 *
 * Whitespace was the original case: models routinely separate batched tool
 * calls with a bare `"\n"`. But filler is not always blank — a single Opus
 * thread emitted fifteen text blocks whose entire content was `"..."`, one
 * between each pair of tool cards, and the transcript wore a column of stray
 * dots down its left edge.
 *
 * Kept deliberately narrow: only whitespace and the characters filler is
 * actually made of. A block with ANY word, digit or punctuation beyond these is
 * speech and renders as written — dropping real text because it looked short is
 * far worse than showing a row of dots.
 */
function isSilentContent(text: string): boolean {
  return text.replace(/[\s.…\-–—_*]/g, "") === "";
}

/**
 * A line that is nothing but dots — `...`, `…`, `. . .`.
 *
 * Narrower than [`isSilentContent`] on purpose. That one judges a whole block,
 * where a lone `---` is filler; this one judges lines INSIDE a block, where
 * `---` is a horizontal rule and `***` is emphasis, and deleting either would
 * damage real prose.
 */
const DOTS_ONLY_LINE = /^[.\s]*[.…][.…\s]*$/;

/**
 * Drop dots-only lines from the START and END of a content block.
 *
 * `isSilentContent` catches a block that is ONLY filler, and that was enough
 * while models emitted their `...` as a block of its own. They do not: content
 * deltas are merged by `appendContent`, so a model that narrates and then emits
 * a separator produces ONE block reading `"Let me read the wiring files.\n\n..."`.
 * That block has real words in it, passes the silence check as it should, and
 * the markdown renderer then draws the trailing dots as their own paragraph —
 * a stray `...` under the sentence, above the tool card it was separating.
 *
 * Only the ends are trimmed. A dots line in the MIDDLE of a block can be
 * elided code inside a fence (```` ``` ````…`...`…```` ``` ````) or the author's
 * own ellipsis, and neither is ours to remove; a separator, by definition, sits
 * at an edge.
 */
function trimFillerEdges(text: string): string {
  const lines = text.split("\n");
  let start = 0;
  let end = lines.length;
  while (start < end && (lines[start].trim() === "" || DOTS_ONLY_LINE.test(lines[start]))) {
    start += 1;
  }
  while (end > start && (lines[end - 1].trim() === "" || DOTS_ONLY_LINE.test(lines[end - 1]))) {
    end -= 1;
  }
  return lines.slice(start, end).join("\n");
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
/**
 * Longest chapter title the transcript draws.
 *
 * PAIRED with `MAX_TITLE_LEN` in `src-tauri/src/tools/transcript/mod.rs`, which
 * shortens the same way and tells the model it did. The duplication is not an
 * oversight: the heading renders from the STREAMED arguments so it appears as
 * the model types it, which is before any tool result exists — so the shortening
 * has to happen here too, and the two have to agree, or the model is told it got
 * a title the user never saw.
 */
export const CHAPTER_TITLE_MAX = 60;

/**
 * Shorten an over-long title the way Rust does: cut at the last word boundary
 * inside the budget, mark the cut with an ellipsis counted against the budget,
 * and hard-cut when honouring the boundary would keep less than half of it.
 *
 * The ellipsis is the reader's half of the bargain. Rust's note is the model's:
 * an over-long title is adjusted rather than refused, so the chapter still lands
 * and nobody sees a failed tool card over a heading that was merely too long.
 */
export function shortenChapterTitle(title: string): string {
  if ([...title].length <= CHAPTER_TITLE_MAX) return title;
  // Code points, not UTF-16 units, so an emoji counts as one character on both
  // sides of the boundary. `.length` here would cut a surrogate pair in half.
  const head = [...title].slice(0, CHAPTER_TITLE_MAX - 1).join("");
  const hard = head.replace(/\s+$/, "");
  // The last whitespace anywhere in the head, matching Rust's
  // `rfind(char::is_whitespace)` rather than approximating it.
  let at = -1;
  for (let i = 0; i < head.length; i += 1) {
    if (/\s/.test(head.charAt(i))) at = i;
  }
  const word = at > 0 ? head.slice(0, at).replace(/\s+$/, "") : "";
  const cut = [...word].length >= CHAPTER_TITLE_MAX / 2 ? word : hard;
  return `${cut}…`;
}

function chapterTitleOf(call: ToolCall): string | null {
  const [first] = streamedToolStringArguments(call.arguments || "", ["title"]).title ?? [];
  const title = first?.value.trim();
  return title ? shortenChapterTitle(title) : null;
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

/**
 * One collapsible span of a turn: a chapter and everything the agent did under
 * it, up to the next chapter.
 *
 * `rows` carries each row's index in the FLAT row list rather than a local one,
 * because the transcript spine's `data-last` / `data-live` flags describe the
 * turn as a whole — a row that is last inside its chapter is not the last row
 * of the turn, and marking it so would dangle the rail at every chapter break.
 */
export interface TranscriptSection {
  /**
   * The chapter opening this span, or `null` for rows before the first one.
   *
   * `durationMs` is the wall-clock the agent spent under this heading — from
   * its announcement to the next chapter's, or to the end of the turn for the
   * last one. Absent when it cannot be known honestly (no clock on either end,
   * or a still-running final chapter), and absent renders no number rather
   * than a zero.
   */
  chapter: { id: string; title: string; index: number; durationMs?: number } | null;
  rows: { row: TimelineRow; index: number }[];
}

/**
 * Partition a turn's rows into chapter spans.
 *
 * A chapter owns everything after it until the next chapter, which is what lets
 * a finished chapter collapse to its title and take its whole body with it. Rows
 * emitted BEFORE the first chapter belong to no chapter and are never
 * collapsible — the agent had not named that work yet, and hiding it behind a
 * heading it never wrote would attribute it to the wrong thing.
 *
 * A turn with no chapters at all yields exactly one `chapter: null` section, so
 * the caller has a single rendering path either way.
 */
export function buildSections(
  rows: TimelineRow[],
  /**
   * When the turn ended (epoch ms). Closes the LAST chapter's span — without
   * it that chapter has a start and no end, and reports no time. Omit while a
   * turn is still streaming: the final chapter is not finished, and a number
   * that keeps growing under a static heading reads as a stopwatch nobody
   * asked for.
   */
  turnEndedAt?: number,
): TranscriptSection[] {
  const sections: TranscriptSection[] = [];
  let current: TranscriptSection = { chapter: null, rows: [] };

  rows.forEach((row, index) => {
    if (row.type === "chapter") {
      // Drop a leading empty span: a turn that opens on a chapter has nothing
      // before it, and an empty section would render a stray gap.
      if (current.chapter !== null || current.rows.length > 0) sections.push(current);
      current = { chapter: { id: row.id, title: row.title, index }, rows: [] };
      return;
    }
    current.rows.push({ row, index });
  });
  sections.push(current);

  // Close each chapter against the START of the next one — the work under a
  // heading runs until the agent names the next piece. The last chapter closes
  // on the turn's end when we have it.
  const chapters = rows.filter((r): r is Extract<TimelineRow, { type: "chapter" }> =>
    r.type === "chapter",
  );
  let nth = 0;
  for (const section of sections) {
    if (!section.chapter) continue;
    const startedAt = chapters[nth]?.at;
    const endedAt = chapters[nth + 1]?.at ?? turnEndedAt;
    nth += 1;
    if (startedAt === undefined || endedAt === undefined) continue;
    const span = endedAt - startedAt;
    // A negative span means the two clocks disagree (a message written out of
    // order). Report nothing rather than a number that cannot be true.
    if (span >= 0) section.chapter.durationMs = span;
  }

  return sections;
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
        rows.push({ type: "chapter", id: e.id, title, at: e.at });
        continue;
      }
      if (run.length === 0) runStart = e.id;
      run.push(e.call);
    } else {
      // A content segment with no visible text is not speech, and must not
      // break a run of tool calls.
      //
      // Models routinely emit a bare "\n" / "\n\n" text block BETWEEN batched
      // tool calls in one assistant message (verified in session JSONL: five
      // `file_read` calls separated by four newline-only blocks). Each of those
      // became a `content` event, and flushing on it split ONE run of five
      // reads into five single-call rows — so the run never reached
      // `TOOL_GROUP_MIN` and the transcript showed five near-identical rows for
      // what the model did as one batch.
      //
      // Skipped WITHOUT flushing, exactly like a silent tool call: the
      // whitespace also has nothing to render, so emitting a row for it would
      // add an empty markdown block between every pair of cards.
      //
      // `isSilentContent`, not `trim() === ""`, because the filler is not always
      // whitespace: one Opus thread emitted FIFTEEN text blocks whose entire
      // content was "..." between its tool calls, and each one rendered as a
      // stray row of dots down the transcript. A block of nothing but dots,
      // dashes or ellipses is the same non-event as a blank line.
      if (e.kind === "content" && isSilentContent(e.text)) continue;
      flush();
      if (e.kind === "thinking") {
        rows.push({
          type: "thinking",
          id: e.id,
          text: e.text,
          startedAt: e.startedAt,
          durationMs: e.durationMs,
        });
      } else if (e.kind === "user_injection") {
        rows.push({ type: "user_injection", id: e.id, text: e.text, chips: e.chips });
      } else if (e.kind === "process_beat") {
        rows.push({ type: "process_beat", id: e.id, text: e.text });
      } else if (e.kind === "notice") {
        rows.push({ type: "notice", id: e.id, text: e.text });
      } else if (e.kind === "reconnect") {
        rows.push({
          type: "reconnect",
          id: e.id,
          attempt: e.attempt,
          maxAttempts: e.maxAttempts,
        });
      } else if (e.kind === "compaction") {
        rows.push({
          type: "compaction",
          id: e.id,
          beforeTokens: e.beforeTokens,
          afterTokens: e.afterTokens,
          status: e.status,
          reason: e.reason,
          startedAt: e.startedAt,
          durationMs: e.durationMs,
        });
      } else if (e.kind === "image") {
        rows.push({ type: "image", id: e.id, image: e });
      } else {
        rows.push({ type: "content", id: e.id, text: trimFillerEdges(e.text) });
      }
    }
  }
  flush();
  return dedupeRowIds(rows);
}

/**
 * Guarantee the render keys are unique, and say so out loud when they were not.
 *
 * Rows are rendered with `key={row.id}`, and an id only has to be unique inside
 * its own MESSAGE to look correct everywhere it is produced — the live appenders
 * number from one counter, and the reload path numbers per message. `buildTurns`
 * then merges consecutive assistant messages and concatenates their event lists,
 * which is where two ids that were each locally fine can land in one list.
 *
 * When that happened, React dropped children and the transcript stopped
 * updating mid-turn: the reply kept streaming into a view that had quietly
 * stopped rendering it. The failure appeared nowhere near its cause, and the
 * only clue was a key name in a warning.
 *
 * So the keys are made unique HERE, where the list is finally assembled and the
 * invariant actually has to hold. This is a guardrail, not a cure: a repeated id
 * still means something upstream produced the same event twice, so the warning
 * names it and identifies the row, which is what turns the next occurrence into
 * an answer instead of another hunt.
 */
function dedupeRowIds(rows: TimelineRow[]): TimelineRow[] {
  const seen = new Set<string>();
  let duplicates = 0;
  const out = rows.map((row) => {
    if (!seen.has(row.id)) {
      seen.add(row.id);
      return row;
    }
    duplicates += 1;
    let suffix = 2;
    let candidate = `${row.id}#${suffix}`;
    while (seen.has(candidate)) {
      suffix += 1;
      candidate = `${row.id}#${suffix}`;
    }
    seen.add(candidate);
    if (import.meta.env?.DEV) {
      console.warn(
        `[timeline] duplicate row id "${row.id}" (${row.type}) — rendered as ` +
          `"${candidate}". Two events reached one turn with the same id; the ` +
          `transcript is safe, the id source is not.`,
      );
    }
    return { ...row, id: candidate };
  });
  return duplicates > 0 ? out : rows;
}
