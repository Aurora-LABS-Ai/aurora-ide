import { describe, expect, it } from "vitest";

import { fmtDuration, fmtResetsIn } from "./duration";

describe("fmtDuration", () => {
  it("says at most two units", () => {
    expect(fmtDuration(3 * 86_400 + 5 * 3_600 + 12 * 60)).toBe("3d 5h");
    expect(fmtDuration(2 * 3_600 + 14 * 60)).toBe("2h 14m");
    expect(fmtDuration(45 * 60)).toBe("45m");
  });

  it("drops a zero unit rather than printing it", () => {
    expect(fmtDuration(3 * 86_400)).toBe("3d");
    expect(fmtDuration(2 * 3_600)).toBe("2h");
  });

  /** "0m" reads as "no time left" when the truth is "nearly none". */
  it("rounds anything under a minute up to 1m", () => {
    expect(fmtDuration(5)).toBe("1m");
    expect(fmtDuration(0)).toBe("1m");
    expect(fmtDuration(-30)).toBe("1m");
  });
});

describe("fmtResetsIn", () => {
  /**
   * The regression. This used to be computed with `fmtRelative`, which measures
   * how long ago a past instant was — so every future reset, which is all of
   * them, came back as "now". The card read "resets now" on a window with four
   * hours left on it.
   */
  it("counts forward to a future instant", () => {
    const in4h = new Date(Date.now() + 4 * 3_600_000 - 30_000).toISOString();
    expect(fmtResetsIn(in4h)).toBe("resets in 3h 59m");
  });

  it("says a window already due has rolled over", () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    expect(fmtResetsIn(past)).toBe("resets now");
  });

  it("says nothing at all when there is nothing to say", () => {
    expect(fmtResetsIn(null)).toBeNull();
    expect(fmtResetsIn(undefined)).toBeNull();
    expect(fmtResetsIn("")).toBeNull();
    expect(fmtResetsIn("not a date")).toBeNull();
  });
});
