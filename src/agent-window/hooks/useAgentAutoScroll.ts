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
 *     we stop chasing and surface a "jump to latest" affordance (`showJump`);
 *   - we only chase while `isStreaming` — when idle, expanding a tool/thinking
 *     card must never yank the viewport;
 *   - thread switch (`resetKey`) snaps instantly; a new message (`growthKey`)
 *     glides down only if the user was already at the bottom.
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
  const [showJump, setShowJump] = useState(false);

  const cancelFollow = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, []);

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
      if (behavior === "auto") {
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

    const onScroll = () => {
      refreshNearBottom();
      if (!nearBottomRef.current) {
        cancelFollow();
        // The reader deliberately left the bottom — abandon the entry anchor so
        // late layout growth doesn't yank them back down.
        initialAnchorRef.current = false;
      }
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [cancelFollow, refreshNearBottom, resetKey]);

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
      if (!grew || !nearBottomRef.current) return;
      if (initialAnchorRef.current) {
        // Entry window: pin instantly to the freshly-laid-out bottom (works
        // even when idle — an already-finished team run isn't "streaming").
        el.scrollTop = el.scrollHeight;
      } else if (isStreaming) {
        follow();
      }
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, [follow, isStreaming, resetKey]);

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
    const timer = window.setTimeout(() => {
      initialAnchorRef.current = false;
    }, 800);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(timer);
    };
  }, [resetKey]);

  // New message boundary → glide down, but only if the reader was at the bottom
  // (respects a scrolled-up reader; the pill stays available for them).
  useEffect(() => {
    if (nearBottomRef.current) jumpToBottom("auto");
  }, [growthKey, jumpToBottom]);

  useEffect(() => cancelFollow, [cancelFollow]);

  return { containerRef, contentRef, bottomRef, showJump, jumpToBottom };
}

export default useAgentAutoScroll;
