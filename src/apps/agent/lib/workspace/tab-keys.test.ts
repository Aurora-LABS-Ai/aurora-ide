import { describe, expect, it } from "vitest";

import { tabIndexForKey } from "./tab-keys";

describe("tabIndexForKey", () => {
  it("steps right and left", () => {
    expect(tabIndexForKey("ArrowRight", 1, 3)).toBe(2);
    expect(tabIndexForKey("ArrowLeft", 1, 3)).toBe(0);
  });

  it("wraps at both ends", () => {
    expect(tabIndexForKey("ArrowRight", 2, 3)).toBe(0);
    expect(tabIndexForKey("ArrowLeft", 0, 3)).toBe(2);
  });

  it("jumps to the first and last", () => {
    expect(tabIndexForKey("Home", 2, 3)).toBe(0);
    expect(tabIndexForKey("End", 0, 3)).toBe(2);
  });

  it("leaves other keys, a single tab, and a no-op jump alone", () => {
    expect(tabIndexForKey("Enter", 0, 3)).toBeNull();
    expect(tabIndexForKey("ArrowRight", 0, 1)).toBeNull();
    expect(tabIndexForKey("Home", 0, 3)).toBeNull();
  });
});
