import React from "react";

interface StreamingDotMatrixProps {
  className?: string;
  size?: number;
}

const DOTS = [
  { x: 0, y: 0, delay: "0ms" },
  { x: 1, y: 0, delay: "120ms" },
  { x: 2, y: 0, delay: "240ms" },
  { x: 0, y: 1, delay: "360ms" },
  { x: 1, y: 1, delay: "480ms" },
  { x: 2, y: 1, delay: "600ms" },
  { x: 0, y: 2, delay: "720ms" },
  { x: 1, y: 2, delay: "840ms" },
  { x: 2, y: 2, delay: "960ms" },
];

export const StreamingDotMatrix: React.FC<StreamingDotMatrixProps> = ({
  className = "",
  size = 14,
}) => {
  const cell = Math.max(2, Math.floor(size / 5));
  const gap = Math.max(1, Math.floor(size / 9));
  const total = cell * 3 + gap * 2;

  return (
    <div
      className={className}
      style={{
        width: total,
        height: total,
        position: "relative",
        display: "grid",
        gridTemplateColumns: `repeat(3, ${cell}px)`,
        gridTemplateRows: `repeat(3, ${cell}px)`,
        gap: `${gap}px`,
        filter: "drop-shadow(0 0 6px color-mix(in srgb, var(--aurora-common-primary) 18%, transparent))",
      }}
      aria-hidden="true"
    >
      {DOTS.map((dot, index) => (
        <span
          key={`${dot.x}-${dot.y}-${index}`}
          style={{
            width: cell,
            height: cell,
            borderRadius: Math.max(1, Math.floor(cell / 2)),
            background:
              "color-mix(in srgb, var(--aurora-common-primary) 84%, var(--aurora-common-primary-foreground) 16%)",
            opacity: 0.28,
            transform: "scale(0.82)",
            animation: "aurora-dot-matrix 1.9s ease-in-out infinite",
            animationDelay: dot.delay,
            boxShadow:
              "0 0 10px color-mix(in srgb, var(--aurora-common-primary) 22%, transparent)",
          }}
        />
      ))}
    </div>
  );
};

export default StreamingDotMatrix;
