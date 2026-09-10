/**
 * `codexCreditsLabel` — the phrase the context ring puts beside "Credits".
 *
 * Worth its own tests because the balance is a STRING the ChatGPT backend
 * formats however it likes, and the row it feeds is the only thing on the card
 * that answers "can I keep working" once the plan window is spent.
 */

import { describe, expect, it } from "vitest";

import { codexCreditsLabel } from "./codex";

describe("codexCreditsLabel", () => {
  it("says nothing when the backend reported no credits at all", () => {
    expect(codexCreditsLabel(null)).toBeNull();
    expect(codexCreditsLabel(undefined)).toBeNull();
    expect(
      codexCreditsLabel({ hasCredits: false, unlimited: false, balance: null }),
    ).toBeNull();
  });

  it("does not treat an empty balance string as a balance", () => {
    expect(
      codexCreditsLabel({ hasCredits: true, unlimited: false, balance: "   " }),
    ).toBeNull();
  });

  it("names an unlimited account before looking at any balance", () => {
    expect(
      codexCreditsLabel({ hasCredits: true, unlimited: true, balance: "0" }),
    ).toBe("Unlimited");
  });

  it("rounds a long float into a figure a person can read", () => {
    expect(
      codexCreditsLabel({ hasCredits: true, unlimited: false, balance: "3850.0000001" }),
    ).toBe("3,850");
  });

  /**
   * Zero is the single most useful thing this row can say, and it is falsy in
   * every shape it passes through on the way to the card.
   */
  it("shows a spent balance rather than hiding it", () => {
    expect(
      codexCreditsLabel({ hasCredits: true, unlimited: false, balance: "0" }),
    ).toBe("0");
  });

  /**
   * The reason the row is not gated on `hasCredits` the way the account
   * switcher's is: a window at 0% left with credits paying for the work is
   * exactly when the card must not go quiet.
   */
  it("shows a reported balance even when the flag disagrees", () => {
    expect(
      codexCreditsLabel({ hasCredits: false, unlimited: false, balance: "120" }),
    ).toBe("120");
  });

  it("passes through a balance the backend already worded", () => {
    expect(
      codexCreditsLabel({ hasCredits: true, unlimited: false, balance: "$1,000.00" }),
    ).toBe("$1,000.00");
  });
});
