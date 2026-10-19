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

import { act, useLayoutEffect, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

  /**
   * 2026-10-16, measured in Chromium on a work card: the scroll event from the
   * hook's own pin arrived a frame late, after a thought had opened and grown
   * the content, and read "54px from the bottom". Following stopped with nobody
   * touching anything. A late event at the position the hook itself set is
   * not a reader moving.
   */
  it("keeps following when its own pin's scroll event arrives after the content grew", () => {
    grow(true, 1, 10);
    measure(12); // grew by two rows before the pin's event was delivered
    act(() => box().dispatchEvent(new Event("scroll")));
    render(true, 12);
    expect(box().scrollTop).toBe(bottom(12));
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

/**
 * The glide a running work card uses (2026-10-18, probe
 * aurora-work-card-motion-designs.html, 02): content growth is travelled, not
 * jumped. The ResizeObserver and animation frames are stubbed so each frame
 * can be stepped and the box read in between.
 */
describe("useFollowBottom with glide", () => {
  let observers: { cb: ResizeObserverCallback; targets: Element[] }[] = [];
  let frames: FrameRequestCallback[] = [];
  let clock = 0;
  const api: { compensate: ((px: number) => void) | null } = { compensate: null };

  beforeEach(() => {
    observers = [];
    frames = [];
    clock = 0;
    vi.stubGlobal(
      "ResizeObserver",
      class {
        private entry: { cb: ResizeObserverCallback; targets: Element[] };
        constructor(cb: ResizeObserverCallback) {
          this.entry = { cb, targets: [] };
          observers.push(this.entry);
        }
        observe(target: Element) {
          this.entry.targets.push(target);
        }
        disconnect() {
          observers = observers.filter((o) => o !== this.entry);
        }
      },
    );
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => frames.push(cb));
    vi.stubGlobal("cancelAnimationFrame", (id: number) => {
      frames[id - 1] = () => {};
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    api.compensate = null;
  });

  const Glider: React.FC = () => {
    const rows = useRef<HTMLDivElement>(null);
    const { ref, onScroll, compensate } = useFollowBottom(true, rows, { glide: true });
    useLayoutEffect(() => {
      api.compensate = compensate;
    });
    return (
      <div data-testid="box" ref={ref} onScroll={onScroll}>
        <div ref={rows} />
      </div>
    );
  };

  /** The rows resized (content grew or shrank), as a browser would report it. */
  const rowsResized = (): void => {
    const rows = box().firstElementChild as Element;
    act(() => observers.forEach((o) => o.cb([{ target: rows } as ResizeObserverEntry], {} as ResizeObserver)));
  };

  /** Run one animation frame, 16ms after the previous one. */
  const frame = (): void => {
    clock += 16;
    const pending = frames;
    frames = [];
    act(() => pending.forEach((cb) => cb(clock)));
  };

  const mount = (rows: number): void => {
    act(() => root.render(<Glider />));
    measure(rows);
    act(() => root.render(<Glider />));
    box().scrollTop = bottom(rows);
    rowsResized();
    // Let the hook see where the box is, as it would on the next frame.
    frame();
  };

  it("travels to a new row over several frames, never more than 11px in one", () => {
    mount(10);
    const start = box().scrollTop;
    measure(11);
    rowsResized();
    const positions: number[] = [];
    for (let i = 0; i < 40 && box().scrollTop < bottom(11); i++) {
      frame();
      positions.push(box().scrollTop);
    }
    expect(box().scrollTop).toBe(bottom(11));
    expect(positions.length).toBeGreaterThan(3);
    let prev = start;
    for (const top of positions) {
      expect(top - prev).toBeLessThanOrEqual(0.7 * 16 + 0.001);
      prev = top;
    }
  });

  it("keeps following when content shrinks above and clamps the box down", () => {
    mount(10);
    // A thought folds above the view: the browser clamps scrollTop to the new bottom.
    measure(9);
    box().scrollTop = bottom(9);
    rowsResized();
    frame();
    // The next row still gets followed.
    measure(10);
    rowsResized();
    for (let i = 0; i < 40; i++) frame();
    expect(box().scrollTop).toBe(bottom(10));
  });

  it("lets go when the reader scrolls up during a glide", () => {
    mount(10);
    measure(12);
    rowsResized();
    frame();
    box().scrollTop = 100; // the reader, mid-glide
    for (let i = 0; i < 10; i++) frame();
    expect(box().scrollTop).toBe(100);
  });

  it("moves the box up by rows removed above, so what is on screen stays put", () => {
    mount(40);
    // The window dropped its oldest row and gained a new one: same height.
    act(() => api.compensate!(ROW));
    expect(box().scrollTop).toBe(bottom(40) - ROW);
    for (let i = 0; i < 40; i++) frame();
    expect(box().scrollTop).toBe(bottom(40));
  });
});
