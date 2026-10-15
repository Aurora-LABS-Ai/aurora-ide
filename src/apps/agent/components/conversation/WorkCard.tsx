/**
 * Agent Window — a work card: one long quiet stretch of a reply, folded
 * [view].
 *
 * Transcript → Work cards (opt-in). Where a stretch begins and ends is decided
 * by `groupWorkStretches` from the kind of each row, never by reading text.
 * This component only draws it:
 *
 *   - a header: what the agent is doing now, how many thoughts and calls, and
 *     the clock — or, once the stretch is over, how long it worked;
 *   - CLOSED while it runs: the newest rows at the bottom of a fixed-height
 *     window, the Agents tab tail's construction, so the reply stands still;
 *   - CLOSED once it is over: the header alone;
 *   - OPEN: every row exactly as the transcript draws it today. Each thought,
 *     tool card and shell output still opens and folds on its own — the card
 *     folds the stretch, never the things inside it (Alvan, 2026-10-12: the
 *     sub-agent preview could not expand its rows; this must).
 *
 * Opening a card is saved with the conversation (`useAgentWorkCardStore`).
 * The card is itself a spine row, and its rows keep the turn's own row
 * wrappers, so the timeline thread runs through it unbroken.
 *
 * Probe: Documents/aurora-work-card-designs.html, 02.
 */

import React, { useEffect, useId, useLayoutEffect, useRef, useState } from "react";

import { inertWhen } from "@/kernel/lib/a11y/inert";
import { AgentIcon } from "@/apps/agent/shared/AgentIcon";
import { describeToolActivity } from "@/apps/agent/components/conversation/activity";
import { formatWorkedDuration } from "@/apps/agent/components/conversation/timeline";
import { BoundedRows } from "@/apps/agent/components/conversation/BoundedRows";
import { WorkCardWindowContext } from "@/apps/agent/components/conversation/work-card-context";
import { useAgentThemeStore } from "@/apps/agent/store/ui/useAgentThemeStore";
import type { IndexedRow, WorkStretch } from "@/apps/agent/components/conversation/work-stretches";
import {
  selectWorkCardOpen,
  useAgentWorkCardStore,
} from "@/apps/agent/store/conversation/useAgentWorkCardStore";

/** Rows the running window keeps mounted. The window shows what fits of them
 *  (up to 380px, `.agw-wc-window`). */
const WINDOW_ROWS = 10;

/** What the stretch is doing right now, from its newest row. */
function nowDoing(stretch: WorkStretch): string {
  const last = stretch.items[stretch.items.length - 1]?.row;
  if (!last) return "Working";
  if (last.type === "tools") {
    const call = last.tools[last.tools.length - 1];
    return call ? describeToolActivity(call.name, call.arguments || "").label : "Working";
  }
  if (last.type === "chapter") return last.title;
  return "Thinking";
}

/** "73 thoughts · 144 calls · 29 files read · 99 commands", zeros left out. */
function tally(stretch: WorkStretch): string {
  const parts: string[] = [];
  const count = (n: number, one: string, many: string) => {
    if (n > 0) parts.push(`${n} ${n === 1 ? one : many}`);
  };
  count(stretch.thoughts, "thought", "thoughts");
  count(stretch.calls, "call", "calls");
  count(stretch.reads, "file read", "files read");
  count(stretch.commands, "command", "commands");
  return parts.join(" · ");
}

/** A clock that ticks once a second while the stretch runs. Its own component,
 *  so the tick re-renders three words and not the rows. */
const Ticking: React.FC<{ since: number }> = ({ since }) => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  return <>{formatWorkedDuration(Math.max(0, now - since))}</>;
};

export const WorkCard: React.FC<{
  stretch: WorkStretch;
  /** The stretch is the live edge of a streaming turn. */
  live: boolean;
  /** Nothing in the turn follows this card (no rail below it). */
  isLast: boolean;
  /** The conversation the card belongs to; `null` for an unsaved draft. */
  threadId: string | null;
  /** When the turn began (epoch ms) — the clock's start when no row has one. */
  turnStartedAt?: number;
  /** Draws one row exactly as the transcript does, in its turn-wide wrapper. */
  renderItem: (item: IndexedRow) => React.ReactNode;
}> = ({ stretch, live, isLast, threadId, turnStartedAt, renderItem }) => {
  const bodyId = useId();
  const open = useAgentWorkCardStore(selectWorkCardOpen(threadId, stretch.id));
  const setOpen = useAgentWorkCardStore((s) => s.setOpen);
  const hydrate = useAgentWorkCardStore((s) => s.hydrate);
  // A draft has nowhere to save to, so its cards open for this view only.
  const [draftOpen, setDraftOpen] = useState(false);
  const isOpen = threadId ? open : draftOpen;

  useEffect(() => {
    if (threadId) void hydrate(threadId);
  }, [threadId, hydrate]);

  const reduceMotion = useAgentThemeStore((s) => s.reduceMotion);
  // A finished card closing to its header keeps the panel on screen until the
  // height has shrunk, or the close would blank first and then move.
  const [closing, setClosing] = useState(false);

  // The height glide. Every shape here — the running window, the open panel,
  // nothing — is as tall as its content, so no stylesheet value can be the
  // target. The height before the toggle is read in the click; the height
  // after is read once React has committed; the box animates between the two.
  const animRef = useRef<HTMLDivElement>(null);
  const fromHeight = useRef<number | null>(null);

  const toggle = () => {
    if (!reduceMotion) fromHeight.current = animRef.current?.offsetHeight ?? null;
    if (isOpen && !live && !reduceMotion) setClosing(true);
    if (threadId) setOpen(threadId, stretch.id, !isOpen);
    else setDraftOpen((v) => !v);
  };

  useLayoutEffect(() => {
    const el = animRef.current;
    const from = fromHeight.current;
    fromHeight.current = null;
    if (!el || from === null || typeof el.animate !== "function") return;
    for (const running of el.getAnimations()) running.cancel();
    const to = closing ? 0 : el.offsetHeight;
    const glide = el.animate([{ height: `${from}px` }, { height: `${to}px` }], {
      duration: 220,
      easing: "cubic-bezier(0.2, 0.8, 0.2, 1)",
      fill: "forwards",
    });
    glide.onfinish = () => {
      // A close holds height 0 until React has removed the panel (below);
      // anything else hands back to the content's own height at once.
      if (closing) setClosing(false);
      else glide.cancel();
    };
  }, [isOpen]); // eslint-disable-line react-hooks/exhaustive-deps -- the glide runs per toggle only

  // The panel is gone; release the held height before the next paint.
  useLayoutEffect(() => {
    if (closing) return;
    const el = animRef.current;
    if (!el || typeof el.getAnimations !== "function") return;
    for (const held of el.getAnimations()) if (held.playState === "finished") held.cancel();
  }, [closing]);

  // The running window fades its top edge only when older steps are actually
  // cut off there. A short stretch shows all of its rows, unfaded.
  const windowInRef = useRef<HTMLDivElement>(null);
  const [clipped, setClipped] = useState(false);
  const windowShown = live && !isOpen && !closing;
  useEffect(() => {
    const inner = windowInRef.current;
    if (!windowShown || !inner || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      const box = inner.parentElement;
      setClipped(!!box && inner.offsetHeight > box.clientHeight + 1);
    });
    observer.observe(inner);
    return () => observer.disconnect();
  }, [windowShown]);

  const since = stretch.startedAt ?? turnStartedAt;
  const workedMs =
    stretch.startedAt !== undefined && stretch.endedAt !== undefined
      ? stretch.endedAt - stretch.startedAt
      : null;

  return (
    <div
      className="agw-row agw-wc"
      data-row="work"
      data-open={isOpen || undefined}
      data-running={live || undefined}
      data-last={isLast || undefined}
      data-live={live || undefined}
    >
      <i className="agw-row-branch" aria-hidden="true" />
      <button
        type="button"
        className="agw-wc-head"
        aria-expanded={isOpen}
        aria-controls={bodyId}
        onClick={toggle}
      >
        <span className="agw-wc-lead" aria-hidden="true">
          {live ? <span className="agw-spinner" /> : <span className="agw-wc-done" />}
        </span>
        {live ? (
          <>
            <span className="agw-wc-what agw-shimmer">Working</span>
            <span className="agw-wc-now">{nowDoing(stretch)}</span>
            <span className="agw-wc-count">
              {tally(stretch)}
              {since !== undefined && (
                <>
                  {" · "}
                  <Ticking since={since} />
                </>
              )}
            </span>
          </>
        ) : (
          <>
            <span className="agw-wc-what">
              {workedMs !== null && workedMs >= 1000 ? `Worked ${formatWorkedDuration(workedMs)}` : "Worked"}
            </span>
            <span className="agw-wc-now">{tally(stretch)}</span>
          </>
        )}
        <AgentIcon name="chevron-right" size={13} className="agw-wc-chev" />
      </button>

      {/* One box whose HEIGHT animates between the three shapes — the open
          panel, the running window, nothing — so opening and closing glide
          instead of snapping. While it closes, the panel stays mounted until
          the box has shrunk, or the close would blank first and then move. */}
      <div ref={animRef} className="agw-wc-anim">
        {isOpen || closing ? (
          // A panel of its own that scrolls inside itself, never the page:
          // opening a 70-step stretch must not put 140 rows back into the
          // transcript, which is the whole thing the card exists to stop
          // (Alvan, 2026-10-12). The edge and the fades say "this scrolls";
          // every row inside still opens on its own. While the stretch runs
          // the box follows its newest row; reopened from history it starts
          // at the first, where reading starts (`useFollowBottom`).
          <div {...inertWhen(!isOpen)}>
            <BoundedRows id={bodyId} follow={live && isOpen} label={`${stretch.thoughts + stretch.calls} steps`}>
              {stretch.items.map(renderItem)}
            </BoundedRows>
          </div>
        ) : live ? (
          // The newest steps, at the bottom of a window that never changes
          // height. Not a second way in: a click anywhere on it opens the card,
          // where every row is live and interactive. Inert, so keyboard focus
          // never lands on a control that is clipped half out of view.
          // Same edge as the open panel (`agw-wc-panel`), so running and open
          // read as one thing at two heights.
          <div
            id={bodyId}
            className="agw-wc-panel agw-wc-window"
            data-clipped={clipped || undefined}
            onClick={toggle}
            aria-hidden="true"
          >
            <div ref={windowInRef} className="agw-wc-window-in" {...inertWhen(true)}>
              {/* Rows know they are in the window, so a live thought stays
                  folded to its line instead of filling it with reasoning. */}
              <WorkCardWindowContext.Provider value={true}>
                {stretch.items.slice(-WINDOW_ROWS).map(renderItem)}
              </WorkCardWindowContext.Provider>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
};
