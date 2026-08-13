/**
 * Agent Window — header task indicator [view].
 *
 * The checklist's ONE home. It sits in the conversation header beside the
 * context ring: a glyph, a `closed/total` readout, and a floating card holding
 * the list itself.
 *
 * ## Why it moved here
 *
 * The checklist has now lived in three places. As a card in the transcript it
 * pushed the conversation down every time the agent touched it, and a long run
 * left a trail of stale copies of the same list interleaved with the reply. As
 * a chip under the composer it stopped moving the reading area, but it sat in
 * the writing zone — a readout you consult while the agent works, parked where
 * you go to type.
 *
 * The header is where this window already keeps ambient truth about the running
 * turn (the title, the activity line, context usage). Progress through a task
 * list is exactly that: something you glance at, never something you act on
 * mid-sentence. Putting it next to the context ring also means the two
 * "how is this turn going" readouts live together instead of at opposite ends
 * of the window.
 *
 * ## Hover peeks, click pins
 *
 * A hover-only card is right for the context ring — you read one number and
 * leave. A checklist is read WHILE working, so hover alone would snatch it away
 * the moment you moved toward the transcript. Hovering peeks; clicking pins it
 * open until you click again, click away, or press Escape.
 *
 * ## The spinner never lies
 *
 * The glyph is replaced by a spinner only when a task is `in_progress` AND this
 * conversation is actually streaming. A task left open by a turn that ended is
 * PAUSED — it renders held, not spinning, the same rule `AgentTaskPanel` and
 * the Plan Canvas already apply. Motion here is a claim that work is happening;
 * it has to be true.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { createPortal } from "react-dom";

import { AgentIcon } from "@/apps/agent/shared/AgentIcon";
import { useAgentChatStore } from "@/apps/agent/store/conversation/useAgentChatStore";
import { useAgentTaskStore } from "@/apps/agent/store/tools/useAgentTaskStore";
import { AgentTaskPanel } from "@/apps/agent/components/panels/AgentTaskPanel";

export const TaskIndicator: React.FC = () => {
  const currentThreadId = useAgentChatStore((s) => s.currentThreadId);
  const tasks = useAgentTaskStore((s) =>
    currentThreadId ? s.byThread[currentThreadId] : undefined,
  );
  // Liveness of THIS conversation — the only thing that entitles the indicator
  // to move. See the module note.
  const isStreaming = useAgentChatStore((s) =>
    currentThreadId ? !!s.liveTurns[currentThreadId] : false,
  );

  // `pinned` survives mouse-leave; `peeking` does not; `flashing` is the card
  // showing itself when the agent touches the list. Open is any of the three.
  const [pinned, setPinned] = useState(false);
  const [peeking, setPeeking] = useState(false);
  const [flashing, setFlashing] = useState(false);
  const open = pinned || peeking || flashing;
  // This card is the only popover in the window that can open with nobody
  // touching it — the agent editing the list shows it. A menu that appears
  // under the cursor you just clicked with should be quick; a panel that
  // appears on its own at the same speed reads as a flicker in the corner of
  // your eye. So the self-opening reveal gets its own, slower curve, and the
  // hover/click paths keep the house tween the other menus use.
  const selfOpened = flashing && !pinned && !peeking;
  const reduceMotion = useReducedMotion();

  // The card is portaled and sits 8px below the trigger, so travelling from one
  // to the other crosses a gap that belongs to neither. Closing on the raw
  // mouse-leave would tear the card away mid-reach every time. A short grace
  // period after leaving lets the pointer arrive; entering either element
  // cancels it.
  const closeTimer = useRef<number | null>(null);
  const cancelClose = useCallback(() => {
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  }, []);
  const openPeek = useCallback(() => {
    cancelClose();
    setPeeking(true);
  }, [cancelClose]);
  const closePeekSoon = useCallback(() => {
    cancelClose();
    closeTimer.current = window.setTimeout(() => setPeeking(false), 140);
  }, [cancelClose]);
  useEffect(() => cancelClose, [cancelClose]);

  const triggerRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ right: number; top: number } | null>(null);
  // Portal INTO `.agw-root`, not document.body, so the `--agw-*` tokens
  // cascade — otherwise the card's surface colour resolves to nothing and it
  // renders transparent. Same reason the context card does it.
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);

  const attachRoot = useCallback((el: HTMLDivElement | null) => {
    triggerRef.current = el;
    if (el) setPortalTarget((el.closest(".agw-root") as HTMLElement) ?? document.body);
  }, []);

  const place = useCallback(() => {
    const r = triggerRef.current?.getBoundingClientRect();
    if (!r) return;
    const top = r.bottom + 8;
    const right = Math.max(8, window.innerWidth - r.right);
    // Bail when nothing moved. `place()` is wired to the capturing `scroll`
    // listener, so it runs for every scroll frame in the window — including the
    // transcript, which does not move the header at all. Handing back a fresh
    // object each time re-rendered the card (and re-measured its layout
    // animation) on a gesture that changed nothing.
    setPos((prev) => (prev && prev.top === top && prev.right === right ? prev : { top, right }));
  }, []);

  /**
   * The card shows itself for a few seconds whenever the agent changes the
   * list, then goes away again.
   *
   * A checklist that only moves behind a closed dropdown may as well not have
   * moved — you would have to already suspect something happened and go
   * looking. This is the same job the transcript beat does for the reply, except
   * it lands on the list itself, so the list never has to be drawn twice.
   *
   * Driven by a store SUBSCRIPTION, not an effect watching `tasks`, because
   * "the list changed" is an event rather than a render. Comparing values
   * during render cannot tell a real change from a mount, a thread switch, or
   * reopening an old conversation — none of which are the agent doing
   * something now.
   */
  const flashTimer = useRef<number | null>(null);
  useEffect(() => {
    if (!currentThreadId) return;
    const unsubscribe = useAgentTaskStore.subscribe((state, previous) => {
      const next = state.byThread[currentThreadId];
      if (next === previous.byThread[currentThreadId]) return;
      if (!next || next.length === 0) return;
      // Placement happens here for the same reason it happens in the pointer
      // handlers: the card is portaled and fixed, so it needs the trigger's
      // box before it can be shown at all.
      place();
      setFlashing(true);
      if (flashTimer.current !== null) window.clearTimeout(flashTimer.current);
      // Long enough to read a five-item list, short enough to never be in the
      // way. A hover or a pin outlives it — `open` is an OR, so this timer
      // ending can never close a card the user is holding open.
      flashTimer.current = window.setTimeout(() => setFlashing(false), 3500);
    });
    return () => {
      unsubscribe();
      if (flashTimer.current !== null) {
        window.clearTimeout(flashTimer.current);
        flashTimer.current = null;
      }
    };
  }, [currentThreadId, place]);

  useEffect(() => {
    if (!open) return;
    const onMove = () => place();
    window.addEventListener("scroll", onMove, true);
    window.addEventListener("resize", onMove);
    return () => {
      window.removeEventListener("scroll", onMove, true);
      window.removeEventListener("resize", onMove);
    };
  }, [open, place]);

  // Dismissal for the PINNED state only — a peek closes itself on mouse-leave.
  // Pointerdown rather than click so dragging out of the card still closes it,
  // and capture so a row inside cannot swallow the event.
  // Also armed while the card is flashing itself open: an auto-reveal the user
  // cannot dismiss is worse than no reveal at all.
  useEffect(() => {
    if (!pinned && !flashing) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target)) return;
      if ((target as HTMLElement).closest?.(".agw-taskpop")) return;
      setPinned(false);
      setFlashing(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setPinned(false);
        setPeeking(false);
        setFlashing(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [pinned, flashing]);

  const { closed, total, active, allDone } = useMemo(() => {
    const list = tasks ?? [];
    return {
      // CLOSED, not completed — a cancelled task is not outstanding work. The
      // panel and Rust's own progress line count the same way, and two numbers
      // for one list on one screen is a bug.
      closed: list.filter(
        (t) => t.status === "completed" || t.status === "cancelled",
      ).length,
      total: list.length,
      active: list.find((t) => t.status === "in_progress"),
      allDone:
        list.length > 0 &&
        list.every((t) => t.status === "completed" || t.status === "cancelled"),
    };
  }, [tasks]);

  // Nothing tracked, nothing to say. The header stays quiet rather than
  // showing an empty checklist affordance for a one-line change.
  if (!tasks || tasks.length === 0) return null;

  const running = !!active && isStreaming;
  const paused = !!active && !isStreaming;
  const state = allDone ? "done" : running ? "running" : paused ? "paused" : "idle";

  // The accessible name carries the whole readout, because the glyph and the
  // ratio are two halves of one sentence a screen reader would otherwise get
  // as fragments. A paused task is named in the imperative — the present
  // continuous would claim work is under way.
  const label = allDone
    ? `Tasks complete — ${closed} of ${total}`
    : running
      ? `${active.content} — ${closed} of ${total} done`
      : paused
        ? `Paused — ${active.originalContent ?? active.content}, ${closed} of ${total} done`
        : `Tasks — ${closed} of ${total} done`;

  return (
    <div
      ref={attachRoot}
      className="agw-taskind-wrap"
      onMouseEnter={() => {
        place();
        openPeek();
      }}
      onMouseLeave={closePeekSoon}
    >
      <button
        type="button"
        className="agw-taskind"
        data-state={state}
        data-open={open || undefined}
        aria-expanded={open}
        aria-label={label}
        title={label}
        onFocus={() => {
          place();
          openPeek();
        }}
        onBlur={closePeekSoon}
        onClick={() => {
          place();
          setPinned((v) => !v);
        }}
      >
        {running ? (
          <span className="agw-rail-spin agw-taskind-spin" aria-hidden />
        ) : (
          <AgentIcon name={allDone ? "check" : "checklist"} size={13} />
        )}
        <span className="agw-taskind-count">
          {closed}/{total}
        </span>
      </button>

      {portalTarget &&
        pos &&
        createPortal(
          <AnimatePresence>
            {open && (
              <motion.div
                // `layout` so the card RESIZES instead of jumping when the
                // agent adds a row, ticks one off, or swaps the heading to a
                // longer task. Those edits land while you are reading it, and a
                // panel that changes height between two frames is the thing
                // that reads as unfinished. Safe against the scroll listener
                // because `place()` no longer hands back a new position for a
                // scroll that did not move the header.
                layout
                className="agw-menu agw-taskpop"
                style={{
                  position: "fixed",
                  top: pos.top,
                  right: pos.right,
                  zIndex: 12000,
                  // It belongs to the indicator above it, so it grows out of
                  // that corner rather than swelling from its own middle.
                  transformOrigin: "top right",
                }}
                initial={{ opacity: 0, scale: 0.98, y: -6 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{
                  opacity: 0,
                  scale: 0.98,
                  y: -4,
                  // Leaving is always quicker than arriving, on an
                  // accelerating curve — the panel gets out of the way rather
                  // than easing to a stop on its way out.
                  transition: { duration: reduceMotion ? 0 : 0.14, ease: [0.4, 0, 1, 1] },
                }}
                transition={
                  reduceMotion
                    ? { duration: 0 }
                    : selfOpened
                      ? // Unprompted: longer, and decelerating the whole way in.
                        { duration: 0.26, ease: [0, 0, 0.2, 1] }
                      : // Answering a hover or a click: the house tween the
                        // model menu and the rail popovers use.
                        { duration: 0.16, ease: [0.16, 1, 0.3, 1] }
                }
                // A peek must survive the pointer travelling from trigger to
                // card, and reading the list inside it.
                onMouseEnter={openPeek}
                onMouseLeave={closePeekSoon}
              >
                <AgentTaskPanel />
              </motion.div>
            )}
          </AnimatePresence>,
          portalTarget,
        )}
    </div>
  );
};
