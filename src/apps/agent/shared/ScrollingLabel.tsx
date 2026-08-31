/**
 * Agent Window — a label that reveals its own tail on hover [primitive].
 *
 * A one-line label that ellipsises when it doesn't fit, and slides left to show
 * the rest of itself while the row it sits in is hovered. It exists for the
 * chat rail, where titles are generated from the first message and routinely
 * run past the rail's width — "ledger CLI build project rules …" tells you a
 * good deal less than the sentence it was cut from.
 *
 * Two rules govern the movement:
 *
 *  - **The trigger is the ROW, not the label.** Put `data-slide-host` on the
 *    element whose hover should start the reveal (the whole row) and this
 *    label follows it, so the tail appears wherever the pointer lands instead
 *    of only when it happens to be over the text.
 *  - **Constant speed, not constant duration.** The distance is measured, and
 *    the duration is derived from it, so a title twice as long takes twice as
 *    long rather than racing past at twice the speed.
 *
 * The slide itself holds for a second first (`--agw-slide-delay`, in the CSS):
 * a pointer crossing the rail on its way somewhere else should leave every row
 * it passes perfectly still.
 *
 * The measurement runs on the row's `pointerenter`, one frame late on purpose:
 * hover also reveals a row's action buttons, which narrows the space the title
 * has, and measuring before that layout would slide by the wrong amount.
 *
 * Motion here is an accelerator, never the only way through: the row's own
 * `title` tooltip still carries the full text, which is what a reduced-motion
 * reader gets.
 */

import React, { useEffect, useRef } from "react";

/** Pixels per second. Slow enough to read while it moves. */
const DEFAULT_SPEED = 45;
/** However long the title, the reveal never becomes a thing you wait out. */
const MAX_SECONDS = 6;

export const ScrollingLabel: React.FC<{
  text: string;
  /** Applied alongside `agw-slide` — the caller's own type/colour styling. */
  className?: string;
  speed?: number;
}> = ({ text, className, speed = DEFAULT_SPEED }) => {
  const clipRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const clip = clipRef.current;
    const inner = clip?.firstElementChild as HTMLElement | null;
    if (!clip || !inner) return;
    // No host found → the label's own hover drives it, which is still correct,
    // just a smaller target.
    const host = (clip.closest("[data-slide-host]") as HTMLElement) ?? clip;

    let frame = 0;
    const measure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        // Read AFTER the hover styles land: at rest the label is ellipsised, so
        // `scrollWidth` reports the clipped width and would say "fits".
        const overflow = inner.scrollWidth - clip.clientWidth;
        if (overflow > 1) {
          clip.style.setProperty("--agw-slide-shift", `${-overflow}px`);
          clip.style.setProperty(
            "--agw-slide-dur",
            `${Math.min(MAX_SECONDS, overflow / speed).toFixed(2)}s`,
          );
        } else {
          // It fits — leave the fallbacks in place so nothing moves.
          clip.style.removeProperty("--agw-slide-shift");
          clip.style.removeProperty("--agw-slide-dur");
        }
      });
    };

    host.addEventListener("pointerenter", measure);
    return () => {
      host.removeEventListener("pointerenter", measure);
      cancelAnimationFrame(frame);
    };
  }, [text, speed]);

  return (
    <span ref={clipRef} className={className ? `agw-slide ${className}` : "agw-slide"}>
      <span className="agw-slide-inner">{text}</span>
    </span>
  );
};
