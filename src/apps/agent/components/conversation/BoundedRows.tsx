/**
 * Agent Window — a run of transcript rows in a bounded area that scrolls
 * inside itself [view].
 *
 * Each chapter's body, with work cards off. It wears the open work card's
 * edge, but the card draws its own scroller (`WorkCard`: its window and panel
 * must be one tree so a click never rebuilds the rows). A long stretch of thoughts and tool calls must not grow the page by a row
 * every few seconds. The rows are the transcript's own, each still opening on
 * its own. The edge is a hairline on the right that fades at both ends (the
 * spine is the left edge; without it, a matching hairline on the left), plus
 * top and bottom fades while there is more that way — all in
 * `56-work-cards.css` (`.agw-wc-panel`, `.agw-wc-body`).
 *
 * While its work is live the area follows the newest row; reopened from
 * history it starts at the first, where reading starts (`useFollowBottom`).
 */

import React from "react";

import { useFollowBottom } from "@/apps/agent/hooks/conversation/useFollowBottom";

export const BoundedRows: React.FC<{
  /** The work inside is still running: keep the newest row in view. */
  follow: boolean;
  /** What the area holds, for a screen reader ("12 steps"). */
  label: string;
  id?: string;
  children: React.ReactNode;
}> = ({ follow, label, id, children }) => {
  const { ref, onScroll } = useFollowBottom(follow);
  return (
    <div className="agw-wc-panel">
      <div id={id} ref={ref} onScroll={onScroll} className="agw-wc-body agw-scroll-hair" tabIndex={0} aria-label={label}>
        {children}
      </div>
    </div>
  );
};
