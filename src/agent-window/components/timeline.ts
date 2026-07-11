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
import type { ToolCall } from "./tool-call";

/** Group a run of tool calls when there are at least this many (matches IDE). */
export const TOOL_GROUP_MIN = 6;

export type TimelineEvent =
  | { kind: "thinking"; id: string; text: string }
  | { kind: "content"; id: string; text: string }
  | { kind: "tool"; id: string; call: ToolCall }
  | { kind: "user_injection"; id: string; text: string }
  | { kind: "compaction"; id: string; beforeTokens: number; afterTokens: number; running: boolean };

export type TimelineRow =
  | { type: "thinking"; id: string; text: string }
  | { type: "content"; id: string; text: string }
  | { type: "tools"; id: string; tools: ToolCall[] }
  | { type: "user_injection"; id: string; text: string }
  | { type: "compaction"; id: string; beforeTokens: number; afterTokens: number; running: boolean };

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

function isLiveTimeline(raw: unknown): raw is TimelineEvent[] {
  return (
    Array.isArray(raw) &&
    raw.length > 0 &&
    raw.every((e) => e && typeof e === "object" && "kind" in (e as object))
  );
}

function eventsOf(m: DbMessage): TimelineEvent[] {
  const live = (m as { timeline?: unknown }).timeline;
  if (isLiveTimeline(live)) return live;
  // Synthesised order: reasoning, then the spoken preamble, then its tools.
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
    if (m.role === "user") {
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
    } else {
      turns.push({
        id: m.id,
        role: "assistant",
        content: m.content || "",
        events: eventsOf(m),
        isThinking: !!m.isThinking,
      });
    }
  }
  return turns;
}

/** Group consecutive tool events into one row; text/thinking break the run. */
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
      if (run.length === 0) runStart = e.id;
      run.push(e.call);
    } else {
      flush();
      if (e.kind === "thinking") {
        rows.push({ type: "thinking", id: e.id, text: e.text });
      } else if (e.kind === "user_injection") {
        rows.push({ type: "user_injection", id: e.id, text: e.text });
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
