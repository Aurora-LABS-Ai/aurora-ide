/**
 * Agent Window — work stretches: where a reply's quiet work begins and ends
 * [pure].
 *
 * Transcript → Work cards folds a reply's work — thoughts, tool calls, and the
 * narration between them — into one card, with the answer below it. Where the
 * card starts and stops is decided HERE, from the kind of each row and nothing
 * else. No text is read or guessed at: a thought is a thought because the
 * model sent a thinking block, and the work ends at the last tool call or
 * thought the model sent. That is what makes the cards the same for every model,
 * live and reloaded, and why no tool asks the model to mark them (Alvan's
 * call, 2026-10-12: structure from the stream, names from chapters when a
 * model gives them).
 *
 * Probe: Documents/aurora-work-card-designs.html, 02.
 */

import type { TimelineRow } from "@/apps/agent/components/conversation/timeline";

/** One row with its position in the turn's flat row list. */
export interface IndexedRow {
  row: TimelineRow;
  index: number;
}

/** A stretch folded into a card. */
export interface WorkStretch {
  kind: "work";
  /**
   * The card's id: the first TOOL CALL id in the stretch, as the model sent
   * it. It is the one id the live stream and the transcript on disk always
   * agree on, so a card opened while it streamed is the same card next week.
   * A stretch without a tool call (rare: thoughts alone) falls back to its
   * first row's id.
   */
  id: string;
  items: IndexedRow[];
  thoughts: number;
  calls: number;
  reads: number;
  commands: number;
  /** Earliest known time in the stretch (epoch ms), when any row carries one. */
  startedAt?: number;
  /** Latest known time in the stretch (epoch ms). */
  endedAt?: number;
}

export type TurnBlock = ({ kind: "row" } & IndexedRow) | WorkStretch;

/** Fewer steps than this stay as ordinary rows: two rows are not worth a card. */
export const MIN_WORK_STEPS = 3;

/**
 * While the turn streams, text after the last step this long or shorter is the
 * model narrating ("Checking the router next.") and stays inside the card;
 * longer, it is the answer starting and lifts out below the card.
 *
 * Length alone decides. A blank line used to count as the answer starting too,
 * so two short sentences with a blank line between them lifted out, the card
 * stopped being live and folded every run, and the next call pulled the text
 * back in and unfolded them (Alvan, 2026-10-24: "folded asap"; probe
 * `Documents/aurora-work-card-click-designs.html`, 06).
 *
 * Measured 2026-10-15 on 222 conversations (1,895 narration texts, 465
 * answers): narration p50 119 chars, p90 237, 97% one paragraph; answers p50
 * 2,204 chars, 11% one paragraph. 300 kept 94% of narration inside; Alvan
 * raised it to 600 on 2026-10-18 after watching GLM narrate past 300 during
 * its tool loop and drop out of the card. The answers under it are greetings
 * on turns with no work, which get no card. Once the turn ends the question is
 * settled without this: trailing text is the answer, whatever its length.
 */
export const NARRATION_MAX_CHARS = 600;

const READ_TOOLS = new Set(["file_read"]);
const COMMAND_TOOLS = new Set(["shell_execute", "shell_spawn"]);

/**
 * Calls whose result IS the reply: an artifact shown to the reader, a plan
 * written for them. A run holding one is the answer arriving, not work, so it
 * ends the card instead of being folded inside it. Without this a reply that
 * ended "Here is the picture." plus a presented diagram folded both behind
 * "Worked 1m 21s" (seen live 2026-10-15).
 */
const DELIVERABLE_TOOLS = new Set(["present_artifact", "plan_write"]);

/** Rows that are the agent working: a thought, a tool run, a chapter. */
function isWorkRow(row: TimelineRow): boolean {
  return row.type === "thinking" || row.type === "tools" || row.type === "chapter";
}

/** A run holding a call whose result is the reply itself. */
function isDeliverableRow(row: TimelineRow): boolean {
  return row.type === "tools" && row.tools.some((call) => DELIVERABLE_TOOLS.has(call.name));
}

/** Text the model writes between steps rather than as the answer. */
export function isNarration(text: string): boolean {
  return text.trim().length <= NARRATION_MAX_CHARS;
}

/** Rows that OPEN a turn someone other than the user started — a sub-agent's
 *  report, a background process ending. They stay above the card, as the
 *  reason the work began. */
function isOpenerRow(row: TimelineRow): boolean {
  return row.type === "agent_report" || row.type === "process_beat";
}

function stretchOf(items: IndexedRow[]): WorkStretch {
  let thoughts = 0;
  let calls = 0;
  let reads = 0;
  let commands = 0;
  let firstCallId: string | null = null;
  let startedAt: number | undefined;
  let endedAt: number | undefined;
  const seen = (start?: number, end?: number) => {
    if (typeof start === "number" && Number.isFinite(start)) {
      startedAt = startedAt === undefined ? start : Math.min(startedAt, start);
      endedAt = endedAt === undefined ? start : Math.max(endedAt, start);
    }
    if (typeof end === "number" && Number.isFinite(end)) {
      endedAt = endedAt === undefined ? end : Math.max(endedAt, end);
    }
  };
  for (const { row } of items) {
    if (row.type === "thinking") {
      thoughts += 1;
      seen(row.startedAt, row.startedAt !== undefined && row.durationMs !== undefined ? row.startedAt + row.durationMs : undefined);
    } else if (row.type === "tools") {
      for (const call of row.tools) {
        calls += 1;
        firstCallId ??= call.id;
        if (READ_TOOLS.has(call.name)) reads += 1;
        if (COMMAND_TOOLS.has(call.name)) commands += 1;
        seen(
          call.startedAt,
          call.startedAt !== undefined && call.durationMs !== undefined ? call.startedAt + call.durationMs : undefined,
        );
      }
      seen(row.at, row.lastAt);
    } else if (row.type === "chapter") {
      seen(row.at);
    }
  }
  return {
    kind: "work",
    id: firstCallId ?? items[0].row.id,
    items,
    thoughts,
    calls,
    reads,
    commands,
    startedAt,
    endedAt,
  };
}

/**
 * The turn's rows as ONE work card and the answer after it.
 *
 * One card per reply, never several. The first build ended a card at any text
 * the model wrote, and a model that narrates between steps ("Redoing it.",
 * "Confirming which matcher fires.") got two or three cards in one reply with
 * loose rows between them — Alvan, 2026-10-12: "two Worked in one turn feels
 * odd". So the card holds everything from the start of the reply to its LAST
 * thought, tool run or chapter, the narration in between included. What comes
 * after that is the answer, and stays below the card. The one exception is an
 * answer-sized text between steps (`answerBoundary`): the card ends before it,
 * and the steps after it follow it as ordinary rows.
 *
 * While the turn streams, short text written after the latest step is the
 * model narrating and stays INSIDE the card (`isNarration`); only text that
 * has grown past narration size lifts out below it as the answer. The first
 * build put every trailing sentence below the card the moment it arrived and
 * pulled it back in at the next call, so a model that narrates each step
 * ("I have what I need. Publishing") flipped the card finished → working on
 * every step, and its window with it (Alvan, 2026-10-15: "entire time it was
 * jumping"). Once the turn is over, trailing text is the answer whatever its
 * length. A sub-agent's report or a background process ending that OPENED the
 * turn stays above the card. A reply with fewer than `minSteps` thoughts plus
 * calls gets no card at all.
 */
/**
 * Index of the turn's last thought, tool run or chapter BEFORE the reply
 * starts, or -1. Everything after it is the answer. The reply starts at the
 * first deliverable run (`DELIVERABLE_TOOLS`): the thought the model has
 * before writing its closing text, and any call after the artifact, are below
 * the card rather than folding the artifact in. Shared with the chapter view,
 * so a bounded chapter and a work card agree on where the answer starts.
 */
export function lastWorkRowIndex(rows: readonly TimelineRow[]): number {
  let last = -1;
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (isDeliverableRow(row)) break;
    if (isWorkRow(row)) last = index;
  }
  return last;
}

export interface WorkStretchOptions {
  /** The turn is still streaming: short trailing text is narration, not the answer. */
  streaming?: boolean;
  minSteps?: number;
}

/**
 * Where the card ends: the last work row, plus — while streaming — the
 * narration the model is writing after it. The content rows after the last
 * step are read as ONE text: all of them stay in while that text is
 * narration, and all of them lift out together once it is not, so an answer
 * is never split across the card's edge.
 */
function stretchEndIndex(rows: readonly TimelineRow[], lastWork: number, streaming: boolean): number {
  if (!streaming) return lastWork;
  let end = lastWork;
  let text = "";
  for (let index = lastWork + 1; index < rows.length; index += 1) {
    const row = rows[index];
    if (row.type !== "content") break;
    text += row.text;
    end = index;
  }
  return isNarration(text) ? end : lastWork;
}

/**
 * The last work row before the first answer-sized text BETWEEN steps, or
 * `lastWork` when every text between steps is narration.
 *
 * Once text has grown past narration size it is the answer, and it stays the
 * answer: steps the model takes after it follow it as ordinary rows instead of
 * pulling it back into the card. Without this, a long text lifted out while it
 * streamed, the card went "Worked" and folded its runs, and the next call put
 * the text back inside and the card back to working. Text only ever grows, so
 * a run that is answer-sized now stays answer-sized, and the boundary never
 * moves back up. It reads the rows alone, so a reloaded turn draws the card
 * the same way the live one did. Text before the first step is the model's
 * opening and stays in the card, as before.
 */
function answerBoundary(rows: readonly TimelineRow[], start: number, lastWork: number): number {
  let lastSeenWork = -1;
  let index = start;
  while (index <= lastWork) {
    const row = rows[index];
    if (isWorkRow(row)) {
      lastSeenWork = index;
      index += 1;
      continue;
    }
    if (row.type === "content" && lastSeenWork >= 0) {
      let text = "";
      let next = index;
      while (next <= lastWork && rows[next].type === "content") {
        text += (rows[next] as Extract<TimelineRow, { type: "content" }>).text;
        next += 1;
      }
      if (!isNarration(text)) return lastSeenWork;
      index = next;
      continue;
    }
    index += 1;
  }
  return lastWork;
}

export function groupWorkStretches(
  rows: readonly TimelineRow[],
  { streaming = false, minSteps = MIN_WORK_STEPS }: WorkStretchOptions = {},
): TurnBlock[] {
  const plain = (): TurnBlock[] => rows.map((row, index) => ({ kind: "row", row, index }));
  const lastWork = lastWorkRowIndex(rows);
  if (lastWork < 0) return plain();

  let start = 0;
  while (start < lastWork && isOpenerRow(rows[start])) start += 1;

  const boundary = answerBoundary(rows, start, lastWork);
  const end = boundary < lastWork ? boundary : stretchEndIndex(rows, lastWork, streaming);
  const items: IndexedRow[] = [];
  for (let index = start; index <= end; index += 1) items.push({ row: rows[index], index });
  const stretch = stretchOf(items);
  if (stretch.thoughts + stretch.calls < minSteps) return plain();

  const blocks: TurnBlock[] = [];
  for (let index = 0; index < start; index += 1) blocks.push({ kind: "row", row: rows[index], index });
  blocks.push(stretch);
  for (let index = end + 1; index < rows.length; index += 1) {
    blocks.push({ kind: "row", row: rows[index], index });
  }
  return blocks;
}
