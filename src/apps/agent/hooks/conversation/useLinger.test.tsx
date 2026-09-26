/**
 * A tool run folds when it stops being the live edge. With smooth arrival on it
 * waits a moment first, and the hold must already be true in the COMMIT where
 * the flag went false: a single painted frame of `false` would fold the run and
 * then reopen it, which is the jump the setting exists to remove. (React runs a
 * discarded render pass before applying the state set during render; that pass
 * never reaches the screen, so only committed output is asserted.)
 */

import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useLinger } from "@/apps/agent/hooks/conversation/useLinger";

let container: HTMLDivElement;
let root: Root;

function Probe({ active, ms }: { active: boolean; ms: number }) {
  return createElement("span", null, String(useLinger(active, ms)));
}

const render = (active: boolean, ms: number) =>
  act(() => {
    root.render(createElement(Probe, { active, ms }));
  });
const shown = () => container.textContent;

beforeEach(() => {
  vi.useFakeTimers();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});

describe("useLinger", () => {
  it("holds true for the given time after the flag turns false", () => {
    render(true, 600);
    render(false, 600);
    // The commit where the flag went false still shows the run open.
    expect(shown()).toBe("true");
    act(() => vi.advanceTimersByTime(599));
    expect(shown()).toBe("true");
    act(() => vi.advanceTimersByTime(1));
    expect(shown()).toBe("false");
  });

  it("is a passthrough at 0ms", () => {
    render(true, 0);
    render(false, 0);
    expect(shown()).toBe("false");
  });

  it("does not hold a flag that was never true", () => {
    render(false, 600);
    expect(shown()).toBe("false");
  });

  it("stays true when the flag comes back during the hold", () => {
    render(true, 600);
    render(false, 600);
    render(true, 600);
    act(() => vi.advanceTimersByTime(1000));
    expect(shown()).toBe("true");
  });
});
