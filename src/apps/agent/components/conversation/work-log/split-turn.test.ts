import { describe, expect, it } from "vitest";

import type { TimelineRow } from "@/apps/agent/components/conversation/timeline";
import { splitTurn } from "@/apps/agent/components/conversation/work-log/split-turn";

const text = (id: string, body = "words"): TimelineRow => ({ type: "content", id, text: body });
const thought = (id: string): TimelineRow => ({ type: "thinking", id, text: "hm" });
const tools = (id: string, ...names: string[]): TimelineRow => ({
  type: "tools",
  id,
  tools: names.map((name, i) => ({ id: `${id}-${i}`, name, arguments: "{}" })),
});
const report = (id: string): TimelineRow => ({ type: "process_beat", id, text: "server stopped" });

const ids = (rows: { row: TimelineRow }[]) => rows.map(({ row }) => row.id);

describe("splitTurn", () => {
  it("draws no card for a turn with no work", () => {
    const split = splitTurn([text("a"), text("b")]);
    expect(split.work).toEqual([]);
    expect(ids(split.after)).toEqual(["a", "b"]);
  });

  it("puts narration between steps inside, and the text after the last step below", () => {
    const rows = [text("intro"), tools("t1", "file_read"), text("narrate"), thought("th"), tools("t2", "grep"), text("answer")];
    const split = splitTurn(rows);
    expect(ids(split.work)).toEqual(["intro", "t1", "narrate", "th", "t2"]);
    expect(ids(split.after)).toEqual(["answer"]);
  });

  it("ignores text length and blank lines: a long text between steps is still inside", () => {
    const long = `${"x".repeat(5000)}\n\nsecond paragraph`;
    const split = splitTurn([tools("t1", "file_read"), text("long", long), tools("t2", "grep")]);
    expect(ids(split.work)).toEqual(["t1", "long", "t2"]);
  });

  it("keeps a presented artifact inside the card (Alvan, 2026-10-25)", () => {
    const split = splitTurn([tools("t1", "file_read"), tools("art", "present_artifact"), text("here it is")]);
    expect(ids(split.work)).toEqual(["t1", "art"]);
    expect(ids(split.after)).toEqual(["here it is"]);
  });

  it("leaves an opening report above the card", () => {
    const split = splitTurn([report("beat"), tools("t1", "shell_execute")]);
    expect(ids(split.before)).toEqual(["beat"]);
    expect(ids(split.work)).toEqual(["t1"]);
  });

  it("counts the header's tally and keeps the first call's id as the card id", () => {
    const split = splitTurn([thought("th"), tools("t1", "file_read", "shell_execute"), tools("t2", "file_read")]);
    expect(split.tally).toMatchObject({ thoughts: 1, calls: 3, reads: 2, commands: 1, firstCallId: "t1-0" });
  });

  /**
   * The property the old card broke every week: once a row is inside the card
   * it never leaves, at any point while rows are appended. Checked on a
   * scripted turn and on 300 random ones.
   */
  it("never moves a row out of the card as rows are appended", () => {
    const check = (rows: TimelineRow[]) => {
      let inside = new Set<string>();
      for (let n = 1; n <= rows.length; n += 1) {
        const now = new Set(ids(splitTurn(rows.slice(0, n)).work));
        for (const id of inside) expect(now.has(id), `${id} left the card at row ${n}`).toBe(true);
        inside = now;
      }
    };
    check([text("a"), tools("t1", "grep"), text("b"), text("c"), thought("d"), text("e"), tools("t2", "file_read"), text("f")]);

    let seed = 7;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let turn = 0; turn < 300; turn += 1) {
      const rows: TimelineRow[] = [];
      const length = 1 + Math.floor(rand() * 20);
      for (let i = 0; i < length; i += 1) {
        const pick = rand();
        const id = `r${turn}-${i}`;
        rows.push(pick < 0.4 ? text(id) : pick < 0.6 ? thought(id) : pick < 0.95 ? tools(id, "grep") : report(id));
      }
      check(rows);
    }
  });
});
