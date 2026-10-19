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
import {
  LiveWorkCardContext,
  WorkCardWindowContext,
} from "@/apps/agent/components/conversation/work-card-context";
import { ArrivalHoldContext } from "@/apps/agent/components/tools/arrival-hold";
import { useFollowBottom } from "@/apps/agent/hooks/conversation/useFollowBottom";
import { GLIDE_EASE_CSS, GLIDE_MS } from "@/apps/agent/lib/motion/glide";
import { useAgentThemeStore } from "@/apps/agent/store/ui/useAgentThemeStore";
import type { IndexedRow, WorkStretch } from "@/apps/agent/components/conversation/work-stretches";
import {
  selectWorkCardOpen,
  useAgentWorkCardStore,
} from "@/apps/agent/store/conversation/useAgentWorkCardStore";

/** Rows the running window keeps mounted. The window shows what fits of them,
 *  up to the open panel's own 55vh (`.agw-wc-window`), so there must be enough
 *  to fill that on a tall screen. At 10, a window of one-line steps stopped at
 *  about 400px however tall its limit was. */
const WINDOW_ROWS = 30;

/** What the card shows under its header. */
type BodyShape = "open" | "window" | "none";

/** Every height glide in the card: the transcript's one glide. */
const GLIDE: KeyframeAnimationOptions = {
  duration: GLIDE_MS,
  easing: GLIDE_EASE_CSS,
};

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
  // Transcript → Work cards → "Group tool calls while working", off by
  // default: while the stretch runs, tool runs are plain rows
  // (`LiveWorkCardContext`), new rows fade in, and the body glides to its
  // newest row. On, the card behaves as before: grouped runs, instant pin.
  const groupRuns = useAgentThemeStore((s) => s.transcriptWorkCardGroupRuns);
  const smoothTools = useAgentThemeStore((s) => s.transcriptSmoothTools);
  const calm = live && !groupRuns;

  // What the body is: the open panel, the running window, or nothing.
  //
  // The window and the panel are ONE element tree that only changes its class
  // and how many rows it holds, keyed by row id. Opening a running card used to
  // swap the window for a separate panel, so every row was thrown away and
  // built again — each rebuilt tool step played its arrival from height 0, all
  // at once, the panel measured its height while they were still closed, and
  // it jumped when they finished (Alvan, 2026-10-16: "laggy", "frame drop",
  // "jump"). Now the newest rows stay mounted through the click, keep their
  // own open/closed state, and only the older ones are added above them.
  const shape: BodyShape = isOpen ? "open" : live ? "window" : "none";
  // A body on its way out stays drawn until it has shrunk to nothing, or the
  // close would blank first and then move everything below it at once. That
  // covers a finished card folding to its header AND the running window when
  // the stretch stops being the live edge (the reply below then glides up
  // instead of landing a whole window higher in one frame).
  const [leaving, setLeaving] = useState<Exclude<BodyShape, "none"> | null>(null);
  const [prevShape, setPrevShape] = useState(shape);
  if (prevShape !== shape) {
    // State adjusted during render (React's pattern for derived state), so the
    // leaving body is still in the DOM in the same commit that ends it.
    setPrevShape(shape);
    setLeaving(shape === "none" && prevShape !== "none" && !reduceMotion ? prevShape : null);
  }
  const shown: BodyShape = shape === "none" ? (leaving ?? "none") : shape;
  const windowMode = shown === "window";

  // Steps mounting because the card redraws them (it first forms, or opens)
  // are not arriving; `ArrivalHoldContext` tells them so. True through the
  // render that mounts them, false again once it has committed.
  const arrivalHold = useRef(true);
  useLayoutEffect(() => {
    arrivalHold.current = false;
  });

  // The body scrolls inside itself. While the stretch runs it follows the
  // newest row, open or not; reopened from history it starts at the first,
  // where reading starts. Pinned from a ResizeObserver on the rows, never
  // after each render: the card re-renders on every streamed word, and rows
  // grow without it rendering at all (text revealing itself, a step opening).
  // The window can't be scrolled by hand, so it never stops following.
  // With the calm motion on, content growth is travelled instead of jumped
  // (the card's own height glides still pin instantly; see the hook).
  const rowsRef = useRef<HTMLDivElement>(null);
  const { ref: bodyRef, onScroll, rearm, compensate } = useFollowBottom(live && shown !== "none", rowsRef, {
    glide: calm && !reduceMotion,
  });

  const windowItems = windowMode ? stretch.items.slice(-WINDOW_ROWS) : stretch.items;

  // The window keeps only its newest rows mounted, so past `WINDOW_ROWS` each
  // new row unmounts the oldest one, out of sight above the view. Nothing
  // moves `scrollTop` for that (`overflow-anchor: none`), so every row on
  // screen jumped up by the removed row's height in one frame, and a glide
  // cannot hide it: the content's total height barely changes. The tops of
  // the first few rows are read each time the first row changes (once per
  // dropped row, never per streamed word); the next drop moves the box up by
  // exactly what left, and the follow carries on to the new row from there.
  const firstWindowId = windowMode ? (windowItems[0]?.row.id ?? null) : null;
  const windowTops = useRef<{ first: string; tops: Map<string, number> } | null>(null);
  useLayoutEffect(() => {
    const rows = rowsRef.current;
    if (!windowMode || !firstWindowId || !rows) {
      windowTops.current = null;
      return;
    }
    const prev = windowTops.current;
    if (prev && prev.first !== firstWindowId) {
      const was = prev.tops.get(prev.first);
      const now = prev.tops.get(firstWindowId);
      if (was !== undefined && now !== undefined) compensate(now - was);
    }
    const tops = new Map<string, number>();
    const children = rows.children;
    for (let i = 0; i < Math.min(6, children.length, windowItems.length); i += 1) {
      tops.set(windowItems[i].row.id, (children[i] as HTMLElement).offsetTop);
    }
    windowTops.current = { first: firstWindowId, tops };
  }, [firstWindowId, windowMode]); // eslint-disable-line react-hooks/exhaustive-deps -- read once per dropped row only

  // New rows fade in where they land while the stretch runs (calm motion,
  // Smooth tool arrival on). Tool rows are left to their steps, which fade
  // themselves (`ToolStep`); a row mounted because the card redrew it (it
  // formed, or opened) is not arriving and stays still (`arrivalHold`).
  const holdingThisRender = arrivalHold.current;
  const seenRows = useRef(new WeakSet<Element>());
  useLayoutEffect(() => {
    const rows = rowsRef.current;
    if (!rows) return;
    const fade =
      calm &&
      smoothTools &&
      !reduceMotion &&
      !holdingThisRender &&
      !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    for (const child of Array.from(rows.children)) {
      if (seenRows.current.has(child)) continue;
      seenRows.current.add(child);
      if (fade && child.getAttribute("data-row") !== "tools" && typeof child.animate === "function") {
        // The tool steps' own fade (`--agw-dur-slow`, `--agw-ease-out`).
        child.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 240, easing: "cubic-bezier(0, 0, 0.2, 1)" });
      }
    }
  });

  // The height glides. Every shape here is as tall as its content, so no
  // stylesheet value can be the target: the height before is read in the
  // click (or known: nothing is 0), the height after once React has committed.
  //   - window <-> open: the scroller itself changes height, and stays on its
  //     newest row every frame, so the steps you were watching stay put under
  //     the header and the panel simply grows or shrinks around them;
  //   - nothing <-> a body: the box around it opens from / closes to 0.
  const animRef = useRef<HTMLDivElement>(null);
  const fromBody = useRef<number | null>(null);

  const toggle = () => {
    if (!reduceMotion && shown !== "none") fromBody.current = bodyRef.current?.offsetHeight ?? null;
    arrivalHold.current = true;
    // Opening a running card lands on the newest step, and closing it goes
    // back to a window that always shows the newest steps, wherever the panel
    // had been scrolled to.
    rearm();
    if (threadId) setOpen(threadId, stretch.id, !isOpen);
    else setDraftOpen((v) => !v);
  };

  const glidedFrom = useRef(shape);
  useLayoutEffect(() => {
    const before = glidedFrom.current;
    glidedFrom.current = shape;
    const outer = animRef.current;
    const body = bodyRef.current;
    const from = fromBody.current;
    fromBody.current = null;
    if (before === shape || reduceMotion || !outer || typeof outer.animate !== "function") return;

    if (before !== "none" && shape !== "none") {
      if (!body || from === null) return;
      for (const running of body.getAnimations()) running.cancel();
      const to = body.offsetHeight;
      if (Math.abs(to - from) < 2) return;
      // The scroller resizes every frame of this, and the follow observer
      // keeps the newest row on its bottom edge each time.
      body.animate(
        [
          { height: `${from}px`, maxHeight: `${from}px` },
          { height: `${to}px`, maxHeight: `${to}px` },
        ],
        GLIDE,
      );
      return;
    }

    // Opening from nothing, or closing to nothing (the leaving body is still
    // drawn). A close interrupted by a reopen starts from wherever the close
    // had got to.
    const closingNow = shape === "none";
    if (closingNow && !leaving) return;
    const running = outer.getAnimations();
    const current = running.length > 0 ? outer.offsetHeight : null;
    for (const anim of running) anim.cancel();
    const start = current ?? (closingNow ? outer.offsetHeight : 0);
    const end = closingNow ? 0 : outer.offsetHeight;
    const glide = outer.animate([{ height: `${start}px` }, { height: `${end}px` }], {
      ...GLIDE,
      fill: "forwards",
    });
    glide.onfinish = () => {
      // A close holds height 0 until React has removed the body (below);
      // an open hands back to the content's own height at once.
      if (closingNow) setLeaving(null);
      else glide.cancel();
    };
  }, [shape]); // eslint-disable-line react-hooks/exhaustive-deps -- the glide runs per shape change only

  // The leaving body is gone; release the held height before the next paint.
  useLayoutEffect(() => {
    if (leaving) return;
    const el = animRef.current;
    if (!el || typeof el.getAnimations !== "function") return;
    for (const held of el.getAnimations()) if (held.playState === "finished") held.cancel();
  }, [leaving]);

  // The running window fades its top edge only when older steps are actually
  // cut off there. A short stretch shows all of its rows, unfaded.
  const [clipped, setClipped] = useState(false);
  useEffect(() => {
    const rows = rowsRef.current;
    const body = bodyRef.current;
    if (!windowMode || !rows || !body || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setClipped(body.scrollHeight > body.clientHeight + 1));
    observer.observe(rows);
    return () => observer.disconnect();
  }, [windowMode, bodyRef]);

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
            {/* Keyed by its text, so each new "now doing" fades in instead of
                snapping the line to a new width. */}
            <span key={nowDoing(stretch)} className="agw-wc-now agw-swap-in">
              {nowDoing(stretch)}
            </span>
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

      {/* The box whose height glides when a body appears or leaves. */}
      <div ref={animRef} className="agw-wc-anim">
        {shown !== "none" && (
          // OPEN: a panel of its own that scrolls inside itself, never the
          // page — opening a 70-step stretch must not put 140 rows back into
          // the transcript, which is the whole thing the card exists to stop
          // (Alvan, 2026-10-12). Every row inside still opens on its own.
          //
          // WINDOW (closed, running): the newest steps, growing down from the
          // header up to the open panel's 55vh, then the oldest leave through a top fade. Not
          // a second way in: a click anywhere on it opens the card. Inert, so
          // keyboard focus never lands on a control clipped half out of view.
          // Same edge as the open panel, so the two read as one thing at two
          // heights — and they ARE one element (see `shape` above).
          <div className="agw-wc-panel">
            <div
              id={bodyId}
              ref={bodyRef}
              className={windowMode ? "agw-wc-body agw-scroll-hair agw-wc-window" : "agw-wc-body agw-scroll-hair"}
              data-clipped={(windowMode && clipped) || undefined}
              // Only a reader scrolling the open panel can stop it following.
              onScroll={windowMode ? undefined : onScroll}
              onClick={windowMode ? toggle : undefined}
              tabIndex={windowMode || leaving ? -1 : 0}
              aria-label={`${stretch.thoughts + stretch.calls} steps`}
              aria-hidden={windowMode || undefined}
            >
              <div ref={rowsRef} className="agw-wc-rows" {...inertWhen(windowMode || leaving !== null)}>
                {/* Rows know they are in the window, so a live thought stays
                    folded to its line instead of filling it with reasoning. */}
                <WorkCardWindowContext.Provider value={windowMode}>
                  <LiveWorkCardContext.Provider value={live}>
                    <ArrivalHoldContext.Provider value={arrivalHold}>
                      {windowItems.map(renderItem)}
                    </ArrivalHoldContext.Provider>
                  </LiveWorkCardContext.Provider>
                </WorkCardWindowContext.Provider>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
