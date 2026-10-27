/**
 * Agent Window — work card: which rows of a turn are work, and which are the
 * answer [pure].
 *
 * Transcript → Work cards. One card per turn. It holds every row from the start
 * of the turn to the turn's LAST thought, tool run or chapter; whatever comes
 * after that is below the card.
 *
 * The rule reads the order of the rows and nothing else — no text length, no
 * blank lines, no "is this the live edge", no streaming flag:
 *
 *   - text the model wrote and then kept working after is narration, so it is
 *     inside the card;
 *   - text after the last piece of work sits below the card. While the turn
 *     runs it is the model's newest words; if another step follows, it moves
 *     into the card at that moment; once the turn ends it is the answer.
 *
 * Rows are only ever appended to a turn, so the card's end only moves DOWN: a
 * row that is inside the card is inside for good. The card that rebuilt this
 * (`WorkCard` + `work-stretches`, 2026-10-12 → 10-24) re-decided membership
 * on every render from text length and position, and every one of its flips —
 * text lifting out and being pulled back, "Worked" ↔ "Working", the card
 * forming at step 3 — came from a row changing sides. Nothing here can.
 *
 * Every call is work here, `present_artifact` and `plan_write` included: with
 * work cards on, an artifact is inside the card like any other step (Alvan,
 * 2026-10-25).
 *
 * A reloaded turn splits the same way a live one ended, because the rule only
 * needs the rows.
 */

import type { TimelineRow } from "@/apps/agent/components/conversation/timeline";

/** One row with its position in the turn's flat row list. */
export interface IndexedRow {
  row: TimelineRow;
  index: number;
}

/** Counts and clock for the card's header. */
export interface WorkTally {
  thoughts: number;
  calls: number;
  reads: number;
  commands: number;
  /** Earliest known time of any step (epoch ms). */
  startedAt?: number;
  /** Latest known time of any step (epoch ms). */
  endedAt?: number;
  /**
   * The first tool call's id, as the model sent it — the one id the live
   * stream and the saved conversation agree on, so the card's open state
   * survives a reopen. `null` until a call has arrived.
   */
  firstCallId: string | null;
}

export interface SplitTurn {
  /** Rows that opened the turn for someone else (a sub-agent's report, a
   *  background process ending), drawn above the card. */
  before: IndexedRow[];
  /** The card's rows; empty when the turn has no work (no card). */
  work: IndexedRow[];
  /** Rows below the card: the newest words while it runs, the answer after. */
  after: IndexedRow[];
  tally: WorkTally;
}

const READ_TOOLS = new Set(["file_read"]);
const COMMAND_TOOLS = new Set(["shell_execute", "shell_spawn"]);

/** A thought, a tool run, or a chapter: the agent working. */
export function isWorkRow(row: TimelineRow): boolean {
  return row.type === "thinking" || row.type === "tools" || row.type === "chapter";
}

/** Rows that open a turn someone other than the user started. */
function isOpenerRow(row: TimelineRow): boolean {
  return row.type === "agent_report" || row.type === "process_beat";
}

export function tallyWork(items: readonly IndexedRow[]): WorkTally {
  const tally: WorkTally = { thoughts: 0, calls: 0, reads: 0, commands: 0, firstCallId: null };
  const seen = (start?: number, end?: number) => {
    if (typeof start === "number" && Number.isFinite(start)) {
      tally.startedAt = tally.startedAt === undefined ? start : Math.min(tally.startedAt, start);
      tally.endedAt = tally.endedAt === undefined ? start : Math.max(tally.endedAt, start);
    }
    if (typeof end === "number" && Number.isFinite(end)) {
      tally.endedAt = tally.endedAt === undefined ? end : Math.max(tally.endedAt, end);
    }
  };
  for (const { row } of items) {
    if (row.type === "thinking") {
      tally.thoughts += 1;
      seen(
        row.startedAt,
        row.startedAt !== undefined && row.durationMs !== undefined ? row.startedAt + row.durationMs : undefined,
      );
    } else if (row.type === "tools") {
      for (const call of row.tools) {
        tally.calls += 1;
        tally.firstCallId ??= call.id;
        if (READ_TOOLS.has(call.name)) tally.reads += 1;
        if (COMMAND_TOOLS.has(call.name)) tally.commands += 1;
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
  return tally;
}

export function splitTurn(rows: readonly TimelineRow[]): SplitTurn {
  let lastWork = -1;
  for (let index = 0; index < rows.length; index += 1) {
    if (isWorkRow(rows[index])) lastWork = index;
  }
  const indexed = (from: number, to: number): IndexedRow[] => {
    const out: IndexedRow[] = [];
    for (let index = from; index < to; index += 1) out.push({ row: rows[index], index });
    return out;
  };
  if (lastWork < 0) {
    return { before: [], work: [], after: indexed(0, rows.length), tally: tallyWork([]) };
  }
  let start = 0;
  while (start < lastWork && isOpenerRow(rows[start])) start += 1;
  const work = indexed(start, lastWork + 1);
  return {
    before: indexed(0, start),
    work,
    after: indexed(lastWork + 1, rows.length),
    tally: tallyWork(work),
  };
}
