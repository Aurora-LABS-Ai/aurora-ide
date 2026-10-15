import { describe, expect, it } from "vitest";

import type { TimelineRow } from "@/apps/agent/components/conversation/timeline";
import {
  groupWorkStretches,
  type WorkStretch,
} from "@/apps/agent/components/conversation/work-stretches";

const think = (id: string, startedAt?: number, durationMs?: number): TimelineRow => ({
  type: "thinking",
  id,
  text: "…",
  startedAt,
  durationMs,
});
const tools = (id: string, ...names: string[]): TimelineRow => ({
  type: "tools",
  id: `tools-${id}`,
  tools: names.map((name, i) => ({ id: `${id}-${i}`, name, arguments: "{}" })),
});
const say = (id: string, text = "Redoing it."): TimelineRow => ({ type: "content", id, text });
const kinds = (rows: TimelineRow[], streaming = false) =>
  groupWorkStretches(rows, { streaming }).map((b) =>
    b.kind === "work" ? `work(${b.items.length})` : b.row.type,
  );

describe("groupWorkStretches — one card per reply", () => {
  it("holds the narration between steps inside the ONE card, the answer below it", () => {
    // The shape that produced two cards and loose rows (2026-10-12): the model
    // narrates between steps, then answers.
    const rows = [
      think("t1"),
      tools("a", "shell_execute"),
      say("n1"),
      tools("b", "shell_execute"),
      think("t2"),
      say("n2"),
      tools("c", "shell_execute", "shell_execute"),
      say("answer"),
    ];
    expect(kinds(rows)).toEqual(["work(7)", "content"]);
    const work = groupWorkStretches(rows)[0] as WorkStretch;
    expect(work).toMatchObject({ thoughts: 2, calls: 4, commands: 4 });
  });

  describe("narration while the turn streams", () => {
    const work = [think("t1"), tools("a", "file_read"), think("t2"), tools("b", "file_read")];

    it("keeps a short sentence after the last call INSIDE the card", () => {
      // Alvan, 2026-10-15: the model said two lines between every step and the
      // card flipped finished → working each time. The sentence is narration.
      const rows = [...work, say("n1", "I have what I need. Publishing")];
      expect(kinds(rows, true)).toEqual(["work(5)"]);
    });

    it("never leaves the card for a model that narrates every step", () => {
      // Replay "call, sentence, call, sentence…" one event at a time: at no
      // point is there a block outside the one card.
      const script = [
        think("t1"),
        tools("a", "shell_execute"),
        say("n1", "Checking the router next."),
        tools("b", "file_read"),
        say("n2", "Now the server boundary."),
        think("t2"),
        tools("c", "grep"),
        say("n3", "One more read and I can summarise."),
      ];
      for (let n = 4; n <= script.length; n += 1) {
        expect(kinds(script.slice(0, n), true)).toEqual([`work(${n})`]);
      }
    });

    it("lifts text out once it has grown past narration size", () => {
      const long = "The workspace is a Vite app with one main process. ".repeat(8);
      expect(kinds([...work, say("a1", long)], true)).toEqual(["work(4)", "content"]);
    });

    it("lifts text out at a second paragraph, however short", () => {
      expect(kinds([...work, say("a1", "Here is the picture.\n\nThree layers.")], true)).toEqual([
        "work(4)",
        "content",
      ]);
    });

    it("reads several content rows as one growing text", () => {
      const half = "x".repeat(200);
      expect(kinds([...work, say("a1", half), say("a2", half)], true)).toEqual(["work(4)", "content", "content"]);
    });

    it("treats trailing text as the answer once the turn is over, whatever its length", () => {
      expect(kinds([...work, say("a1", "Done.")], false)).toEqual(["work(4)", "content"]);
    });
  });

  it("ends the card before a presented artifact or written plan: that run is the answer", () => {
    // Seen live 2026-10-15: "Here is the picture." plus the diagram were folded
    // behind "Worked 1m 21s".
    const rows = [
      think("t1"),
      tools("a", "file_read", "file_read"),
      think("t2"),
      say("intro", "Read the whole tree. Here is the picture."),
      tools("art", "present_artifact"),
      think("t3"),
    ];
    expect(kinds(rows)).toEqual(["work(3)", "content", "tools", "thinking"]);
    // The written plan sits below the card, never inside it.
    expect(kinds([think("t1"), tools("a", "file_read", "file_read"), tools("p", "plan_write")])).toEqual([
      "work(2)",
      "tools",
    ]);
  });

  it("keeps the opener of a turn someone else started above the card", () => {
    const rows: TimelineRow[] = [
      { type: "process_beat", id: "p1", text: "Finished pnpm test · exit 1" },
      think("t1"),
      tools("a", "file_read", "file_read"),
      say("answer"),
    ];
    expect(kinds(rows)).toEqual(["process_beat", "work(2)", "content"]);
  });

  it("leaves a reply with too little work as ordinary rows", () => {
    expect(kinds([think("t1"), tools("a", "file_read"), say("c1")])).toEqual(["thinking", "tools", "content"]);
  });

  it("gives a reply with no work no card", () => {
    expect(kinds([say("c1")])).toEqual(["content"]);
  });

  it("keys the card by the first TOOL CALL id, which live and reloaded transcripts share", () => {
    const work = groupWorkStretches([say("n0"), think("t1"), tools("toolu_9", "file_read"), think("t2")])[0] as WorkStretch;
    expect(work.id).toBe("toolu_9-0");
  });

  it("carries each row's position in the turn, so the spine markers stay turn-wide", () => {
    const work = groupWorkStretches([say("c0"), think("t1"), tools("a", "x", "y")])[0] as WorkStretch;
    expect(work.items.map((i) => i.index)).toEqual([0, 1, 2]);
  });

  it("spans the earliest and latest clock any row carries", () => {
    const work = groupWorkStretches([
      think("t1", 1_000, 500),
      { ...tools("a", "file_read", "file_read"), at: 2_000, lastAt: 9_000 } as TimelineRow,
    ])[0] as WorkStretch;
    expect(work.startedAt).toBe(1_000);
    expect(work.endedAt).toBe(9_000);
  });
});
