/**
 * Agent Window — transcript auto-scroll [hook].
 *
 * A DEDICATED, isolated auto-scroll for the agent window (it does NOT import the
 * IDE's `useSmoothAutoScroll` — the agent window is self-contained). It fixes the
 * two problems with the old `scrollTop = scrollHeight` effect:
 *
 *   1. It followed only `message.content.length`, so while the model was THINKING
 *      or running TOOLS (which grow the transcript without touching `content`),
 *      nothing scrolled and the new output slid below the composer.
 *   2. It hard-jumped on every change — never smooth.
 *
 * How it works (mirrors the IDE's proven core, refined):
 *   - a `ResizeObserver` on the CONTENT element catches every height change
 *     (text, reasoning, tool cards, expansions) — the real source of growth;
 *   - growth is followed with a `requestAnimationFrame` lerp so the viewport
 *     glides to the bottom instead of snapping;
 *   - following is gated on "near bottom": once the user scrolls up to read,
 *     we stop chasing and surface a "jump to latest" affordance (`showJump`,
 *     rendered by `components/JumpToLatest`);
 *   - we only chase while `isStreaming` — when idle, expanding a tool/thinking
 *     card must never yank the viewport;
 *   - thread switch (`resetKey`) snaps instantly; a new message (`growthKey`)
 *     glides down only if the user was already at the bottom.
 *
 * THE CENTRAL RULE, learned the hard way: **a `scroll` event is not reader
 * intent.** This hook scrolls constantly — the follow lerp emits an event every
 * frame, the entry anchor emits one per re-pin — so a listener that stops
 * chasing whenever `scroll` fires is really stopping because of itself. That
 * produced two visible bugs: "jump to latest" advanced only ~25% per click
 * (the loop cancelled itself one frame in), and a freshly-opened thread was
 * left stranded above the newest message. Reader intent is therefore read from
 * INPUT events — wheel, touch, a press on the scrollbar gutter, navigation
 * keys — while `scroll` is used only to observe position.
 *
 * The entry anchor is a QUIET PERIOD, not a fixed delay: opening a thread
 * re-pins to the bottom until the transcript has held still for
 * `ANCHOR_QUIET_MS`. Messages arrive async and markdown, syntax highlighting
 * and images each grow the view again well after mount, so a fixed window
 * expires mid-layout on exactly the long conversations that need it most.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

interface AgentAutoScrollOptions {
  /** True while a turn is streaming — the only time we chase growth. */
  isStreaming: boolean;
  /** Changes when the open thread changes → instant snap to bottom. */
  resetKey?: string | null;
  /** Changes when a message is added/removed → glide down if at bottom. */
  growthKey?: number;
  /** Distance (px) from the bottom still considered "at the bottom". */
  bottomThreshold?: number;
  /** Per-frame approach fraction (0–1). Higher = snappier, lower = floatier. */
  followLerp?: number;
}

interface AgentAutoScrollResult {
  containerRef: React.RefObject<HTMLDivElement>;
  contentRef: React.RefObject<HTMLDivElement>;
  bottomRef: React.RefObject<HTMLDivElement>;
  /** True when the user has scrolled away from the bottom (show the pill). */
  showJump: boolean;
  /** Scroll to the newest content; smooth by default. */
  jumpToBottom: (behavior?: ScrollBehavior) => void;
}

const DEFAULT_BOTTOM_THRESHOLD = 140;
const DEFAULT_FOLLOW_LERP = 0.25;

/**
 * How long the transcript height must hold STILL before the entry anchor is
 * released. Restarted on every anchored growth, so opening a thread stays
 * pinned to the bottom for as long as content is actually still arriving —
 * messages load async, then markdown, syntax highlighting and images each grow
 * the transcript again well after mount.
 */
const ANCHOR_QUIET_MS = 400;

/**
 * Hard ceiling on the entry anchor regardless of quiet time, so a view that
 * never stops growing (a stream that begins the moment a thread opens) cannot
 * hold the reader at the bottom forever.
 */
const ANCHOR_MAX_MS = 10_000;

/** Keys that scroll a focused container — pressing one is reader intent. */
const SCROLL_KEYS = new Set([
  "ArrowUp",
  "ArrowDown",
  "PageUp",
  "PageDown",
  "Home",
  "End",
  " ",
]);

/**
 * Should an explicit "go to the bottom" snap instead of gliding?
 *
 * Past a few screens a glide is not continuity — it is a long wait through
 * content nobody is reading, and the reader asked to *be* at the bottom rather
 * than to travel there. Exported so the threshold is testable without a layout
 * engine.
 */
export function shouldSnapToBottom(
  distance: number,
  viewportHeight: number,
): boolean {
  if (viewportHeight <= 0) return true;
  return distance > viewportHeight * 3;
}

export function useAgentAutoScroll(
  options: AgentAutoScrollOptions,
): AgentAutoScrollResult {
  const {
    isStreaming,
    resetKey = null,
    growthKey = 0,
    bottomThreshold = DEFAULT_BOTTOM_THRESHOLD,
    followLerp = DEFAULT_FOLLOW_LERP,
  } = options;

  const containerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const nearBottomRef = useRef(true);
  const prevHeightRef = useRef(0);
  const rafRef = useRef<number | null>(null);
  // True during the brief "entry" window after a reset (opening a view / thread
  // switch): while set, any content growth HARD-pins to the bottom even when
  // idle, so async markdown / syntax-highlight / image layout that grows the
  // transcript right after mount can't strand the reader above the last message.
  const initialAnchorRef = useRef(false);
  const anchorQuietTimerRef = useRef<number | null>(null);
  const anchorMaxTimerRef = useRef<number | null>(null);
  const [showJump, setShowJump] = useState(false);

  const cancelFollow = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, []);

  /** End the entry anchor and drop both of its timers. */
  const releaseAnchor = useCallback(() => {
    initialAnchorRef.current = false;
    if (anchorQuietTimerRef.current !== null) {
      window.clearTimeout(anchorQuietTimerRef.current);
      anchorQuietTimerRef.current = null;
    }
    if (anchorMaxTimerRef.current !== null) {
      window.clearTimeout(anchorMaxTimerRef.current);
      anchorMaxTimerRef.current = null;
    }
  }, []);

  /**
   * (Re)start the quiet countdown. Called after every anchored re-pin, so the
   * window measures "the transcript has stopped growing" rather than "some
   * fixed time has passed since the thread opened" — the latter gave up while
   * a long conversation was still laying itself out.
   */
  const armAnchorQuiet = useCallback(() => {
    if (anchorQuietTimerRef.current !== null) {
      window.clearTimeout(anchorQuietTimerRef.current);
    }
    anchorQuietTimerRef.current = window.setTimeout(() => {
      anchorQuietTimerRef.current = null;
      releaseAnchor();
    }, ANCHOR_QUIET_MS);
  }, [releaseAnchor]);

  const distanceFromBottom = (el: HTMLDivElement): number =>
    el.scrollHeight - (el.scrollTop + el.clientHeight);

  // Runs only from the scroll event listener (an event callback — never an
  // effect body), so toggling React state here is safe. The pill's mid-stream
  // gating lives in the component (`showJump && sending`).
  const refreshNearBottom = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const near = distanceFromBottom(el) <= bottomThreshold;
    nearBottomRef.current = near;
    setShowJump(!near);
  }, [bottomThreshold]);

  /**
   * Glide the viewport toward the bottom. Idempotent: while a follow loop is
   * already running, each `step` reads the LATEST `scrollHeight`, so repeated
   * calls during fast streaming just keep the same loop converging.
   */
  const follow = useCallback(() => {
    if (rafRef.current !== null) return;
    const step = () => {
      const el = containerRef.current;
      if (!el) {
        rafRef.current = null;
        return;
      }
      const target = el.scrollHeight - el.clientHeight;
      const delta = target - el.scrollTop;
      if (Math.abs(delta) <= 1) {
        el.scrollTop = target;
        rafRef.current = null;
        return;
      }
      el.scrollTop += delta * followLerp;
      rafRef.current = requestAnimationFrame(step);
    };
    rafRef.current = requestAnimationFrame(step);
  }, [followLerp]);

  const jumpToBottom = useCallback(
    (behavior: ScrollBehavior = "smooth") => {
      const el = containerRef.current;
      cancelFollow();
      nearBottomRef.current = true;
      if (!el) return;

      const distance = distanceFromBottom(el);
      if (behavior === "auto" || shouldSnapToBottom(distance, el.clientHeight)) {
        // No setState here on purpose: `jumpToBottom` is called from effects as
        // well as from the pill, and the resulting scroll event already
        // reconciles `showJump` through `refreshNearBottom`.
        el.scrollTop = el.scrollHeight;
        return;
      }
      // Smooth glide via our lerp (consistent feel with streaming follow). The
      // resulting scroll events reconcile `showJump` back to false.
      follow();
    },
    [cancelFollow, follow],
  );

  // Track the user's position; stop chasing the moment they scroll up. Depends
  // on `resetKey` so the listener re-attaches when the scroll container mounts
  // AFTER the hook (e.g. the team view renders its scroller only once the
  // snapshot is ready — the listener would otherwise never bind).
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    prevHeightRef.current = el.scrollHeight;

    // OBSERVATIONAL ONLY. A `scroll` event does not say who scrolled, and this
    // hook is itself a prolific scroller — the follow lerp emits one per frame
    // and the entry anchor emits one per re-pin. Cancelling on `scroll` (as
    // this listener used to) meant the follow loop killed itself one frame in,
    // so "jump to latest" advanced ~25% per click, and the entry anchor was
    // dropped by its own anchoring scroll. Reader intent is detected from the
    // INPUT events below instead.
    const onScroll = () => refreshNearBottom();

    // The reader took over: stop chasing, and stop re-pinning to the bottom.
    const onUserIntent = () => {
      cancelFollow();
      releaseAnchor();
      refreshNearBottom();
    };

    // A press only counts when it lands on the scrollbar gutter. Clicking
    // inside the transcript — expanding a tool card, selecting text — is not
    // scroll intent and must never stop a streaming turn from following.
    const onPointerDown = (event: PointerEvent) => {
      if (event.offsetX <= el.clientWidth) return;
      onUserIntent();
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (SCROLL_KEYS.has(event.key)) onUserIntent();
    };

    el.addEventListener("scroll", onScroll, { passive: true });
    el.addEventListener("wheel", onUserIntent, { passive: true });
    el.addEventListener("touchstart", onUserIntent, { passive: true });
    el.addEventListener("pointerdown", onPointerDown, { passive: true });
    el.addEventListener("keydown", onKeyDown);
    return () => {
      el.removeEventListener("scroll", onScroll);
      el.removeEventListener("wheel", onUserIntent);
      el.removeEventListener("touchstart", onUserIntent);
      el.removeEventListener("pointerdown", onPointerDown);
      el.removeEventListener("keydown", onKeyDown);
    };
  }, [cancelFollow, refreshNearBottom, releaseAnchor, resetKey]);

  // The real growth detector: any content height change at the bottom follows
  // the new content. `resetKey` is a dep so the observer re-binds to a scroller
  // mounted after the hook (conditional team scroller).
  useEffect(() => {
    const el = containerRef.current;
    const content = contentRef.current;
    if (!el || !content) return;
    prevHeightRef.current = el.scrollHeight;

    const observer = new ResizeObserver(() => {
      const height = el.scrollHeight;
      const grew = height > prevHeightRef.current;
      prevHeightRef.current = height;
      if (!grew) return;

      // Entry window: pin instantly to the freshly-laid-out bottom (works even
      // when idle — a thread being restored from disk isn't "streaming"), and
      // restart the quiet countdown because content is evidently still
      // arriving. Deliberately NOT gated on `nearBottomRef`: this growth is
      // exactly what pushes the bottom away, and reading a stale "not near
      // bottom" here is what left a freshly-opened thread stranded mid-way.
      // Reader input releases the anchor, so this cannot fight a real scroll.
      if (initialAnchorRef.current) {
        el.scrollTop = el.scrollHeight;
        armAnchorQuiet();
        return;
      }

      if (!nearBottomRef.current) return;
      if (isStreaming) follow();
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, [armAnchorQuiet, follow, isStreaming, resetKey]);

  // Streaming start (already at bottom) → begin following; stop → cancel and
  // settle exactly at the bottom (so a glide cut short at stream-end doesn't
  // leave the last line a few px under the fold). Only if still at the bottom.
  useEffect(() => {
    if (!isStreaming) {
      cancelFollow();
      if (nearBottomRef.current) {
        const el = containerRef.current;
        if (el) el.scrollTop = el.scrollHeight;
      }
      return;
    }
    if (nearBottomRef.current) follow();
    return cancelFollow;
  }, [cancelFollow, follow, isStreaming]);

  // View/thread switch → land at the bottom with NO visible jump. A layout
  // effect runs after DOM mutation but BEFORE paint, so setting `scrollTop`
  // here means the reader never sees the top-of-list flash the old post-paint
  // `useEffect` produced. The `initialAnchor` window then keeps re-pinning
  // through async content growth (markdown/highlight) for a short settle time.
  useLayoutEffect(() => {
    nearBottomRef.current = true;
    initialAnchorRef.current = true;
    const el = containerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    // Hide the "jump to latest" pill on the next frame (we just anchored to the
    // bottom) — deferred so it isn't a synchronous setState inside the effect.
    const raf = requestAnimationFrame(() => setShowJump(false));

    // Two timers, different jobs: the quiet one (restarted on every anchored
    // re-pin) ends the anchor once the transcript stops growing, and this hard
    // cap guarantees it ends regardless.
    armAnchorQuiet();
    if (anchorMaxTimerRef.current !== null) {
      window.clearTimeout(anchorMaxTimerRef.current);
    }
    anchorMaxTimerRef.current = window.setTimeout(() => {
      anchorMaxTimerRef.current = null;
      releaseAnchor();
    }, ANCHOR_MAX_MS);

    return () => {
      cancelAnimationFrame(raf);
      releaseAnchor();
    };
  }, [armAnchorQuiet, releaseAnchor, resetKey]);

  // New message boundary → glide down, but only if the reader was at the bottom
  // (respects a scrolled-up reader; the pill stays available for them).
  useEffect(() => {
    if (nearBottomRef.current) jumpToBottom("auto");
  }, [growthKey, jumpToBottom]);

  useEffect(
    () => () => {
      cancelFollow();
      releaseAnchor();
    },
    [cancelFollow, releaseAnchor],
  );

  return { containerRef, contentRef, bottomRef, showJump, jumpToBottom };
}

export default useAgentAutoScroll;
