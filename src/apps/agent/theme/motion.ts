/**
 * Agent Window — motion tokens for JavaScript animation (theme concern, pure).
 *
 * framer-motion takes numbers, not `var(--agw-…)`, so a component animating in
 * JS cannot read the CSS tokens in `01-root.css`. These are the same values,
 * declared once for that case; `motion.test.ts` fails if they drift from the
 * stylesheet. CSS rules keep using the custom properties directly.
 */

/** Seconds — `--agw-dur-fast` / `--agw-dur-base` / `--agw-dur-slow` /
 * `--agw-dur-exit` (leaving: about two thirds of `base`). */
export const AGW_DURATION = {
  fast: 0.12,
  base: 0.16,
  slow: 0.24,
  exit: 0.1,
  /** A dropdown or hover card sweeping open (`--agw-dur-sweep`). */
  sweep: 0.32,
} as const;

/** Cubic-bezier control points — the `--agw-ease-*` curves. */
export const AGW_EASE = {
  enter: [0.16, 1, 0.3, 1],
  pop: [0.2, 0.9, 0.3, 1],
  out: [0, 0, 0.2, 1],
  standard: [0.4, 0, 0.2, 1],
  spring: [0.34, 1.4, 0.6, 1],
  snappy: [0.23, 1, 0.32, 1],
  exit: [0.8, 0, 0.4, 1],
} as const satisfies Record<string, readonly [number, number, number, number]>;

/** The SWEEP: how a dropdown or hover card opens. Timing from the Codex
 * reference (`docs/MOTION.md`, "Composer model picker": 320ms, 30ms late,
 * `snappy`); the exit follows its general rule (shorter, `exit` curve).
 *
 * The SHAPE is Aurora's own (Alvan, 2026-10-28): the reference's .98 scale-in
 * read as a pop, so a panel SWEEPS open away from its trigger instead — a
 * reveal from the trigger's edge, with a few pixels of travel and a quicker
 * fade so the leading edge never shows an empty frame. First the model picker,
 * then every dropdown and hover card. CSS-animated panels use the same values
 * through `agw-sweep-down` / `agw-sweep-up` (02-shell.css). */
export const AGW_SWEEP = {
  enterSeconds: AGW_DURATION.sweep,
  delaySeconds: 0.03,
  exitSeconds: 0.2,
  /** The fade finishes well before the sweep does. */
  fadeSeconds: 0.16,
  /** How far the panel travels with the sweep, toward its resting place. */
  travelPx: 6,
} as const;

/** The open state: the clip reaches PAST every edge, so a panel's drop shadow
 *  is never cut off once it has opened. Every value a percentage: framer will
 *  not tween a % ↔ px pair, it jumps. */
const SWEEP_OPEN = "inset(-10% -10% -10% -10% round 12px)";

/**
 * framer-motion props for a panel that sweeps open. `down`: it hangs below
 * its trigger and unrolls downward; otherwise it stands above and unrolls up.
 * `reduce` (the window's reduced-motion setting) makes every step instant.
 */
export function sweepMotion(down: boolean, reduce = false) {
  // Closed = cut back to the edge nearest the trigger.
  const closed = down ? "inset(0% 0% 100% 0% round 12px)" : "inset(100% 0% 0% 0% round 12px)";
  const from = down ? -AGW_SWEEP.travelPx : AGW_SWEEP.travelPx;
  const instant = { duration: 0 };
  return {
    initial: { opacity: 0, clipPath: closed, y: from },
    animate: { opacity: 1, clipPath: SWEEP_OPEN, y: 0 },
    exit: {
      opacity: 0,
      clipPath: closed,
      y: from,
      transition: reduce ? instant : { duration: AGW_SWEEP.exitSeconds, ease: AGW_EASE.exit },
    },
    transition: reduce
      ? instant
      : {
          duration: AGW_SWEEP.enterSeconds,
          delay: AGW_SWEEP.delaySeconds,
          ease: AGW_EASE.snappy,
          opacity: {
            duration: AGW_SWEEP.fadeSeconds,
            delay: AGW_SWEEP.delaySeconds,
            ease: AGW_EASE.snappy,
          },
        },
  };
}
