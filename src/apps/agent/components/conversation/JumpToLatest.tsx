/**
 * Agent Window — "jump to latest" pill [view].
 *
 * Floats at the bottom-centre of the transcript once the reader has scrolled
 * away from the newest content, and returns them to it.
 *
 * `useAgentAutoScroll` has always computed `showJump` and `jumpToBottom` — its
 * docstring promised a "jump to latest affordance" — but no consumer ever
 * destructured them, so scrolling up in a long conversation left the reader to
 * find their own way back. This is that affordance.
 *
 * It is shown whenever the reader is away from the bottom, NOT only while a
 * turn streams. Being lost in a finished conversation is the more common case
 * of the two, and a control that appears only during streaming would vanish
 * under the cursor the moment the turn ended.
 *
 * While a turn IS streaming the pill carries a live dot, because then the
 * distance means something extra: the agent is writing content the reader
 * cannot see. That state is also named in the accessible label, so it does not
 * depend on seeing the dot.
 */

import React from "react";

import { AgentIcon } from "@/apps/agent/shared/AgentIcon";

export const JumpToLatest: React.FC<{
  /** The reader is away from the newest content. */
  show: boolean;
  /** A turn is producing content below the fold right now. */
  streaming?: boolean;
  onJump: () => void;
}> = ({ show, streaming = false, onJump }) => {
  if (!show) return null;

  return (
    <button
      type="button"
      className="agw-jumplatest"
      data-streaming={streaming || undefined}
      onClick={onJump}
      // The visible label says where it goes; the accessible name adds why it
      // matters right now, which the dot alone conveys only to sighted users.
      aria-label={
        streaming
          ? "Jump to latest — the agent is still writing"
          : "Jump to latest"
      }
    >
      {streaming && <span className="agw-jumplatest-live" aria-hidden="true" />}
      <span className="agw-jumplatest-label">Latest</span>
      <AgentIcon name="chevron-down" size={14} />
    </button>
  );
};
