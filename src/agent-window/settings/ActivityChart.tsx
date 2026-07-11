/**
 * Agent Window — premium activity infographic (view).
 *
 * One smooth-shaded SVG area chart used by ALL Profile tabs (daily / weekly /
 * cumulative): a soft accent gradient under a glowing curve, faint horizontal
 * grid, and a full crosshair + halo dot that tracks the pointer anywhere over
 * the chart (not just on hit targets) and drives the page's readout line.
 * Colors derive from `--agw-*` tokens, so it re-themes with every theme.
 */

import React, { useMemo, useRef } from "react";

export interface ChartPoint {
  label: string;
  value: number;
  turns?: number;
}

const W = 800;
const H = 220;
const PAD_X = 10;
const TOP = 18;
const BASE = H - 26;

/** Smooth cubic path through the points (midpoint control handles). */
function smoothPath(pts: Array<{ x: number; y: number }>): string {
  if (pts.length === 0) return "";
  let d = `M ${pts[0].x} ${pts[0].y}`;
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i - 1];
    const c = pts[i];
    const mx = (p.x + c.x) / 2;
    d += ` C ${mx} ${p.y}, ${mx} ${c.y}, ${c.x} ${c.y}`;
  }
  return d;
}

export const ActivityChart: React.FC<{
  points: ChartPoint[];
  hovered: ChartPoint | null;
  onHover: (p: ChartPoint | null) => void;
  formatLabel: (label: string) => string;
}> = ({ points, hovered, onHover, formatLabel }) => {
  const svgRef = useRef<SVGSVGElement>(null);

  const pts = useMemo(() => {
    const max = Math.max(1, ...points.map((p) => p.value));
    const step = points.length > 1 ? (W - 2 * PAD_X) / (points.length - 1) : 0;
    return points.map((p, i) => ({
      x: PAD_X + i * step,
      y: BASE - (p.value / max) * (BASE - TOP),
    }));
  }, [points]);

  const line = smoothPath(pts);
  const area =
    pts.length > 0
      ? `${line} L ${pts[pts.length - 1].x} ${BASE} L ${pts[0].x} ${BASE} Z`
      : "";
  const hi = hovered ? points.findIndex((p) => p.label === hovered.label) : -1;

  const onMove = (e: React.MouseEvent) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect || points.length === 0) return;
    const ratio = (e.clientX - rect.left) / rect.width;
    const i = Math.max(0, Math.min(points.length - 1, Math.round(ratio * (points.length - 1))));
    onHover(points[i]);
  };

  if (points.length === 0) {
    return <div className="agw-achart-wrap agw-profile-chart-empty">No activity yet — start a chat.</div>;
  }

  return (
    <div className="agw-achart-wrap">
      <svg
        ref={svgRef}
        className="agw-achart"
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        onMouseMove={onMove}
        onMouseLeave={() => onHover(null)}
        role="img"
        aria-label="Token activity"
      >
        <defs>
          <linearGradient id="agwAreaFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--agw-accent)" stopOpacity="0.34" />
            <stop offset="60%" stopColor="var(--agw-accent)" stopOpacity="0.10" />
            <stop offset="100%" stopColor="var(--agw-accent)" stopOpacity="0.02" />
          </linearGradient>
        </defs>

        {/* Faint horizontal grid — depth without noise. */}
        {[0.25, 0.5, 0.75].map((r) => (
          <line
            key={r}
            x1={PAD_X}
            x2={W - PAD_X}
            y1={TOP + (BASE - TOP) * r}
            y2={TOP + (BASE - TOP) * r}
            stroke="var(--agw-border)"
            strokeWidth="1"
            vectorEffect="non-scaling-stroke"
            opacity="0.5"
          />
        ))}

        <path d={area} fill="url(#agwAreaFill)" />
        {/* Glow underlay, then the crisp curve on top. */}
        <path
          d={line}
          fill="none"
          stroke="var(--agw-accent)"
          strokeWidth="7"
          opacity="0.22"
          vectorEffect="non-scaling-stroke"
          style={{ filter: "blur(4px)" }}
        />
        <path
          d={line}
          fill="none"
          stroke="var(--agw-accent)"
          strokeWidth="2.25"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />

        {hi >= 0 && pts[hi] && (
          <g>
            <line
              x1={pts[hi].x}
              x2={pts[hi].x}
              y1={TOP - 6}
              y2={BASE}
              stroke="var(--agw-border-strong)"
              strokeDasharray="3 4"
              vectorEffect="non-scaling-stroke"
            />
            <circle cx={pts[hi].x} cy={pts[hi].y} r="9" fill="var(--agw-accent)" opacity="0.25" />
            <circle
              cx={pts[hi].x}
              cy={pts[hi].y}
              r="4.5"
              fill="var(--agw-accent)"
              stroke="var(--agw-canvas)"
              strokeWidth="2"
            />
          </g>
        )}
      </svg>
      <div className="agw-achart-x">
        <span>{formatLabel(points[0].label)}</span>
        {points.length > 2 && <span>{formatLabel(points[Math.floor(points.length / 2)].label)}</span>}
        <span>{formatLabel(points[points.length - 1].label)}</span>
      </div>
    </div>
  );
};
