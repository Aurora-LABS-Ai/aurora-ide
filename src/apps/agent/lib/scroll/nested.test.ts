import { describe, expect, it } from "vitest";

import { innerScrollerTakes } from "@/apps/agent/lib/scroll/nested";

/** jsdom has no layout: give a box the sizes a scroller would have. */
function box(scrollHeight: number, clientHeight: number, scrollTop: number, overflowY = "auto"): HTMLDivElement {
  const el = document.createElement("div");
  el.style.overflowY = overflowY;
  Object.defineProperty(el, "scrollHeight", { value: scrollHeight });
  Object.defineProperty(el, "clientHeight", { value: clientHeight });
  Object.defineProperty(el, "scrollTop", { value: scrollTop });
  return el;
}

describe("innerScrollerTakes", () => {
  const setup = (inner: HTMLDivElement) => {
    const boundary = document.createElement("div");
    const leaf = document.createElement("span");
    inner.append(leaf);
    boundary.append(inner);
    return { boundary, leaf };
  };

  /** 2026-10-27: an expanded tool output inside the running card did not scroll. */
  it("gives the wheel to an expanded output that can still move that way", () => {
    const { boundary, leaf } = setup(box(800, 200, 100));
    expect(innerScrollerTakes(leaf, boundary, 120)).toBe(true);
    expect(innerScrollerTakes(leaf, boundary, -120)).toBe(true);
  });

  it("hands the wheel back at the output's end", () => {
    const atBottom = setup(box(800, 200, 600));
    expect(innerScrollerTakes(atBottom.leaf, atBottom.boundary, 120)).toBe(false);
    const atTop = setup(box(800, 200, 0));
    expect(innerScrollerTakes(atTop.leaf, atTop.boundary, -120)).toBe(false);
  });

  it("ignores a box that fits, or does not scroll vertically", () => {
    const fits = setup(box(200, 200, 0));
    expect(innerScrollerTakes(fits.leaf, fits.boundary, 120)).toBe(false);
    const hidden = setup(box(800, 200, 100, "hidden"));
    expect(innerScrollerTakes(hidden.leaf, hidden.boundary, 120)).toBe(false);
  });
});
