/**
 * Agent Window — the work card [view].
 *
 * Transcript → Work cards (opt-in). One per turn: a header line and, under it,
 * the turn's work. Which rows are work is decided by `splitTurn`; this only
 * draws them. Rebuilt from the ground up on 2026-10-25 after a week of fixes to
 * the card before it (`WorkCard`, 2026-10-12 → 10-24). What is different, and
 * why each piece exists:
 *
 *   - FOUR STATES, changed only by a click or by the turn ending: running and
 *     closed (the newest steps in a window, a click opens it), running and
 *     open, finished and closed (the header alone), finished and open. No
 *     state is derived from where the card sits among the rows.
 *
 *   - ONE NORMAL SCROLLER, and nothing that changes how its text is drawn
 *     while it is on screen (`pin.ts`, rebuilt 2026-10-27). Following the
 *     newest row is one scroll write per growth plus a glide on whole device
 *     pixels; a step the reader opens grows down like anywhere else on the
 *     page. The reversed scroller and the on/off fractional transform that
 *     came before kept the rows shimmering sideways.
 *
 *   - EVERY ROW STAYS MOUNTED, under one key per row, in one tree, for the
 *     card's whole life. Nothing is rebuilt by opening, closing or the turn
 *     ending, so nothing replays its arrival and no open step closes.
 *
 *   - ONE HEIGHT CHANGE: the box under the header glides between nothing and
 *     the body (a grid row 0fr ↔ 1fr), only after a click or when a finished
 *     turn folds. A card saved open simply is open when the chat is reopened.
 *
 * Open state is saved with the conversation (`useAgentWorkCardStore`), keyed
 * by the turn's first tool call.
 */

import React, { useEffect, useId, useLayoutEffect, useRef, useState } from "react";

import { inertWhen } from "@/kernel/lib/a11y/inert";
import { AgentIcon } from "@/apps/agent/shared/AgentIcon";
import { formatWorkedDuration } from "@/apps/agent/components/conversation/timeline";
import { nowDoing, tallyLine } from "@/apps/agent/components/conversation/work-log/header-text";
import { attachPin, type GlideConfig, type Pin } from "@/apps/agent/components/conversation/work-log/pin";
import type { IndexedRow, WorkTally } from "@/apps/agent/components/conversation/work-log/split-turn";
import { GLIDE_MS } from "@/apps/agent/lib/motion/glide";
import { useAgentThemeStore } from "@/apps/agent/store/ui/useAgentThemeStore";
import {
  selectWorkCardOpen,
  useAgentWorkCardStore,
} from "@/apps/agent/store/conversation/useAgentWorkCardStore";

/** Where the box under the header is. `opening`/`closing` exist only while it glides. */
type Phase = "closed" | "opening" | "open" | "closing";

/** A clock that ticks once a second; its own component so the tick re-renders three words. */
const Ticking: React.FC<{ since: number }> = ({ since }) => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  return <>{formatWorkedDuration(Math.max(0, now - since))}</>;
};

export const WorkLog: React.FC<{
  work: IndexedRow[];
  tally: WorkTally;
  /** The turn is still running. */
  running: boolean;
  /** Nothing in the turn follows the card (no rail below it). */
  isLast: boolean;
  /** The conversation the card belongs to; `null` for an unsaved draft. */
  threadId: string | null;
  /** When the turn began (epoch ms): the clock's start when no step has one. */
  turnStartedAt?: number;
  /** Draws one row as the transcript does, in its turn-wide wrapper, in card form. */
  renderItem: (item: IndexedRow) => React.ReactNode;
}> = ({ work, tally, running, isLast, threadId, turnStartedAt, renderItem }) => {
  const bodyId = useId();
  const cardId = tally.firstCallId;

  // Open: the reader's choice. Saved per conversation once the card has an id
  // (its first call); before that, and in a draft, it is held here.
  const hydrate = useAgentWorkCardStore((s) => s.hydrate);
  const setStored = useAgentWorkCardStore((s) => s.setOpen);
  const stored = useAgentWorkCardStore(selectWorkCardOpen(threadId, cardId ?? ""));
  const [localOpen, setLocalOpen] = useState<boolean | null>(null);
  const isOpen = localOpen ?? (cardId !== null && stored);
  useEffect(() => {
    if (threadId) void hydrate(threadId);
  }, [threadId, hydrate]);

  const reduceMotion = useAgentThemeStore((s) => s.reduceMotion);
  const smoothTools = useAgentThemeStore((s) => s.transcriptSmoothTools);

  // ── The box under the header ───────────────────────────────────────────
  // Shown while the turn runs (closed = the window) or while open. It glides
  // only for a click and for a finished turn folding; anything else (a saved
  // card read from disk, the first draw) is simply in its place.
  const wanted = running || isOpen;
  // A click asks for the next change to glide (set with the click itself);
  // the turn ending asks in the render it ends in.
  const [clickGlide, setClickGlide] = useState(false);
  const [box, setBox] = useState<{ phase: Phase; glide: boolean }>(() => ({
    phase: wanted ? "open" : "closed",
    glide: false,
  }));
  const [wasRunning, setWasRunning] = useState(running);
  const turnJustEnded = wasRunning && !running;
  if (wasRunning !== running) setWasRunning(running);
  const settled = box.phase === "open" || box.phase === "opening";
  if (wanted !== settled) {
    // State adjusted during render (React's pattern for derived state).
    const glide = (clickGlide || turnJustEnded) && !reduceMotion;
    if (clickGlide) setClickGlide(false);
    setBox({ phase: wanted ? (glide ? "opening" : "open") : glide ? "closing" : "closed", glide });
  }
  // `opening` is drawn once at 0fr so the change to 1fr is a transition.
  useEffect(() => {
    if (box.phase !== "opening") return;
    const id = window.requestAnimationFrame(() => setBox({ phase: "open", glide: true }));
    return () => window.cancelAnimationFrame(id);
  }, [box.phase]);
  // `closing` ends when the glide does; the timer is the backstop for a
  // transition that never reports (the card scrolled out of the document).
  useEffect(() => {
    if (box.phase !== "closing") return;
    const id = window.setTimeout(() => setBox({ phase: "closed", glide: false }), GLIDE_MS + 120);
    return () => window.clearTimeout(id);
  }, [box.phase]);
  const mounted = box.phase !== "closed";
  const expanded = box.phase === "open";
  const windowMode = running && !isOpen;

  // ── Scrolling ───────────────────────────────────────────────────────────
  // `pin.ts`: while the turn runs the rows are placed by one transform moved
  // by one controller (no native scrolling to get out of step with it); once
  // the turn ends the body is a normal scroller. Rebuilt 2026-10-27 on the
  // model of Alvan's `scroll-fix.html`.
  const bodyRef = useRef<HTMLDivElement>(null);
  const rowsRef = useRef<HTMLDivElement>(null);
  const pinRef = useRef<Pin | null>(null);
  const runningRef = useRef(running);
  useLayoutEffect(() => {
    runningRef.current = running;
  }, [running]);

  // The rows glide up as steps arrive (Transcript → Work card scrolling: off,
  // or how long). Only while motion is allowed; read live by the pin, so
  // changing it needs no re-attach.
  const glideStyle = useAgentThemeStore((s) => s.transcriptWorkCardGlide);
  const glideMs = useAgentThemeStore((s) => s.transcriptWorkCardGlideMs);
  const glideConfig = useRef<GlideConfig>({ on: false, style: glideStyle, ms: glideMs });
  useLayoutEffect(() => {
    glideConfig.current = {
      on: running && !reduceMotion && glideStyle !== "off",
      style: glideStyle,
      ms: glideMs,
    };
  }, [running, reduceMotion, glideStyle, glideMs]);

  // A body that has just been drawn starts at the newest row (running) or the
  // first (finished).
  useLayoutEffect(() => {
    const body = bodyRef.current;
    const rows = rowsRef.current;
    if (!mounted || !body || !rows) return;
    const pin = attachPin(body, rows, { running: runningRef.current }, { glide: () => glideConfig.current });
    pinRef.current = pin;
    return () => {
      pin.dispose();
      pinRef.current = null;
    };
  }, [mounted]);
  // The turn ending turns the body into a normal scroller where the rows are,
  // so what the reader was watching stays put.
  useLayoutEffect(() => {
    if (!running) pinRef.current?.release();
  }, [running]);
  // The reader clicking (or pressing Enter on) a row inside the open body
  // takes over: the step they open grows down and nothing pulls the view.
  const takeOver = (target: EventTarget | null) => {
    const el = (target as Element | null)?.closest?.(".agw-wc-rows");
    if (el) pinRef.current?.setFollowing(false);
  };

  const toggle = () => {
    const next = !isOpen;
    // While it runs the body is there either way (window or open): no height change.
    setClickGlide(!running);
    setLocalOpen(next);
    if (threadId && cardId) setStored(threadId, cardId, next);
  };

  const since = tally.startedAt ?? turnStartedAt;
  const workedMs =
    tally.startedAt !== undefined && tally.endedAt !== undefined ? tally.endedAt - tally.startedAt : null;
  const doing = running ? nowDoing(work) : "";
  const tallyText = tallyLine(tally);

  return (
    <div
      className="agw-row agw-wc"
      data-row="work"
      data-open={isOpen || undefined}
      data-running={running || undefined}
      data-last={isLast || undefined}
      data-live={running || undefined}
      // New steps fade in only with Smooth tool arrival on and motion allowed.
      data-arrivals={(smoothTools && !reduceMotion) || undefined}
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
          {running ? <span className="agw-spinner" /> : <span className="agw-wc-done" />}
        </span>
        {running ? (
          <>
            <span className="agw-wc-what agw-shimmer">Working</span>
            {/* Keyed by its text, so each new "now doing" fades in instead of
                snapping the line to a new width. */}
            <span key={doing} className="agw-wc-now agw-swap-in">
              {doing}
            </span>
            <span className="agw-wc-count">
              {tallyText}
              {since !== undefined && (
                <>
                  {tallyText ? " · " : ""}
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
            <span className="agw-wc-now">{tallyText}</span>
          </>
        )}
        <AgentIcon name="chevron-right" size={13} className="agw-wc-chev" />
      </button>

      <div
        className="agw-wc-anim"
        data-expanded={expanded || undefined}
        data-glide={box.glide || undefined}
        onTransitionEnd={(e) => {
          if (e.target === e.currentTarget && box.phase === "closing") setBox({ phase: "closed", glide: false });
        }}
      >
        <div className="agw-wc-clip">
          {mounted && (
            <div className="agw-wc-panel">
              <div
                id={bodyId}
                ref={bodyRef}
                className="agw-wc-body agw-scroll-hair"
                data-window={windowMode || undefined}
                // Closed and running: the whole window is a way to open the
                // card, like the header; its rows are not controls yet.
                onClick={windowMode ? toggle : undefined}
                onPointerDownCapture={windowMode ? undefined : (e) => takeOver(e.target)}
                onKeyDownCapture={
                  windowMode
                    ? undefined
                    : (e) => {
                        if (e.key === "Enter" || e.key === " ") takeOver(e.target);
                      }
                }
                tabIndex={windowMode ? -1 : 0}
                aria-label={`${tally.thoughts + tally.calls} steps`}
                aria-hidden={windowMode || undefined}
              >
                <div ref={rowsRef} className="agw-wc-rows" {...inertWhen(windowMode)}>
                  {work.map(renderItem)}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
