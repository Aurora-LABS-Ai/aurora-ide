/**
 * Agent Window — streaming dot-matrix [view].
 *
 * A 3×3 grid of nine accent dots that pulse in a staggered wave (the
 * `agw-dot-matrix` keyframe). Shown in the chat-title slot WHILE a turn is
 * streaming, in place of the static chat icon — a quiet "the model is working"
 * signal. Themed entirely with `--agw-accent`. Decorative (aria-hidden); the
 * header text ("New Chat" / title) already conveys state to assistive tech.
 *
 * Adapted from QuantumHub's `StreamingDotMatrix` (agent-studio chat header).
 */

import React from "react";

/** Staggered start offsets so the pulse rolls across the grid, not in unison. */
const DOT_DELAYS = [
  "0ms",
  "120ms",
  "240ms",
  "360ms",
  "480ms",
  "600ms",
  "720ms",
  "840ms",
  "960ms",
];

/** `size` is the nominal footprint; the rendered grid is a touch smaller. At
 *  `size={22}` the grid is ~16px — matching a 16px header icon. */
export const StreamingDotMatrix: React.FC<{ size?: number }> = ({ size = 22 }) => {
  const cell = Math.max(2, Math.floor(size / 5));
  const gap = Math.max(1, Math.floor(size / 9));
  const total = cell * 3 + gap * 2;

  return (
    <div
      aria-hidden="true"
      style={{
        width: total,
        height: total,
        display: "grid",
        gridTemplateColumns: `repeat(3, ${cell}px)`,
        gridTemplateRows: `repeat(3, ${cell}px)`,
        gap: `${gap}px`,
        filter:
          "drop-shadow(0 0 6px color-mix(in srgb, var(--agw-accent) 18%, transparent))",
      }}
    >
      {DOT_DELAYS.map((delay, index) => (
        <span
          key={index}
          style={{
            width: cell,
            height: cell,
            borderRadius: Math.max(1, Math.floor(cell / 2)),
            background: "var(--agw-accent)",
            opacity: 0.28,
            transform: "scale(0.82)",
            animation: "agw-dot-matrix 1.9s ease-in-out infinite",
            animationDelay: delay,
            boxShadow:
              "0 0 10px color-mix(in srgb, var(--agw-accent) 22%, transparent)",
          }}
        />
      ))}
    </div>
  );
};

export default StreamingDotMatrix;
