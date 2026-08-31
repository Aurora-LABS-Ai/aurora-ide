/**
 * The sliding label's measurement.
 *
 * jsdom has no layout, so the two width reads are stubbed — what's under test
 * is the arithmetic and the wiring: the reveal distance is exactly the amount
 * that was hidden, the duration comes from that distance (constant speed, not
 * constant duration), the row is what triggers the measurement, and a label
 * that already fits stays perfectly still.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ScrollingLabel } from "./ScrollingLabel";

/** Pin the layout jsdom won't compute: how wide the text is vs the space it has. */
const fakeWidths = (contentWidth: number, clipWidth: number) => {
  const clip = document.querySelector<HTMLElement>(".agw-slide")!;
  const inner = document.querySelector<HTMLElement>(".agw-slide-inner")!;
  Object.defineProperty(clip, "clientWidth", { value: clipWidth, configurable: true });
  Object.defineProperty(inner, "scrollWidth", { value: contentWidth, configurable: true });
};

describe("ScrollingLabel", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    // requestAnimationFrame runs inline so the measurement is observable.
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container.remove();
    vi.unstubAllGlobals();
  });

  /** The real shape: a hover host row wrapping the label. */
  const render = (text: string) => {
    act(() => {
      root ??= createRoot(container);
      root.render(
        <div data-slide-host="">
          <ScrollingLabel text={text} />
        </div>,
      );
    });
  };

  const host = () => container.querySelector<HTMLElement>("[data-slide-host]")!;
  const clip = () => container.querySelector<HTMLElement>(".agw-slide")!;
  const hover = () =>
    act(() => {
      host().dispatchEvent(new Event("pointerenter"));
    });

  it("slides by exactly the hidden amount", () => {
    render("a title far too long for this rail");
    fakeWidths(300, 180);
    hover();

    expect(clip().style.getPropertyValue("--agw-slide-shift")).toBe("-120px");
  });

  it("derives the duration from the distance, so speed stays constant", () => {
    render("a title far too long for this rail");
    fakeWidths(300, 180); // 120px hidden
    hover();
    const short = parseFloat(clip().style.getPropertyValue("--agw-slide-dur"));

    fakeWidths(420, 180); // 240px hidden — twice as far
    hover();
    const long = parseFloat(clip().style.getPropertyValue("--agw-slide-dur"));

    // Loose enough to clear the two-decimal rounding the CSS value carries.
    expect(long).toBeCloseTo(short * 2, 1);
  });

  it("caps the reveal so a very long title never becomes a wait", () => {
    render("an extravagantly long title");
    fakeWidths(10_000, 100);
    hover();

    expect(parseFloat(clip().style.getPropertyValue("--agw-slide-dur"))).toBe(6);
  });

  it("stays still when the label already fits", () => {
    render("short");
    fakeWidths(80, 180);
    hover();

    expect(clip().style.getPropertyValue("--agw-slide-shift")).toBe("");
    expect(clip().style.getPropertyValue("--agw-slide-dur")).toBe("");
  });

  it("renders the text in the moving box, not the clip", () => {
    render("hello");
    expect(container.querySelector(".agw-slide-inner")!.textContent).toBe("hello");
    expect(clip().className).toContain("agw-slide");
  });
});
