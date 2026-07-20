import { describe, expect, it } from "vitest";

import { readMermaidSvgSize } from "../lib/mermaid-svg";

describe("readMermaidSvgSize", () => {
  it("uses a valid viewBox before fixed SVG dimensions", () => {
    expect(
      readMermaidSvgSize('<svg viewBox="10 20 640 360" width="100" height="100"></svg>'),
    ).toEqual({ width: 640, height: 360 });
  });

  it("falls back safely when dimensions are missing or malformed", () => {
    expect(readMermaidSvgSize("<svg></svg>")).toEqual({ width: 800, height: 600 });
    expect(readMermaidSvgSize('<svg viewBox="0 0 -10 nope"></svg>')).toEqual({
      width: 800,
      height: 600,
    });
  });

  it("caps pathological diagram dimensions", () => {
    expect(readMermaidSvgSize('<svg viewBox="0 0 999999 888888"></svg>')).toEqual({
      width: 50_000,
      height: 50_000,
    });
  });
});
