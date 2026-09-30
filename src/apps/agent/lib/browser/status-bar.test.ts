// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import { STATUS_BAR_COLOR_SCRIPT, parseRgb, statusBarInk } from "./status-bar";

const run = (): string => new Function(`return ${STATUS_BAR_COLOR_SCRIPT}`)() as string;

describe("statusBarInk", () => {
  it("uses white ink on dark pages and black ink on light ones", () => {
    expect(statusBarInk("rgb(17,17,17)")).toBe("light");
    expect(statusBarInk("#0f0f0f")).toBe("light");
    expect(statusBarInk("rgb(255,255,255)")).toBe("dark");
    expect(statusBarInk("#fdfdfc")).toBe("dark");
  });

  it("picks whichever ink reads better on a brand colour, not what looks dark", () => {
    // Deep blue: white wins.
    expect(statusBarInk("#1d4ed8")).toBe("light");
    // Mid blue: black text is 6.1:1 against white's 3.4:1, so black.
    expect(statusBarInk("#3994bc")).toBe("dark");
    expect(statusBarInk("#ffd84d")).toBe("dark");
  });

  it("defaults to dark ink for a colour it cannot read", () => {
    expect(statusBarInk("rebeccapurple")).toBe("dark");
  });
});

describe("parseRgb", () => {
  it("reads rgb, rgba and both hex lengths", () => {
    expect(parseRgb("rgba(1, 2, 3, 0.5)")).toEqual([1, 2, 3]);
    expect(parseRgb("#abc")).toEqual([170, 187, 204]);
    expect(parseRgb("#0F0F0F")).toEqual([15, 15, 15]);
  });
});

describe("STATUS_BAR_COLOR_SCRIPT", () => {
  afterEach(() => {
    document.head.innerHTML = "";
    document.body.removeAttribute("style");
    vi.unstubAllGlobals();
  });

  it("prefers the page's theme-color, honouring its media query", () => {
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("dark") }));
    document.head.innerHTML = `
      <meta name="theme-color" media="(prefers-color-scheme: light)" content="#ffffff">
      <meta name="theme-color" media="(prefers-color-scheme: dark)" content="#111111">`;
    expect(run()).toBe("#111111");
  });

  it("falls back to the colour at the top of the page", () => {
    document.body.style.backgroundColor = "rgb(20, 20, 22)";
    // jsdom has no layout; the element at the top is the body.
    document.elementFromPoint = () => document.body;
    expect(run()).toBe("rgb(20,20,22)");
  });
});
