import { describe, expect, it } from "vitest";

import {
  absoluteTime,
  compactRelative,
  describeThreadTime,
  relativeTime,
} from "@/apps/agent/lib/time/thread-time";

/**
 * The case this exists for, from a real rail: one project, ten conversations,
 * every row reading "Architecture of account-managemen…". The title cannot
 * separate them and nothing on the row — or in its tooltip — said when any of
 * them happened.
 */
const NOW = new Date("2026-09-06T12:00:00Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);

describe("relativeTime", () => {
  it("reads as a person would say it", () => {
    expect(relativeTime(ago(5_000), NOW)).toBe("just now");
    expect(relativeTime(ago(60_000), NOW)).toBe("1 minute ago");
    expect(relativeTime(ago(12 * 60_000), NOW)).toBe("12 minutes ago");
    expect(relativeTime(ago(60 * 60_000), NOW)).toBe("1 hour ago");
    expect(relativeTime(ago(3 * 60 * 60_000), NOW)).toBe("3 hours ago");
    expect(relativeTime(ago(24 * 60 * 60_000), NOW)).toBe("1 day ago");
    expect(relativeTime(ago(5 * 24 * 60 * 60_000), NOW)).toBe("5 days ago");
  });

  it("stops at a week, where the date beside it reads better", () => {
    expect(relativeTime(ago(8 * 24 * 60 * 60_000), NOW)).toBe("");
  });

  it("never counts backwards when a row is newer than the clock", () => {
    // Clock skew, or a row written in the same instant it is read. "in -1
    // minutes" is the kind of thing that gets screenshotted.
    expect(relativeTime(new Date(NOW.getTime() + 5_000), NOW)).toBe("just now");
  });
});

describe("describeThreadTime", () => {
  it("says both when it moved and exactly when", () => {
    const line = describeThreadTime(ago(3 * 60 * 60_000).toISOString(), null, NOW);
    expect(line).toContain("Updated 3 hours ago");
    expect(line).toContain("·");
  });

  it("adds the start only when it differs from the update", () => {
    const updated = ago(60 * 60_000).toISOString();
    // Sent once, never returned to: one instant, said once.
    expect(describeThreadTime(updated, updated, NOW)).not.toContain("Started");
    // Worked over two days: both are worth knowing.
    const started = ago(2 * 24 * 60 * 60_000).toISOString();
    expect(describeThreadTime(updated, started, NOW)).toContain("Started");
  });

  /**
   * A tooltip that says nothing is honest; one that says "Invalid Date" is a
   * bug report. The rail keeps its plain title in that case.
   */
  it("returns null rather than inventing a date", () => {
    expect(describeThreadTime(null)).toBeNull();
    expect(describeThreadTime(undefined)).toBeNull();
    expect(describeThreadTime("")).toBeNull();
    expect(describeThreadTime("not a date")).toBeNull();
  });

  it("ignores an unparseable start instead of losing the update", () => {
    const line = describeThreadTime(ago(60_000).toISOString(), "nonsense", NOW);
    expect(line).toContain("Updated");
    expect(line).not.toContain("Started");
  });
});

/**
 * This is the one that actually reaches the eye. The `title` tooltip lost —
 * the rail row already claims hover to slide a long title, and a native
 * tooltip competing with that is not something to rely on for the single fact
 * the row exists to disambiguate.
 */
describe("compactRelative", () => {
  it("fits a 248px rail", () => {
    expect(compactRelative(ago(5_000).toISOString(), NOW)).toBe("now");
    expect(compactRelative(ago(12 * 60_000).toISOString(), NOW)).toBe("12m");
    expect(compactRelative(ago(3 * 60 * 60_000).toISOString(), NOW)).toBe("3h");
    expect(compactRelative(ago(2 * 24 * 60 * 60_000).toISOString(), NOW)).toBe("2d");
  });

  it("gives the date past a week, because nobody converts '9w' back", () => {
    const old = compactRelative(ago(60 * 24 * 60 * 60_000).toISOString(), NOW);
    expect(old).toMatch(/Jul/i);
    expect(old).not.toMatch(/w$/);
  });

  it("returns null for a missing or unparseable timestamp", () => {
    expect(compactRelative(null, NOW)).toBeNull();
    expect(compactRelative("nonsense", NOW)).toBeNull();
  });
});

describe("absoluteTime", () => {
  it("carries the day, the month and the time, so two rows can be told apart", () => {
    const text = absoluteTime(new Date("2026-09-06T04:58:00"));
    expect(text).toMatch(/6/);
    expect(text).toMatch(/Sep/i);
    expect(text).toMatch(/2026/);
    // The clock matters: two conversations on one day is the ordinary case.
    expect(text).toMatch(/\d{1,2}:\d{2}/);
  });
});
