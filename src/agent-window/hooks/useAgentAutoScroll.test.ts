import { describe, expect, it } from "vitest";

import { shouldSnapToBottom } from "./useAgentAutoScroll";

/**
 * The rest of the hook is layout-driven (scrollHeight, ResizeObserver, rAF),
 * none of which jsdom models, so only the pure decision is covered here. The
 * scroll behaviour itself needs a real window.
 */
describe("shouldSnapToBottom", () => {
  const VIEWPORT = 800;

  it("glides when the newest content is a short way below", () => {
    expect(shouldSnapToBottom(200, VIEWPORT)).toBe(false);
    expect(shouldSnapToBottom(VIEWPORT, VIEWPORT)).toBe(false);
  });

  it("glides right up to the threshold", () => {
    expect(shouldSnapToBottom(VIEWPORT * 3, VIEWPORT)).toBe(false);
  });

  it("snaps once the distance is more than three screens", () => {
    expect(shouldSnapToBottom(VIEWPORT * 3 + 1, VIEWPORT)).toBe(true);
    expect(shouldSnapToBottom(50_000, VIEWPORT)).toBe(true);
  });

  /**
   * A container that has not been laid out yet reports height 0. Gliding
   * against an unknown viewport would compute a nonsense target, so an
   * unmeasurable container always snaps.
   */
  it("snaps when the viewport height is not measurable", () => {
    expect(shouldSnapToBottom(500, 0)).toBe(true);
    expect(shouldSnapToBottom(0, 0)).toBe(true);
  });

  it("treats an already-at-bottom container as a no-op glide", () => {
    expect(shouldSnapToBottom(0, VIEWPORT)).toBe(false);
  });
});
