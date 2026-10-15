import { describe, expect, it } from "vitest";

import { mergeDiskModels } from "@/apps/agent/lib/thread/disk-models";

describe("mergeDiskModels", () => {
  it("takes each listed conversation's model from disk", () => {
    const merged = mergeDiskModels(
      { a: "p:old" },
      [
        { id: "a", model: "p:new" },
        { id: "b", model: "q:other" },
      ],
      new Map(),
    );
    expect(merged).toEqual({ a: "p:new", b: "q:other" });
  });

  it("keeps the window's copy while its own write for that conversation is in flight", () => {
    // The listing left before the pick was written, so it still says the old
    // model. Adopting it flipped the composer back to what the user left.
    const merged = mergeDiskModels(
      { a: "p:picked" },
      [{ id: "a", model: "p:old" }],
      new Map([["a", 1]]),
    );
    expect(merged).toEqual({ a: "p:picked" });
  });

  it("does not forget a conversation the listing left out or has no model for", () => {
    const merged = mergeDiskModels(
      { a: "p:one", b: "p:two" },
      [{ id: "a", model: null }],
      new Map(),
    );
    expect(merged).toEqual({ a: "p:one", b: "p:two" });
  });

  it("returns the same object when nothing changed", () => {
    const current = { a: "p:one" };
    expect(mergeDiskModels(current, [{ id: "a", model: "p:one" }], new Map())).toBe(current);
  });
});
