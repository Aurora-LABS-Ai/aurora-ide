/**
 * The follow that keeps a height-capped run of tool rows showing the row that
 * is actually running.
 *
 * Verified the way the lesson file insists: every case here was watched FAILING
 * against the old behaviour (no follow at all) before it was kept.
 *
 * jsdom has no layout, so the probe's `scrollHeight` / `clientHeight` /
 * `scrollTop` are defined by hand. That is the point — what is under test is
 * the hook's decision about when to move a box and when to leave it alone, not
 * a browser's scrolling. `useLayoutEffect` reads the box after React has
 * committed the row and the read itself forces layout, so the geometry is
 * stubbed BEFORE each render, exactly where a browser would have computed it.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { useFollowBottom } from "./useFollowBottom";

/** A collapsed tool card and its gap. */
const ROW = 66;
/** `.agw-tool-group-body` / `.agw-mcp-lane-rows[data-scroll]`. */
const VIEWPORT = 400;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const Probe: React.FC<{ active: boolean; rows: number }> = ({ active, rows }) => {
  const { ref, onScroll } = useFollowBottom(active);
  return (
    <div data-testid="box" ref={ref} onScroll={onScroll}>
      {rows}
    </div>
  );
};

const box = (): HTMLElement => {
  const el = host.querySelector<HTMLElement>("[data-testid='box']");
  if (!el) throw new Error("probe not mounted");
  return el;
};

/** The geometry a browser would have for a box holding `rows` rows. */
const measure = (rows: number): void => {
  const el = box();
  Object.defineProperty(el, "scrollHeight", { value: rows * ROW, configurable: true });
  Object.defineProperty(el, "clientHeight", { value: VIEWPORT, configurable: true });
  if (!Object.getOwnPropertyDescriptor(el, "scrollTop")) {
    Object.defineProperty(el, "scrollTop", { value: 0, writable: true, configurable: true });
  }
};

/** Where the bottom is once `rows` rows overflow the box. */
const bottom = (rows: number): number => Math.max(0, rows * ROW - VIEWPORT);

/** Render one more row, with its layout already done. */
const render = (active: boolean, rows: number): void => {
  act(() => root.render(<Probe active={active} rows={rows} />));
  measure(rows);
  act(() => root.render(<Probe active={active} rows={rows} />));
};

/** A run gaining cards one at a time. */
const grow = (active: boolean, from: number, to: number): void => {
  for (let rows = from; rows <= to; rows++) render(active, rows);
};

/** A reader moving the box, and the scroll event that follows. */
const readerScrollsTo = (top: number): void => {
  const el = box();
  el.scrollTop = top;
  act(() => el.dispatchEvent(new Event("scroll")));
};

describe("useFollowBottom", () => {
  it("keeps the newest row in view while the run is in flight", () => {
    grow(true, 1, 10);
    expect(box().scrollTop).toBe(bottom(10));
  });

  it("leaves a run that is not running exactly where it is", () => {
    // A finished group reopened from history: reading starts at the FIRST call,
    // so nothing may move the box.
    grow(false, 1, 10);
    expect(box().scrollTop).toBe(0);
  });

  it("does not move a box whose rows already fit", () => {
    grow(true, 1, 4);
    expect(box().scrollTop).toBe(0);
  });

  it("stops chasing once the reader scrolls up, and does not yank them back", () => {
    grow(true, 1, 10);
    readerScrollsTo(ROW);
    render(true, 11);
    expect(box().scrollTop).toBe(ROW);
  });

  it("re-arms when the reader returns to the bottom", () => {
    grow(true, 1, 10);
    readerScrollsTo(ROW);
    readerScrollsTo(bottom(10));
    render(true, 11);
    expect(box().scrollTop).toBe(bottom(11));
  });

  it("treats a reader within one row of the bottom as still following", () => {
    grow(true, 1, 10);
    // 30px short — under the 40px tolerance, so this is someone watching the
    // live edge, not someone who has gone to read something further up.
    readerScrollsTo(bottom(10) - 30);
    render(true, 11);
    expect(box().scrollTop).toBe(bottom(11));
  });

  it("stops moving the box the moment the last call lands", () => {
    grow(true, 1, 10);
    expect(box().scrollTop).toBe(bottom(10));
    // The reader goes back up to read while the turn writes its answer.
    readerScrollsTo(0);
    render(false, 12);
    expect(box().scrollTop).toBe(0);
  });
});
