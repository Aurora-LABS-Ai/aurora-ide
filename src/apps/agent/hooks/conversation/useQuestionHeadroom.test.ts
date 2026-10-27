import { describe, expect, it } from "vitest";

import {
  countsAsTravel,
  HIDE_AFTER_PX,
  nextHeadroom,
  questionPast,
  SHOW_AFTER_PX,
} from "@/apps/agent/hooks/conversation/useQuestionHeadroom";

describe("questionPast", () => {
  /** Hidden while its place was still at the top, the question left a hole
   *  of its own height there (2026-10-26). */
  it("is past only once the question's own place is fully above the edge", () => {
    const edge = 100;
    expect(questionPast(99, 120, edge)).toBe(false); // 1px past: in flow at the top
    expect(questionPast(-10, 120, edge)).toBe(false); // 110px past, 10px of it still in view
    expect(questionPast(-20, 120, edge)).toBe(true); // exactly gone
    expect(questionPast(-400, 120, edge)).toBe(true);
  });
});

describe("nextHeadroom", () => {
  it("hides only after real travel down, not a nudge", () => {
    expect(nextHeadroom("shown", { down: HIDE_AFTER_PX - 1, up: 0 }, 500)).toBe("shown");
    expect(nextHeadroom("shown", { down: HIDE_AFTER_PX, up: 0 }, 500)).toBe("hidden");
  });

  it("comes back on any deliberate scroll up", () => {
    expect(nextHeadroom("hidden", { down: 0, up: SHOW_AFTER_PX - 1 }, 500)).toBe("hidden");
    expect(nextHeadroom("hidden", { down: 0, up: SHOW_AFTER_PX }, 500)).toBe("shown");
  });

  it("is always shown at the very top", () => {
    expect(nextHeadroom("hidden", { down: 100, up: 0 }, 0)).toBe("shown");
  });
});

describe("countsAsTravel", () => {
  it("counts the reader in both directions", () => {
    expect(countsAsTravel(30, true, false)).toBe(true);
    expect(countsAsTravel(-30, true, false)).toBe(true);
  });

  it("counts the follow of a running turn going down: the reply growing hides the question", () => {
    expect(countsAsTravel(30, false, true)).toBe(true);
  });

  /** A card opening, the quick-reply bar re-sticking, the page end coming up. */
  it("ignores layout moving the view when nobody is scrolling", () => {
    expect(countsAsTravel(30, false, false)).toBe(false);
    expect(countsAsTravel(-30, false, false)).toBe(false);
    expect(countsAsTravel(-30, false, true)).toBe(false);
    expect(countsAsTravel(0, true, true)).toBe(false);
  });
});
