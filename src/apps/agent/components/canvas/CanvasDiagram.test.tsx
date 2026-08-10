import { describe, expect, it } from "vitest";

import {
  diagramArtworkBox,
  fitDiagramViewport,
  initialDiagramViewport,
  READABLE_MIN_SCALE,
  readMermaidSvgSize,
} from "@/apps/agent/lib/render/mermaid-svg";

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

describe("diagramArtworkBox", () => {
  const size = { width: 640, height: 360 };

  /**
   * The substitution that fixes the blur: zoom grows the box instead of
   * scaling a composited bitmap. It is only safe because both produce the SAME
   * rectangle — `transform-origin: 0 0` grows a scaled layer right-and-down
   * from its top-left corner, which is exactly what a bigger box does.
   */
  it("occupies the rectangle a top-left-origin scale would have", () => {
    const viewport = { x: 120, y: 40, scale: 1.8 };
    const box = diagramArtworkBox(size, viewport);
    // Origin is the pan offset alone — scaling must not move the corner.
    expect(box.left).toBe(viewport.x);
    expect(box.top).toBe(viewport.y);
    // ...and the far edge lands where `scale()` would have put it.
    expect(box.left + box.width).toBeCloseTo(viewport.x + size.width * viewport.scale);
    expect(box.top + box.height).toBeCloseTo(viewport.y + size.height * viewport.scale);
  });

  it("keeps the aspect ratio at every zoom level", () => {
    const ratio = size.width / size.height;
    for (const scale of [0.005, 0.25, 1, 1.8, 4]) {
      const box = diagramArtworkBox(size, { x: 0, y: 0, scale });
      expect(box.width / box.height).toBeCloseTo(ratio);
    }
  });

  /** Zooming must actually enlarge the artwork — the old path enlarged only
   *  the bitmap, which is why 180% still read as unreadably distant. */
  it("grows with the zoom level", () => {
    const fitted = diagramArtworkBox(size, { x: 0, y: 0, scale: 0.1 });
    const zoomed = diagramArtworkBox(size, { x: 0, y: 0, scale: 1.8 });
    expect(zoomed.width).toBeCloseTo(fitted.width * 18);
  });
});

describe("initialDiagramViewport", () => {
  const stage = { width: 900, height: 700 };

  it("keeps the plain fit while it stays readable", () => {
    const diagram = { width: 800, height: 500 };
    expect(initialDiagramViewport(stage, diagram)).toEqual(
      fitDiagramViewport(stage, diagram),
    );
  });

  it("refuses to open a large diagram below the readable floor", () => {
    // The reported failure: a big architecture diagram fit whole into the dock
    // opened at ~25% — every label illegible, and the first act was always the
    // same rescue zoom ("had to zoom 300+").
    const diagram = { width: 4000, height: 3000 };
    const fitted = fitDiagramViewport(stage, diagram);
    const opened = initialDiagramViewport(stage, diagram);
    expect(fitted && fitted.scale).toBeLessThan(READABLE_MIN_SCALE);
    expect(opened?.scale).toBe(READABLE_MIN_SCALE);
  });

  it("anchors a floored diagram at its top, centred, where reading starts", () => {
    const diagram = { width: 4000, height: 3000 };
    const opened = initialDiagramViewport(stage, diagram);
    expect(opened).not.toBeNull();
    // Horizontal centre: equal overflow either side.
    expect(opened!.x).toBeCloseTo((stage.width - diagram.width * opened!.scale) / 2);
    // Top anchored with a small breathing gap, not vertically centred into the
    // middle of the diagram.
    expect(opened!.y).toBeGreaterThan(0);
    expect(opened!.y).toBeLessThan(40);
  });

  it("is null while either box is unmeasured", () => {
    expect(initialDiagramViewport({ width: 0, height: 0 }, { width: 100, height: 100 })).toBeNull();
    expect(initialDiagramViewport(stage, { width: 0, height: 0 })).toBeNull();
  });

  it("never enlarges a small diagram past the fit cap", () => {
    const diagram = { width: 120, height: 80 };
    const opened = initialDiagramViewport(stage, diagram);
    expect(opened?.scale).toBeLessThanOrEqual(2);
    expect(opened?.scale).toBeGreaterThanOrEqual(1);
  });
});
