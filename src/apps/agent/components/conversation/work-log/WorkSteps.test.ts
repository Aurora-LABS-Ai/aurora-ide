import { describe, expect, it } from "vitest";

import { ARRIVAL_WINDOW_MS, isArriving } from "@/apps/agent/components/conversation/work-log/arrival";

const call = (startedAt?: number) => ({ id: "c", name: "file_read", arguments: "{}", startedAt });

describe("isArriving", () => {
  const now = 1_000_000;

  it("treats a call still streaming its arguments as arriving", () => {
    expect(isArriving(call(undefined), true, now)).toBe(true);
  });

  it("treats a call that just started as arriving, and an older one as history", () => {
    expect(isArriving(call(now - 100), true, now)).toBe(true);
    expect(isArriving(call(now - ARRIVAL_WINDOW_MS - 1), true, now)).toBe(false);
  });

  /** Reopening a chat, or switching back to a running one, replays nothing. */
  it("never treats a step as arriving once the turn is over", () => {
    expect(isArriving(call(undefined), false, now)).toBe(false);
    expect(isArriving(call(now), false, now)).toBe(false);
  });
});
