import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  drivingLabel,
  MAX_DRIVING_MS,
  MIN_VISIBLE_MS,
  useAgentBrowserDriving,
} from "@/apps/agent/store/workspace/useAgentBrowserDriving";

describe("the Browser panel's driving cue", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useAgentBrowserDriving.getState().reset();
  });

  afterEach(() => {
    useAgentBrowserDriving.getState().reset();
    vi.useRealTimers();
  });

  const driving = () => useAgentBrowserDriving.getState().driving;

  it("names the tool that is driving the page", () => {
    useAgentBrowserDriving.getState().begin("browser_click");
    expect(driving()).toBe("browser_click");
  });

  /**
   * `browser_status` can return in under 50ms. Clearing the cue the instant the
   * tool finishes would flash it inside a single frame budget, which reads as a
   * rendering glitch rather than as "the agent looked at the page".
   */
  it("keeps a fast call on screen long enough to be seen", () => {
    const store = useAgentBrowserDriving.getState();
    store.begin("browser_status");
    vi.advanceTimersByTime(30);
    store.end("browser_status");

    expect(driving()).toBe("browser_status");
    vi.advanceTimersByTime(MIN_VISIBLE_MS);
    expect(driving()).toBeNull();
  });

  it("clears immediately once a slow call has been visible for long enough", () => {
    const store = useAgentBrowserDriving.getState();
    store.begin("browser_navigate");
    vi.advanceTimersByTime(MIN_VISIBLE_MS + 500);
    store.end("browser_navigate");

    expect(driving()).toBeNull();
  });

  /** The label has to name what is happening NOW, not what just finished. */
  it("lets the next tool take over during the previous one's linger", () => {
    const store = useAgentBrowserDriving.getState();
    store.begin("browser_click");
    store.end("browser_click");
    store.begin("browser_screenshot");

    expect(driving()).toBe("browser_screenshot");
    // The click's linger must not drag the screenshot off screen with it.
    vi.advanceTimersByTime(MIN_VISIBLE_MS);
    expect(driving()).toBe("browser_screenshot");
  });

  it("ignores a finish signal from a call that has already been superseded", () => {
    const store = useAgentBrowserDriving.getState();
    store.begin("browser_click");
    store.begin("browser_scroll");
    store.end("browser_click");

    expect(driving()).toBe("browser_scroll");
  });

  /**
   * The Rust side sends the "off" from a drop guard, so a lost signal is very
   * unlikely — but a cue stuck on forever is exactly what teaches someone to
   * stop believing it, so it cannot rely on that alone.
   */
  it("gives up rather than claim forever that the agent is still working", () => {
    useAgentBrowserDriving.getState().begin("browser_fill");
    vi.advanceTimersByTime(MAX_DRIVING_MS);
    expect(driving()).toBeNull();
  });

  it("drops the cue when the listener goes away", () => {
    const store = useAgentBrowserDriving.getState();
    store.begin("browser_hover");
    store.reset();
    expect(driving()).toBeNull();
  });
});

describe("what the cue calls each tool", () => {
  it("says what is being done to the page, not which tool did it", () => {
    expect(drivingLabel("browser_click")).toBe("Clicking");
    expect(drivingLabel("browser_a11y_tree")).toBe("Reading the page structure");
    expect(drivingLabel("browser_set_viewport")).toBe("Changing the screen size");
  });

  it("falls back to an honest generic rather than a raw tool name", () => {
    expect(drivingLabel("browser_something_new")).toBe("Working in the page");
  });
});
