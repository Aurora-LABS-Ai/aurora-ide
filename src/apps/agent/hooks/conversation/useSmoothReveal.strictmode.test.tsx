/**
 * The reveal has to survive a remount that reuses the same instance.
 *
 * React's StrictMode runs mount → cleanup → mount again on the SAME component,
 * refs included. The unmount cleanup cancels the scheduled frame; if it leaves
 * the ref pointing at the cancelled frame, the re-run effect reads that as "a
 * loop is already converging" and never schedules another one. The reveal then
 * sits at whatever text was present when the component mounted — one word,
 * usually — for as long as the segment keeps streaming.
 *
 * Rendered for real rather than unit-testing the ref, because the bug lives in
 * the ORDER React runs effects and cleanups in, which is the one thing a
 * hand-rolled harness would get to define for itself.
 */

import { StrictMode, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useSmoothReveal } from "@/apps/agent/hooks/conversation/useSmoothReveal";

/**
 * Manually driven frames — jsdom's rAF, where it exists, is wall-clock timed.
 *
 * A Map keyed by id, because `cancelAnimationFrame` has to genuinely drop the
 * callback. A no-op stub leaves the cancelled frame in the queue, it runs
 * anyway, and the loop converges — which is the bug being tested passing itself.
 */
let frames = new Map<number, (now: number) => void>();
let nextFrameId = 1;
let now = 0;

function runFrames(count: number) {
  for (let i = 0; i < count; i += 1) {
    if (frames.size === 0) return;
    const due = [...frames.values()];
    frames = new Map();
    now += 1000 / 60;
    act(() => {
      for (const fn of due) fn(now);
    });
  }
}

let container: HTMLDivElement;
let root: Root;

/** Renders what the hook returns, so the assertions read the DOM rather than a
 *  variable the component wrote to — which render must not do anyway. */
function Probe({ text }: { text: string }) {
  return createElement("span", null, useSmoothReveal(text, true));
}

/** The revealed text currently on screen. */
function shown(): string {
  return container.textContent ?? "";
}

/** Render one streaming segment at its current length. */
function renderText(text: string) {
  act(() => {
    root.render(createElement(StrictMode, null, createElement(Probe, { text })));
  });
}

beforeEach(() => {
  frames = new Map();
  nextFrameId = 1;
  now = 0;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal("requestAnimationFrame", (cb: (t: number) => void) => {
    const id = nextFrameId++;
    frames.set(id, cb);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    frames.delete(id);
  });
  // The hook returns the target verbatim under reduced motion, which would pass
  // these tests for the wrong reason.
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});

describe("useSmoothReveal under StrictMode", () => {
  /**
   * The reported bug. A segment mounts holding its first flush ("The"), the
   * rest of the paragraph arrives, and the reveal has to walk it out. Before
   * the fix the frozen ref meant no frame was ever scheduled and `shown` stayed
   * at "The" until the segment stopped streaming.
   */
  it("keeps revealing after the double mount", () => {
    const target = "The wiring is clear: Next.js is the browser-facing layer and BFF.";

    renderText("The");
    expect(shown()).toBe("The");

    renderText(target);
    runFrames(40);

    expect(shown()).toBe(target);
  });

  /** The hook's actual job: a burst is walked out, not dumped in one frame. */
  it("still eases rather than dumping the burst at once", () => {
    const target = `The${"x".repeat(4000)}`;

    renderText("The");
    renderText(target);
    runFrames(1);

    expect(shown().length).toBeGreaterThan(3);
    expect(shown().length).toBeLessThan(target.length);
  });
});
