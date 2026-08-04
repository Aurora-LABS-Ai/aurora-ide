import { describe, expect, it } from "vitest";

import { formatProjectDuration } from "./agent-project-stats";

describe("number formatting", () => {
  it("formats project durations at hour/minute granularity", () => {
    expect(formatProjectDuration(0)).toBe("—");
    expect(formatProjectDuration(20_000)).toBe("<1m");
    expect(formatProjectDuration(31 * 60_000)).toBe("31m");
    expect(formatProjectDuration(60 * 60_000)).toBe("1h");
    expect(formatProjectDuration(95 * 60_000)).toBe("1h 35m");
  });
});
