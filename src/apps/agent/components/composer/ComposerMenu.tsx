import React, { useEffect, useLayoutEffect, useRef } from "react";
import { motion, useReducedMotion } from "framer-motion";

/**
 * The floating list the composer opens for `@` (files, terminals) and `/`
 * (skills, rules, MCP). One shell for both, because they are the same object
 * appearing in the same place and any drift between them reads as a bug.
 *
 * It exists to fix two things the two hand-rolled panels got wrong:
 *
 * 1. **One owner for the entrance.** The panels carried `.agw-menu`'s
 *    `agw-pop-in` keyframe AND a Framer spring on the same element. A running
 *    CSS animation outranks inline styles, so the panel played the keyframe for
 *    120ms and then snapped to wherever the spring had travelled — that handoff
 *    was the visible jolt, and the spring's overshoot was the wobble after it.
 *    The keyframe is off for this family (see `.agw-mention`); the motion here
 *    is the whole gesture.
 *
 * 2. **A height that never leaps.** The panel is pinned to its BOTTOM edge, so
 *    every row the filter adds or drops moved its top edge instantly — the
 *    "jumping" while typing. The rows now live in their own scroller and the
 *    panel takes an explicit measured height, which CSS eases. The first
 *    measurement lands instantly on purpose: a transition from `auto` does not
 *    run, so opening is calm and only later re-filters animate.
 */

/** Ceiling for the scrolling row area; the panel adds its own 6px padding. */
const MAX_LIST_HEIGHT = 256;
/** `padding: 6px` top + bottom, counted into the panel's border-box height. */
const PANEL_PADDING = 12;

interface ComposerMenuProps {
  children: React.ReactNode;
  /**
   * Changing this returns the list to its first row. A new query is a new list,
   * and leaving it scrolled halfway down shows the reader the middle of an
   * answer they never asked for.
   */
  resetKey?: string;
}

export const ComposerMenu: React.FC<ComposerMenuProps> = ({ children, resetKey }) => {
  const panelRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const reduceMotion = useReducedMotion();

  // Measured from the CONTENT, not the scroller: the scroller stops growing at
  // its max-height, so observing it would report nothing once the list is long
  // enough to scroll — exactly when the height matters most.
  useLayoutEffect(() => {
    const panel = panelRef.current;
    const content = contentRef.current;
    if (!panel || !content) return;

    const measure = () => {
      const rows = content.offsetHeight;
      panel.style.height = `${Math.min(rows, MAX_LIST_HEIGHT) + PANEL_PADDING}px`;
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(content);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    listRef.current?.scrollTo({ top: 0 });
  }, [resetKey]);

  return (
    <motion.div
      ref={panelRef}
      className="agw-menu agw-mention"
      // No `role="listbox"`: the rows are plain buttons and the caret never
      // leaves the editor, so claiming a listbox here would describe a widget
      // that does not exist. Making it true needs a combobox +
      // `aria-activedescendant` pass over the rows as well — still open.
      // Offset only — no scale. A width-spanning panel that scales reads as the
      // whole list breathing, which is the effect this was asked to remove.
      //
      // 18px is larger than the 6px gap ON PURPOSE: the panel starts tucked
      // under the composer's top edge, which paints over it, so it emerges from
      // behind the box rather than fading in beside it. Sliding the full panel
      // height would be a 400px whoosh every time you press `@`.
      initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 18 }}
      animate={{ opacity: 1, y: 0 }}
      exit={
        reduceMotion
          ? { opacity: 0, transition: { duration: 0.1 } }
          : // Back the way it came, accelerating and shorter than arriving: a
            // menu that animates in and snaps out is the common bug, and one
            // that takes as long to leave as to arrive feels sticky.
            { opacity: 0, y: 12, transition: { duration: 0.12, ease: [0.4, 0, 1, 1] } }
      }
      transition={{ duration: 0.17, ease: [0, 0, 0.2, 1] }}
    >
      <div className="agw-mention-list" ref={listRef}>
        <div ref={contentRef}>{children}</div>
      </div>
    </motion.div>
  );
};
