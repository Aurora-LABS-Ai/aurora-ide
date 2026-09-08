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

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

export const MIN_DIAGRAM_SCALE = 0.005;
export const MAX_DIAGRAM_SCALE = 4;
/** Explicit fit never enlarges past 2× — a three-node sketch should not fill the wall. */
const FIT_MAX_SCALE = 2;
const FIT_PADDING = 72;

/**
 * The floor under the INITIAL zoom. 0.65 puts Mermaid's default 16px labels at
 * ~10.4px on screen — the smallest size this window uses anywhere. Below that a
 * diagram is a shape, not a document.
 */
export const READABLE_MIN_SCALE = 0.65;
/** Breathing room above the diagram head when the readable floor applies. */
const READABLE_TOP_PAD = 20;

/** Whole-diagram fit, centred — the overview. Null while either box is unmeasured. */
export const fitDiagramViewport = (
  stage: MermaidSvgSize,
  diagram: MermaidSvgSize,
): DiagramViewport | null => {
  if (!stage.width || !stage.height || !diagram.width || !diagram.height) return null;
  const padding = Math.min(FIT_PADDING, stage.width * 0.12, stage.height * 0.12);
  const scale = clamp(
    Math.min(
      (stage.width - padding * 2) / diagram.width,
      (stage.height - padding * 2) / diagram.height,
    ),
    MIN_DIAGRAM_SCALE,
    FIT_MAX_SCALE,
  );
  return {
    scale,
    x: (stage.width - diagram.width * scale) / 2,
    y: (stage.height - diagram.height * scale) / 2,
  };
};

/**
 * Where a freshly rendered diagram OPENS.
 *
 * Fit-to-view is right only while it stays readable. A large architecture
 * diagram fit whole into a dock column lands at 20–30% — every label
 * illegible, and the reader's first act is always the same rescue zoom (the
 * owner measured "had to zoom 300+"). So the initial scale keeps the fit when
 * it clears {@link READABLE_MIN_SCALE}, and otherwise opens AT the floor,
 * centred horizontally and anchored to the top — where a diagram starts
 * reading — leaving the full fit one click away on the Fit button.
 */
export const initialDiagramViewport = (
  stage: MermaidSvgSize,
  diagram: MermaidSvgSize,
): DiagramViewport | null => {
  const fit = fitDiagramViewport(stage, diagram);
  if (!fit || fit.scale >= READABLE_MIN_SCALE) return fit;
  const scale = READABLE_MIN_SCALE;
  return {
    scale,
    x: (stage.width - diagram.width * scale) / 2,
    y: READABLE_TOP_PAD,
  };
};

/**
 * Remove mermaid's scratch nodes for one render id — and ONLY those.
 *
 * `mermaid.render(id, …)` puts that same `id` on the `<svg>` root it hands
 * back, so the moment the caller commits that markup the document contains an
 * element with this id that IS THE DIAGRAM. A bare `getElementById(id).remove()`
 * therefore deleted the drawing it had just made, and whether it did came down
 * to whether the DOM commit won a race with the render promise's microtask:
 * the diagram appeared on some mounts and not others, and switching artifacts
 * lost it almost every time. What was left was a correctly sized, correctly
 * placed, perfectly empty artwork box with live zoom controls, no error and no
 * spinner — a failure with nothing to read.
 *
 * The id cannot be stripped from the markup to dodge the collision either:
 * mermaid writes `<style>#id .node { … }</style>` INSIDE the svg, so the id is
 * what scopes the diagram's own CSS to it.
 *
 * `stage` is the element the diagram is mounted into. Anything inside it is
 * ours and is never swept. A leftover elsewhere is mermaid's, and only a FAILED
 * render leaves one — a successful render cleans up after itself — which is the
 * only reason this exists.
 */
export const sweepMermaidScratchNodes = (id: string, stage: Element | null): void => {
  for (const node of [document.getElementById(id), document.getElementById(`d${id}`)]) {
    if (node && !stage?.contains(node)) node.remove();
  }
};

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
