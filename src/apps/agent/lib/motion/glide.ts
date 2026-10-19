/**
 * Agent Window — the one glide for everything that opens, folds or changes
 * height inside the transcript (tool cards, a shell tail, tool groups, server
 * lanes, thoughts, the work card).
 *
 * Each of those had its own length and curve: 0.18s ease-out on a group,
 * 0.22s with a curve that does half its travel in the first two frames on a
 * card, framer-motion's default on a thought. Side by side they read as
 * snaps of different sizes, and the front-loaded curves looked like a jump
 * followed by a crawl (Alvan, 2026-10-16: "junky", "clunky", "not smooth").
 *
 * This is a standard ease-in-out: it starts gently, travels through the
 * middle and settles, so a height change reads as one movement. It is the
 * window's existing `--agw-ease-standard`; CSS reads the pair as
 * `--agw-glide-dur` / `--agw-glide-ease` (01-root.css).
 */

/** Seconds, for framer-motion. */
export const GLIDE_S = 0.28;

/** Milliseconds, for the Web Animations API. */
export const GLIDE_MS = 280;

/** The curve, as framer-motion takes it. */
export const GLIDE_EASE = [0.4, 0, 0.2, 1] as const;

/** The curve, as CSS and the Web Animations API take it. */
export const GLIDE_EASE_CSS = "cubic-bezier(0.4, 0, 0.2, 1)";

/** A framer-motion transition for a height that opens or folds. */
export const GLIDE = { duration: GLIDE_S, ease: GLIDE_EASE } as const;

/** Leaving instantly: for a block another one is replacing in the same place,
 *  where two height changes at once would make the row wobble. */
export const GLIDE_NONE = { duration: 0 } as const;
