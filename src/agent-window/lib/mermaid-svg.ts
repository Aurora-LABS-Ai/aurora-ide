interface MermaidSvgSize {
  width: number;
  height: number;
}

export interface DiagramViewport {
  x: number;
  y: number;
  scale: number;
}

/**
 * Where the artwork sits on the stage, in CSS pixels.
 *
 * Zoom is applied as SIZE rather than as `transform: scale()`. The artwork is a
 * composited layer, and Chromium scales such a layer's cached bitmap instead of
 * re-rendering it — which turned a diagram that auto-fit small into an
 * unreadable smear the moment you zoomed in. Growing the box re-renders the SVG
 * as vector at every zoom level.
 *
 * The substitution is only safe because the two produce the SAME rectangle:
 * with `transform-origin: 0 0`, scaling grows a box right-and-down from its
 * top-left corner, exactly as increasing width/height does. That equivalence is
 * what lets `fit` and the pin-point zoom maths stay untouched, so it is worth
 * stating in one place and testing.
 */
export const diagramArtworkBox = (
  size: MermaidSvgSize,
  viewport: DiagramViewport,
) => ({
  left: viewport.x,
  top: viewport.y,
  width: size.width * viewport.scale,
  height: size.height * viewport.scale,
});

const capDimension = (value: number): number => Math.min(50_000, Math.max(1, value));

export const readMermaidSvgSize = (svg: string): MermaidSvgSize => {
  const document = new DOMParser().parseFromString(svg, "image/svg+xml");
  const root = document.documentElement;
  const viewBox = root.getAttribute("viewBox")?.trim().split(/[\s,]+/).map(Number);
  if (viewBox?.length === 4 && viewBox.every(Number.isFinite) && viewBox[2] > 0 && viewBox[3] > 0) {
    return { width: capDimension(viewBox[2]), height: capDimension(viewBox[3]) };
  }
  const width = Number.parseFloat(root.getAttribute("width") ?? "");
  const height = Number.parseFloat(root.getAttribute("height") ?? "");
  return {
    width: capDimension(Number.isFinite(width) && width > 0 ? width : 800),
    height: capDimension(Number.isFinite(height) && height > 0 ? height : 600),
  };
};
