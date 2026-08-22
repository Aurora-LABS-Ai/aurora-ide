import React from "react";

import {
  type ArtifactCategory,
  normalizeArtifactCategory,
} from "@/apps/agent/lib/artifacts/artifact-category";

/**
 * The miniature in the canvas card's lead slot — one drawing per
 * `artifactCategory`, animated while the source streams.
 *
 * Three constraints decided the whole shape of this file:
 *
 * 1. **Colour comes from the theme, never from here.** Every mark paints in
 *    `currentColor`; the card sets `color: var(--agw-accent)`. That is also why
 *    these are inline SVG rather than files under `public/` — an `.svg` loaded
 *    through `<img>` is a separate document and cannot see `--agw-*`, so it
 *    could never follow a custom theme's accent.
 * 2. **Icon packs are out.** Packs are imported at runtime and the set is
 *    unbounded, so a pack with no mark for a subject would leave the slot empty
 *    — and a pack icon names a FILE TYPE, which `artifactKind` already says.
 * 3. **Ghost + writer.** Every mark draws its structure twice: a dim ghost that
 *    never animates, and a bright copy that lands on top. The ghost is what
 *    keeps the slot from ever being blank — before the first byte, and at the
 *    instant an animation loop wraps.
 *
 * Geometry is authored once in a 34×34 box and scaled by the `size` prop, so
 * the same drawing is used at every size and cannot drift between them.
 */

export interface CanvasCategoryMarkProps {
  category: unknown;
  /** Rendered edge length in px. Geometry is authored at 34. */
  size?: number;
  /** Play the landing animation. False is the settled, fully-drawn state. */
  animate?: boolean;
  className?: string;
}

/** Stagger step per element, in seconds, per mark family. */
const STEP = 0.14;
/**
 * One cycle, in seconds. Delays are NEGATIVE by `CYCLE - offset`: a positive
 * `animation-delay` only offsets an animation's FIRST pass, after which every
 * element runs in lockstep — which looks like nothing is staggered at all.
 */
const CYCLE = 3.6;

const delay = (index: number, step = STEP): React.CSSProperties => ({
  animationDelay: `${-(CYCLE - index * step).toFixed(3)}s`,
});

/** Ghost + writer pair for a filled shape. */
type Rect = { x: number; y: number; w: number; h: number; r?: number; fo?: number };

const ghostRects = (rects: Rect[]) =>
  rects.map((s, i) => (
    <rect
      key={`g${i}`}
      className="agw-cm-g"
      x={s.x}
      y={s.y}
      width={s.w}
      height={s.h}
      rx={s.r ?? 1.2}
    />
  ));

const writerRects = (rects: Rect[], step = STEP) =>
  rects.map((s, i) => (
    <rect
      key={`w${i}`}
      className="agw-cm-w agw-cm-pop"
      x={s.x}
      y={s.y}
      width={s.w}
      height={s.h}
      rx={s.r ?? 1.2}
      // Depth rides a custom property, never the `fill-opacity` attribute: any
      // CSS rule outranks a presentation attribute, so `.agw-cm-w` would flatten
      // an authored 0.7 to its own value and the design would lose its layering.
      style={{ ...delay(i, step), ...(s.fo ? ({ "--agw-cm-fo": String(s.fo) } as React.CSSProperties) : {}) }}
    />
  ));

type Path = { d: string; len: number; w?: number };

const ghostPaths = (paths: Path[]) =>
  paths.map((p, i) => (
    <path key={`gp${i}`} className="agw-cm-gs" d={p.d} strokeWidth={p.w ?? 1.5} />
  ));

const drawnPaths = (paths: Path[], from = 0, step = STEP) =>
  paths.map((p, i) => (
    <path
      key={`wp${i}`}
      className="agw-cm-ws agw-cm-draw"
      d={p.d}
      strokeWidth={p.w ?? 1.5}
      style={{ ...delay(from + i, step), ["--agw-cm-len" as string]: String(p.len) }}
    />
  ));

// ── the nine subjects ──────────────────────────────────────────────────────
// Each returns the ghost layer first, then the writer layer, so the writers
// paint over their own ghosts without needing z-index.

const ARCHITECTURE: Rect[] = [
  { x: 4, y: 23, w: 26, h: 6, r: 1.4 },
  { x: 4, y: 13.5, w: 12.5, h: 6, r: 1.4 },
  { x: 17.5, y: 13.5, w: 12.5, h: 6, r: 1.4 },
  { x: 4, y: 4, w: 8, h: 6, r: 1.4 },
  { x: 13, y: 4, w: 8, h: 6, r: 1.4 },
  { x: 22, y: 4, w: 8, h: 6, r: 1.4 },
];

const UI_PARTS: Rect[] = [
  { x: 4, y: 4, w: 26, h: 4, r: 1.4, fo: 0.95 },
  { x: 4, y: 10.5, w: 7.5, h: 19.5, r: 1.4, fo: 0.72 },
  { x: 13.5, y: 10.5, w: 16.5, h: 8, r: 1.4, fo: 0.72 },
  { x: 13.5, y: 20.5, w: 16.5, h: 9.5, r: 1.4, fo: 0.72 },
];

const REPORT_LINES: Rect[] = [
  { x: 4, y: 5, w: 14, h: 3, r: 1 },
  { x: 4, y: 11.5, w: 26, h: 2, r: 1 },
  { x: 4, y: 16, w: 26, h: 2, r: 1 },
  { x: 4, y: 20.5, w: 19, h: 2, r: 1 },
  { x: 4, y: 25, w: 24, h: 2, r: 1 },
];

const STRUCTURE_NODES: Rect[] = [
  { x: 4, y: 4.5, w: 12, h: 3.6 },
  { x: 11.5, y: 11, w: 12, h: 3.6 },
  { x: 11.5, y: 17.5, w: 12, h: 3.6 },
  { x: 19, y: 24, w: 11, h: 3.6 },
];
const STRUCTURE_ELBOWS: Path[] = [
  { d: "M6.5 8.1v4.7h4.5", len: 9.2, w: 1.4 },
  { d: "M6.5 8.1v11.2h4.5", len: 15.7, w: 1.4 },
  { d: "M14 21.1v4.7h4.5", len: 9.2, w: 1.4 },
];

const FLOW_NODES = [
  { cx: 6, cy: 17 },
  { cx: 17, cy: 17 },
  { cx: 28, cy: 17 },
];
const FLOW_PATHS: Path[] = [
  { d: "M9.6 17h3.6", len: 3.6 },
  { d: "M12.1 15.8 13.3 17l-1.2 1.2", len: 3.4 },
  { d: "M20.6 17h3.6", len: 3.6 },
  { d: "M23.1 15.8 24.3 17l-1.2 1.2", len: 3.4 },
];

const API_COLS: Rect[] = [
  { x: 4, y: 5, w: 5, h: 24, r: 1.6 },
  { x: 25, y: 5, w: 5, h: 24, r: 1.6 },
];
const API_PATHS: Path[] = [
  { d: "M10.2 12.5h13.2", len: 13.2 },
  { d: "M22.1 11.3 23.4 12.5l-1.3 1.2", len: 3.5 },
  { d: "M23.8 21.5H10.6", len: 13.2 },
  { d: "M11.9 20.3 10.6 21.5l1.3 1.2", len: 3.5 },
];

const ROADMAP_STOPS: { x: number; up: boolean }[] = [
  { x: 6.5, up: true },
  { x: 13.8, up: false },
  { x: 21.1, up: true },
  { x: 28.4, up: false },
];

const METRIC_BARS: { x: number; h: number }[] = [
  { x: 5, h: 12 },
  { x: 11, h: 19 },
  { x: 17, h: 9 },
  { x: 23, h: 22 },
];

const COMPARISON_COLS = [4, 18.5];
const COMPARISON_W = 11.5;

function comparisonRects(): Rect[] {
  const heads: Rect[] = COMPARISON_COLS.map((x) => ({ x, y: 4.5, w: COMPARISON_W, h: 3.8 }));
  const rows: Rect[] = [];
  // Left, right, left, right — filling one column and then the other would draw
  // two lists that happen to sit side by side, not one question answered twice.
  [11.5, 16.8, 22.1, 27.4].forEach((y) => {
    COMPARISON_COLS.forEach((x) => rows.push({ x, y, w: COMPARISON_W, h: 3.4, fo: 0.7 }));
  });
  return [...heads, ...rows];
}

function body(category: ArtifactCategory): React.ReactNode {
  switch (category) {
    case "architecture":
      // Bottom-up: an architecture is understood by what it stands on.
      return (
        <>
          {ghostRects(ARCHITECTURE)}
          {writerRects(ARCHITECTURE, 0.13)}
        </>
      );

    case "flow":
      return (
        <>
          {FLOW_NODES.map((n, i) => (
            <circle key={`gn${i}`} className="agw-cm-g" cx={n.cx} cy={n.cy} r={3.2} />
          ))}
          {ghostPaths(FLOW_PATHS)}
          {FLOW_NODES.map((n, i) => (
            <circle
              key={`wn${i}`}
              className="agw-cm-w agw-cm-pop"
              cx={n.cx}
              cy={n.cy}
              r={3.2}
              style={delay(i, 0.16)}
            />
          ))}
          {/* Nodes lead their arrows: an arrow reaching a node that has not
              appeared yet reads as a rendering fault, not as a sequence. */}
          {drawnPaths(FLOW_PATHS, 1, 0.16)}
        </>
      );

    case "structure":
      return (
        <>
          {ghostRects(STRUCTURE_NODES)}
          {ghostPaths(STRUCTURE_ELBOWS)}
          {writerRects(STRUCTURE_NODES, 0.15)}
          {drawnPaths(STRUCTURE_ELBOWS, 0.5, 0.15)}
        </>
      );

    case "api":
      return (
        <>
          {ghostRects(API_COLS)}
          {ghostPaths(API_PATHS)}
          {writerRects(API_COLS, 0.13)}
          {/* The return leg is what makes this an API and not a flow: the
              exchange closes. It is drawn second and travels right to left. */}
          {drawnPaths(API_PATHS, 2, 0.17)}
        </>
      );

    case "roadmap":
      return (
        <>
          <path className="agw-cm-gs" d="M3.5 17.5h27" strokeWidth={1.6} />
          {ROADMAP_STOPS.map((s, i) => (
            <React.Fragment key={`gr${i}`}>
              <circle className="agw-cm-g" cx={s.x} cy={17.5} r={2.5} />
              <rect
                className="agw-cm-g"
                x={s.x - 4}
                y={s.up ? 7.5 : 23.5}
                width={8}
                height={3}
                rx={1.2}
              />
            </React.Fragment>
          ))}
          {/* The spine is the calendar, so it is DRAWN rather than faded: the
              motion needs a direction that means "later". */}
          <path
            className="agw-cm-ws agw-cm-draw"
            d="M3.5 17.5h27"
            strokeWidth={1.6}
            style={{ ...delay(0, 0.1), ["--agw-cm-len" as string]: "27" }}
          />
          {ROADMAP_STOPS.map((s, i) => (
            <React.Fragment key={`wr${i}`}>
              <circle
                className="agw-cm-w agw-cm-pop"
                cx={s.x}
                cy={17.5}
                r={2.5}
                style={delay(i + 1, 0.19)}
              />
              <rect
                className="agw-cm-w agw-cm-pop"
                x={s.x - 4}
                y={s.up ? 7.5 : 23.5}
                width={8}
                height={3}
                rx={1.2}
                style={{ ...delay(i + 1.5, 0.19), ["--agw-cm-fo" as string]: "0.7" }}
              />
            </React.Fragment>
          ))}
        </>
      );

    case "comparison": {
      const rects = comparisonRects();
      return (
        <>
          {ghostRects(rects)}
          {writerRects(rects, 0.1)}
        </>
      );
    }

    case "metrics":
      return (
        <>
          <rect
            className="agw-cm-g"
            x={3.5}
            y={28.6}
            width={27}
            height={1.1}
            rx={0.55}
            style={{ ["--agw-cm-go" as string]: "0.3" }}
          />
          {METRIC_BARS.map((b, i) => (
            <rect
              key={`gb${i}`}
              className="agw-cm-g"
              x={b.x}
              y={28.4 - b.h}
              width={5.6}
              height={b.h}
              rx={1.2}
            />
          ))}
          {/* Grown by clip, not scaleY: scaling a rounded rect squashes its
              radius on the way up, so a 1px round end goes oval mid-animation. */}
          {METRIC_BARS.map((b, i) => (
            <rect
              key={`wb${i}`}
              className="agw-cm-w agw-cm-rise"
              x={b.x}
              y={28.4 - b.h}
              width={5.6}
              height={b.h}
              rx={1.2}
              style={delay(i, 0.17)}
            />
          ))}
        </>
      );

    case "ui":
      return (
        <>
          {ghostRects(UI_PARTS)}
          {writerRects(UI_PARTS, 0.16)}
        </>
      );

    case "report":
    default:
      return (
        <>
          {ghostRects(REPORT_LINES)}
          {REPORT_LINES.map((s, i) => (
            <rect
              key={`wl${i}`}
              className="agw-cm-w agw-cm-type"
              x={s.x}
              y={s.y}
              width={s.w}
              height={s.h}
              rx={s.r ?? 1}
              style={delay(i)}
            />
          ))}
        </>
      );
  }
}

export const CanvasCategoryMark: React.FC<CanvasCategoryMarkProps> = ({
  category,
  size = 34,
  animate = false,
  className,
}) => {
  const resolved = normalizeArtifactCategory(category);
  return (
    <svg
      className={["agw-cm", animate ? "agw-cm-anim" : "", className ?? ""]
        .filter(Boolean)
        .join(" ")}
      width={size}
      height={size}
      viewBox="0 0 34 34"
      fill="none"
      aria-hidden="true"
      focusable="false"
      data-category={resolved}
    >
      {body(resolved)}
    </svg>
  );
};

export default CanvasCategoryMark;
