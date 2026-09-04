import { describe, expect, it } from "vitest";

import {
  bucketFor,
  groupChatsByDay,
  type DatedThread,
} from "@/apps/agent/lib/thread/chat-day-groups";

/** A fixed "now": Thursday 4 September 2026, 09:30 local. */
const NOW = new Date(2026, 8, 4, 9, 30);

/** Local ISO for a day offset and hour, so tests read as wall-clock time. */
const at = (dayOffset: number, hour = 12): string =>
  new Date(2026, 8, 4 + dayOffset, hour).toISOString();

const thread = (id: string, updatedAt: string | null | undefined): DatedThread => ({
  id,
  updatedAt,
});

describe("bucketFor", () => {
  it("uses local midnight, not a rolling 24 hours", () => {
    // 11pm last night is fourteen hours ago at 9:30am, but it is Yesterday.
    expect(bucketFor(at(-1, 23), NOW)).toBe("yesterday");
    // 1am this morning is Today even though it is only eight hours ago.
    expect(bucketFor(at(0, 1), NOW)).toBe("today");
  });

  it("walks out through the windows", () => {
    expect(bucketFor(at(0, 9), NOW)).toBe("today");
    expect(bucketFor(at(-1), NOW)).toBe("yesterday");
    expect(bucketFor(at(-3), NOW)).toBe("week");
    expect(bucketFor(at(-7), NOW)).toBe("week");
    expect(bucketFor(at(-8), NOW)).toBe("month");
    expect(bucketFor(at(-30), NOW)).toBe("month");
    expect(bucketFor(at(-31), NOW)).toBe("older");
    expect(bucketFor(at(-400), NOW)).toBe("older");
  });

  /** Clock skew and bad sidecars both produce these; neither may be silent. */
  it("treats a future timestamp as the newest thing there is", () => {
    expect(bucketFor(at(2), NOW)).toBe("today");
  });

  it("says undated rather than pretending a missing date is now", () => {
    expect(bucketFor(null, NOW)).toBe("undated");
    expect(bucketFor(undefined, NOW)).toBe("undated");
    expect(bucketFor("", NOW)).toBe("undated");
    expect(bucketFor("not a date", NOW)).toBe("undated");
  });
});

describe("groupChatsByDay", () => {
  it("returns buckets newest first, and each bucket newest first", () => {
    const groups = groupChatsByDay(
      [
        thread("old", at(-40)),
        thread("today-early", at(0, 8)),
        thread("yesterday", at(-1)),
        thread("today-late", at(0, 9)),
        thread("week", at(-4)),
      ],
      NOW,
    );

    expect(groups.map((g) => g.id)).toEqual(["today", "yesterday", "week", "older"]);
    expect(groups[0].threads.map((t) => t.id)).toEqual(["today-late", "today-early"]);
  });

  it("drops empty buckets so no header stands alone", () => {
    const groups = groupChatsByDay([thread("a", at(0))], NOW);
    expect(groups).toHaveLength(1);
    expect(groups[0].label).toBe("Today");
  });

  it("puts undated chats last rather than dropping them", () => {
    const groups = groupChatsByDay(
      [thread("broken", null), thread("fresh", at(0))],
      NOW,
    );
    expect(groups.map((g) => g.id)).toEqual(["today", "undated"]);
    expect(groups[1].threads.map((t) => t.id)).toEqual(["broken"]);
  });

  it("does not require sorted input", () => {
    const ascending = groupChatsByDay(
      [thread("a", at(-40)), thread("b", at(-1)), thread("c", at(0))],
      NOW,
    );
    const descending = groupChatsByDay(
      [thread("c", at(0)), thread("b", at(-1)), thread("a", at(-40))],
      NOW,
    );
    expect(ascending).toEqual(descending);
  });

  it("returns nothing for an empty list", () => {
    expect(groupChatsByDay([], NOW)).toEqual([]);
  });

  it("does not mutate the array it was given", () => {
    const input = [thread("b", at(0, 8)), thread("a", at(0, 9))];
    const snapshot = [...input];
    groupChatsByDay(input, NOW);
    expect(input).toEqual(snapshot);
  });
});
