/**
 * Agent Window — jump-to-user-message rail [view].
 *
 * A vertical strip of pins on the right edge of the conversation, one per USER
 * message. Click a pin to scroll-jump to that message. Hovering the rail applies
 * a macOS-dock magnification: the pin nearest the cursor (and its neighbours)
 * glide wider with a smooth distance falloff, so the rail reads as a dock rather
 * than a static scrollbar. There is no scroll-following "active" pin — the dock
 * IS the affordance.
 */

import React, { useCallback, useRef, useState } from "react";

export interface JumpPin {
  id: string;
  preview: string;
}

// Pin geometry — kept in sync with the `.agw-jumprail*` CSS so the cursor→pin
// distance math lines up with what's painted.
const PAD_TOP = 6; // .agw-jumprail padding-top
const PIN_H = 3; // pin height
const GAP = 7; // flex gap between pins
const ROW = PIN_H + GAP; // vertical advance per pin
const HALF = PIN_H / 2;
const INFLUENCE = 48; // px radius the magnification reaches
const BASE_W = 14; // resting pin width
const MAX_W = 30; // width of the pin directly under the cursor

export const JumpRail: React.FC<{
  pins: JumpPin[];
  onJump: (id: string) => void;
}> = ({ pins, onJump }) => {
  const railRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef(0);
  // Cursor Y within the rail while hovering, else null (resting state).
  const [hoverY, setHoverY] = useState<number | null>(null);

  const onMove = useCallback((e: React.MouseEvent) => {
    const rail = railRef.current;
    if (!rail) return;
    const y = e.clientY - rail.getBoundingClientRect().top + rail.scrollTop;
    if (!rafRef.current) {
      rafRef.current = window.requestAnimationFrame(() => {
        rafRef.current = 0;
        setHoverY(y);
      });
    }
  }, []);

  const onLeave = useCallback(() => {
    if (rafRef.current) {
      window.cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
    }
    setHoverY(null);
  }, []);

  return (
    <div
      ref={railRef}
      className="agw-jumprail"
      aria-label="Jump to message"
      onMouseMove={onMove}
      onMouseLeave={onLeave}
    >
      {pins.map((pin, i) => {
        const center = PAD_TOP + i * ROW + HALF;
        let width = BASE_W;
        if (hoverY != null) {
          const d = Math.abs(hoverY - center);
          // Quadratic falloff → a smooth dome that peaks under the cursor.
          const f = Math.max(0, 1 - d / INFLUENCE);
          width = BASE_W + (MAX_W - BASE_W) * f * f;
        }
        const hot =
          hoverY != null && Math.abs(hoverY - center) <= ROW / 2 + 0.5;
        return (
          <button
            key={pin.id}
            type="button"
            className="agw-jumprail-pin"
            data-hot={hot || undefined}
            title={pin.preview || `Message ${i + 1}`}
            aria-label={`Jump to message ${i + 1}`}
            style={{ width }}
            onClick={() => onJump(pin.id)}
          />
        );
      })}
    </div>
  );
};
