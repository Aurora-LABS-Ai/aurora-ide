import { afterEach, describe, expect, it } from "vitest";

import { placeFlyout, placeMenu, visibleBounds } from "./menu-room";

function box(top: number, bottom: number, overflow?: string): HTMLDivElement {
  const el = document.createElement("div");
  if (overflow) el.style.overflow = overflow;
  el.getBoundingClientRect = () =>
    ({ top, bottom, left: 0, right: 100, width: 100, height: bottom - top, x: 0, y: top }) as DOMRect;
  return el;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("visibleBounds", () => {
  it("narrows the window by every ancestor that clips, ignoring the rest", () => {
    const panel = box(40, 850, "hidden");
    const plain = box(0, 2000);
    const scroller = box(20, 900, "auto");
    const selector = box(370, 400);
    scroller.append(panel);
    panel.append(plain);
    plain.append(selector);
    document.body.append(scroller);
    expect(visibleBounds(selector, 1000)).toEqual({ top: 40, bottom: 850 });
  });

  it("is the window when nothing clips", () => {
    const selector = box(370, 400);
    document.body.append(selector);
    expect(visibleBounds(selector, 1000)).toEqual({ top: 0, bottom: 1000 });
  });
});

describe("placeMenu", () => {
  const trigger = { top: 370, bottom: 400 };

  it("opens down and shrinks to the panel when the panel ends before the window", () => {
    // The window has 600px below the pill, but the panel only 450: the old
    // window-based rule opened a 480px menu down and the panel cut its bottom.
    expect(placeMenu(trigger, { top: 40, bottom: 850 }, 480, 8)).toEqual({
      placement: "down",
      height: 434,
    });
  });

  it("opens down on the home screen even when more room is above (measured)", () => {
    // Live empty state, 2026-10-16: pill 595–623, the scroller clips 95–1081.
    expect(placeMenu({ top: 595, bottom: 623 }, { top: 95, bottom: 1081 }, 480, 8)).toEqual({
      placement: "down",
      height: 442,
    });
  });

  it("opens up when the composer sits low, capped to the room above", () => {
    expect(placeMenu({ top: 700, bottom: 730 }, { top: 40, bottom: 900 }, 480, 8)).toEqual({
      placement: "up",
      height: 480,
    });
    expect(placeMenu({ top: 400, bottom: 430 }, { top: 40, bottom: 600 }, 480, 8)).toEqual({
      placement: "up",
      height: 344,
    });
  });

  it("never goes below a usable height", () => {
    expect(placeMenu(trigger, { top: 300, bottom: 450 }, 480, 8).height).toBe(160);
  });
});

describe("placeFlyout", () => {
  const size = { width: 200, height: 180 };
  const panel = { top: 95, bottom: 1081, left: 60, right: 1600 };

  it("sits beside the menu, its first choice level with the row", () => {
    expect(placeFlyout({ left: 700, right: 1140 }, { top: 700, bottom: 734 }, size, panel)).toEqual({
      left: 1146,
      top: 670,
    });
  });

  it("goes left of the menu when the panel has no room on the right", () => {
    expect(placeFlyout({ left: 1150, right: 1590 }, { top: 700, bottom: 734 }, size, panel).left).toBe(944);
  });

  it("moves up from a low row (a docked composer) to stay inside the panel", () => {
    // Composer at the bottom, menu opened up, last row near the panel's edge.
    expect(placeFlyout({ left: 700, right: 1140 }, { top: 1040, bottom: 1074 }, size, panel).top).toBe(
      1081 - 8 - 180,
    );
  });
});
