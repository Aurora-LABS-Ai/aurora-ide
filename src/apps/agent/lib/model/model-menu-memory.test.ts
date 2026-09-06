import { describe, expect, it } from "vitest";

import {
  FREQUENT_GROUP_KEY,
  isModelGroupOpen,
  parseModelGroupsOpen,
  toggleModelGroup,
  type ModelGroupsOpen,
} from "@/apps/agent/lib/model/model-menu-memory";

describe("parseModelGroupsOpen", () => {
  it("keeps the sections that were left open", () => {
    expect(parseModelGroupsOpen({ anthropic: true, openai: true })).toEqual({
      anthropic: true,
      openai: true,
    });
  });

  /**
   * Absent already means closed, so a stored `false` is a row that costs bytes
   * and says nothing. Dropping it keeps the record proportional to what the
   * user actually opened rather than to how many providers they have.
   */
  it("drops the closed ones rather than storing them", () => {
    expect(parseModelGroupsOpen({ a: true, b: false })).toEqual({ a: true });
  });

  /** Anything that is not the stored shape starts clean, never throws mid-render. */
  it("survives whatever is in storage", () => {
    expect(parseModelGroupsOpen(null)).toEqual({});
    expect(parseModelGroupsOpen("{}")).toEqual({});
    expect(parseModelGroupsOpen(7)).toEqual({});
    expect(parseModelGroupsOpen({ a: "yes", b: 1 })).toEqual({});
  });
});

describe("toggleModelGroup", () => {
  it("opens a section that was closed", () => {
    expect(toggleModelGroup({}, "anthropic")).toEqual({ anthropic: true });
  });

  it("closes one that was open, and leaves no trace of it", () => {
    const open: ModelGroupsOpen = { anthropic: true, openai: true };
    expect(toggleModelGroup(open, "anthropic")).toEqual({ openai: true });
  });

  it("never mutates what it was given", () => {
    const before: ModelGroupsOpen = { anthropic: true };
    toggleModelGroup(before, "openai");
    expect(before).toEqual({ anthropic: true });
  });
});

describe("the two kinds of section start differently", () => {
  /**
   * A provider section is one of thirty and starts folded; Frequent is the
   * shortcut and starts open. Shipping Frequent closed would charge a click to
   * reach the thing that exists to save clicks.
   */
  it("opens Frequent and closes providers when nothing is stored", () => {
    expect(isModelGroupOpen({}, FREQUENT_GROUP_KEY)).toBe(true);
    expect(isModelGroupOpen({}, "anthropic")).toBe(false);
  });

  it("closes Frequent when the user closed it", () => {
    const closed = toggleModelGroup({}, FREQUENT_GROUP_KEY);
    expect(closed).toEqual({ [FREQUENT_GROUP_KEY]: false });
    expect(isModelGroupOpen(closed, FREQUENT_GROUP_KEY)).toBe(false);
  });

  /** Back to the default leaves no row behind, either way round. */
  it("stores only what differs from the default", () => {
    expect(toggleModelGroup(toggleModelGroup({}, FREQUENT_GROUP_KEY), FREQUENT_GROUP_KEY)).toEqual(
      {},
    );
    expect(toggleModelGroup(toggleModelGroup({}, "anthropic"), "anthropic")).toEqual({});
  });

  it("keeps a stored Frequent=false through a round trip", () => {
    expect(parseModelGroupsOpen({ [FREQUENT_GROUP_KEY]: false })).toEqual({
      [FREQUENT_GROUP_KEY]: false,
    });
    // A provider's `false` is its default, so it is still dropped.
    expect(parseModelGroupsOpen({ anthropic: false })).toEqual({});
  });
});
