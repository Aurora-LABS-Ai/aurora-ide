/**
 * Agent Window — composer rail chip [view].
 *
 * One tenant of the strip under the composer: a compact `glyph · count` button
 * that opens its full panel UPWARD as a popover. The chip is the whole
 * affordance — no card is ever pushed into the transcript, so the reading area
 * never moves when a system wakes up.
 *
 * The popover deliberately reuses `.agw-menu` (the shared floating-popover
 * family: same surface token, border, radius and shadow as the model selector
 * and the context card). Its fill is opaque so commands remain readable over
 * the composer; motion below owns its entrance.
 */

import React, { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";

import { AgentIcon, type AgentIconName } from "@/apps/agent/shared/AgentIcon";

interface RailChipProps {
  icon: AgentIconName;
  /** Screen-reader / tooltip name for the system this chip represents. */
  label: string;
  /** Short readout beside the glyph — a count, a ratio, a state word. */
  readout: string;
  /**
   * Something in here wants the user. Renders the pulsing dot; also the only
   * thing that makes this chip visually louder than its neighbours.
   */
  attention?: boolean;
  /** Panel body, mounted only while open (so its polling stays off until then). */
  children: React.ReactNode;
}

export const RailChip: React.FC<RailChipProps> = ({
  icon,
  label,
  readout,
  attention,
  children,
}) => {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);

  // Dismiss like every other popover in this window: a click anywhere outside,
  // or Escape. Pointerdown (not click) so dragging out of the panel still
  // closes it, and capture so a row's own handler can't swallow the event.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <span className="agw-crail-chipwrap" ref={wrapRef}>
      <button
        type="button"
        className="agw-crail-chip"
        data-open={open || undefined}
        data-attention={attention || undefined}
        aria-expanded={open}
        aria-label={`${label} — ${readout}`}
        title={label}
        onClick={() => setOpen((value) => !value)}
      >
        <AgentIcon name={icon} size={12} />
        <span className="agw-crail-chip-readout">{readout}</span>
        {attention && <span className="agw-crail-chip-dot" aria-hidden />}
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            className="agw-menu agw-crail-pop"
            onClick={(event) => event.stopPropagation()}
            // Same tween as the model menu — a short rise, no spring overshoot.
            initial={{ opacity: 0, scale: 0.98, y: 6 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.98, y: 6 }}
            transition={{ duration: 0.16, ease: [0.16, 1, 0.3, 1] }}
          >
            {children}
          </motion.div>
        )}
      </AnimatePresence>
    </span>
  );
};
