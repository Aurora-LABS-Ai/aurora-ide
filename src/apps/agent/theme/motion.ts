/**
 * Agent Window — motion tokens for JavaScript animation (theme concern, pure).
 *
 * framer-motion takes numbers, not `var(--agw-…)`, so a component animating in
 * JS cannot read the CSS tokens in `01-root.css`. These are the same values,
 * declared once for that case; `motion.test.ts` fails if they drift from the
 * stylesheet. CSS rules keep using the custom properties directly.
 */

/** Seconds — `--agw-dur-fast` / `--agw-dur-base` / `--agw-dur-slow`. */
export const AGW_DURATION = {
  fast: 0.12,
  base: 0.16,
  slow: 0.24,
} as const;

/** Cubic-bezier control points — the `--agw-ease-*` curves. */
export const AGW_EASE = {
  enter: [0.16, 1, 0.3, 1],
  pop: [0.2, 0.9, 0.3, 1],
  out: [0, 0, 0.2, 1],
  standard: [0.4, 0, 0.2, 1],
  spring: [0.34, 1.4, 0.6, 1],
} as const satisfies Record<string, readonly [number, number, number, number]>;
