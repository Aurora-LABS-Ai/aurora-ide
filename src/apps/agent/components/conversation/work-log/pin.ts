/**
 * Agent Window — how a work card's body moves while its turn runs [helper].
 *
 * Rebuilt 2026-10-27 on the model of `scroll-fix.html` (the demo Alvan had
 * built to show the motion he wants). Two rebuilds before this kept the rows
 * vibrating: each moved them with the browser's scroll position AND a
 * transform at once, and the two are applied on different paths, so on some
 * frames one landed before the other and the rows jumped and came back.
 *
 * WHILE THE TURN RUNS (`data-driven`) the body does not scroll natively at
 * all. Its rows are placed by ONE thing, a transform, moved by ONE controller:
 *
 *   - FOLLOWING (`data-following`): the target is the newest row on the bottom
 *     edge. The speed blends toward "distance left × stiffness" instead of
 *     being kicked by each arrival, so a burst of steps or a sentence wrapping
 *     word by word is one even movement that eases to rest when the stream
 *     pauses. Never overshoots.
 *   - The box grows smoothly to its full height before anything scrolls.
 *   - Positions are exact while moving (the rows are on their own layer, which
 *     the compositor slides without redrawing the text) and land on a whole
 *     device pixel once slow, so text at rest is crisp at any scaling.
 *   - The wheel and the arrow keys move the target directly. Scrolling up
 *     stops following where the rows are; scrolling back to the bottom
 *     follows again; at either end the wheel goes on to the chat.
 *
 * WHEN THE TURN ENDS (`release`) the body becomes a normal scroller, converted
 * once from where the rows are drawn, so a finished card scrolls, keyboards
 * and scrollbar included, like any other box.
 */

import { innerScrollerTakes } from "@/apps/agent/lib/scroll/nested";
import type { WorkCardGlide } from "@/apps/agent/theme/appearance-prefs";
import { DEFAULT_GLIDE_MS } from "@/apps/agent/theme/appearance-prefs";

export const DRIVEN_ATTR = "data-driven";
export const FOLLOWING_ATTR = "data-following";

/** This close to the newest row counts as back on it. */
export const FOLLOW_AGAIN_PX = 12;

/** Below this speed (px/s) the rows are drawn on whole device pixels. */
const CRISP_BELOW_PX_S = 8;

/** How tall the edge fade is where rows are cut off. */
const FADE_PX = 28;

/** `px` on the device pixel grid. Pure. */
export function toDevicePixels(px: number, dpr: number): number {
  const ratio = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
  return Math.round(px * ratio) / ratio;
}

/** The transform that draws the rows scrolled down by `y`. Never empty: the
 *  rows keep one layer for the card's whole life. Pure. */
export function rowsTransform(y: number): string {
  const up = y > 0 ? -y : 0;
  return `translate3d(0, ${up === 0 ? 0 : +up.toFixed(3)}px, 0)`;
}

/** One frame of the follow: the new speed and position. Pure, for tests. */
export function followStep(
  y: number,
  velocity: number,
  target: number,
  dt: number,
  stiffness: number,
): { y: number; velocity: number } {
  const dist = target - y;
  // The speed BLENDS toward the one that would close the distance, so new
  // distance (a step arriving) raises it over a few frames instead of in one.
  const desired = dist * stiffness;
  let v = velocity + (desired - velocity) * (1 - Math.exp(-18 * dt));
  let move = v * dt;
  if ((dist > 0 && move > dist) || (dist < 0 && move < dist)) {
    move = dist;
    v = 0;
  }
  let next = y + move;
  if (Math.abs(target - next) < 0.25) {
    next = target;
    v = 0;
  }
  return { y: next, velocity: v };
}

/** How fast the follow closes distance, from the glide length setting. */
export function stiffnessFor(ms: number): number {
  return 11.5 * (DEFAULT_GLIDE_MS / Math.max(80, ms));
}

export interface GlideConfig {
  /** Glide at all: motion allowed, the setting not off. Off = rows jump. */
  on: boolean;
  style: WorkCardGlide;
  ms: number;
}

export interface Pin {
  readonly following: boolean;
  /** Follow the newest row, or stop following where the rows are. */
  setFollowing(on: boolean): void;
  /** The turn ended: become a normal scroller, the rows staying put. */
  release(): void;
  dispose(): void;
}

/**
 * Attach to a mounted body and its rows. `running`: the turn is still going
 * (driven, following the newest row); otherwise the body starts as a normal
 * scroller at its first row.
 */
export function attachPin(
  body: HTMLElement,
  rows: HTMLElement,
  start: { running: boolean },
  live: { glide: () => GlideConfig },
): Pin {
  const dpr = () => (typeof window === "undefined" ? 1 : window.devicePixelRatio || 1);
  let driven = false;
  let following = false;
  let y = 0;
  let target = 0;
  let velocity = 0;
  let boxH = 0; // the body's drawn content height while driven
  let frame: number | null = null;
  let last = 0;

  // ── Measurements (layout only; the transform does not affect them) ─────
  // The height this sets and `max-height` are in the body's own box sizing.
  // Aurora's is `border-box`, so they include the padding, and a 540px box
  // shows 518px of rows: leaving that out stopped the newest row 22px under
  // the bottom edge (Alvan, 2026-10-27). `extra` is the padding when it
  // counts, 0 when it does not.
  let maxBox = Infinity;
  let extra = 0;
  const measureBox = () => {
    const style = getComputedStyle(body);
    const max = parseFloat(style.maxHeight);
    maxBox = Number.isFinite(max) ? max : Infinity;
    const pads = (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0);
    extra = style.boxSizing === "border-box" ? pads : 0;
  };
  /** The box height that would hold every row unclipped. The exact height
   *  (a translate does not change it), not `offsetHeight`, which rounds. */
  const contentH = () => rows.getBoundingClientRect().height + extra;
  const wantedBox = () => Math.min(contentH(), maxBox);
  /** How far the rows scroll when the newest one sits on the bottom edge. */
  const maxY = () => Math.max(0, contentH() - wantedBox());

  // ── Drawing ─────────────────────────────────────────────────────────────
  let fades = "";
  const drawFades = (above: boolean, below: boolean) => {
    const next = `${above ? 1 : 0}${below ? 1 : 0}`;
    if (next === fades) return;
    fades = next;
    body.style.setProperty("--agw-wc-fade-top", above ? `${FADE_PX}px` : "0px");
    body.style.setProperty("--agw-wc-fade-bottom", below ? `${FADE_PX}px` : "0px");
  };
  const draw = () => {
    const slow = Math.abs(velocity) < CRISP_BELOW_PX_S;
    rows.style.transform = rowsTransform(slow ? toDevicePixels(y, dpr()) : y);
    drawFades(y > 1, maxY() - y > 1);
  };
  const drawBox = () => {
    body.style.height = `${toDevicePixels(boxH, dpr())}px`;
  };

  // ── The loop: runs only while something is moving ───────────────────────
  const settled = () =>
    Math.abs(target - y) <= 0.15 && Math.abs(velocity) <= 0.5 && Math.abs(wantedBox() - boxH) <= 0.25;
  const tick = (now: number) => {
    frame = null;
    if (!driven) return;
    const dt = Math.min(0.05, Math.max(0.001, (now - last) / 1000));
    last = now;
    const config = live.glide();
    const wantBox = wantedBox();
    if (following) target = maxY();
    if (!config.on) {
      boxH = wantBox;
      y = target;
      velocity = 0;
    } else {
      // The box grows to its full height first, smoothly.
      boxH = Math.abs(wantBox - boxH) > 0.25 ? boxH + (wantBox - boxH) * (1 - Math.exp(-14 * dt)) : wantBox;
      if (following) {
        ({ y, velocity } = followStep(y, velocity, target, dt, stiffnessFor(config.ms)));
      } else {
        // The reader's wheel: direct, lightly smoothed.
        y += (target - y) * (1 - Math.exp(-26 * dt));
        velocity = 0;
        if (Math.abs(target - y) < 0.25) y = target;
      }
    }
    drawBox();
    draw();
    if (!settled()) frame = requestAnimationFrame(tick);
  };
  const wake = () => {
    if (!driven || frame !== null || typeof requestAnimationFrame !== "function") return;
    last = performance.now();
    frame = requestAnimationFrame(tick);
  };

  // ── State changes ───────────────────────────────────────────────────────
  const setFollowing = (on: boolean) => {
    if (on === following) return;
    following = on;
    body.toggleAttribute(FOLLOWING_ATTR, on);
    if (on) target = maxY();
    else {
      // Stop where the rows are drawn, on a whole pixel.
      y = toDevicePixels(y, dpr());
      target = y;
      velocity = 0;
      if (driven) draw();
    }
    wake();
  };

  const release = () => {
    if (!driven) return;
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
    driven = false;
    body.removeAttribute(DRIVEN_ATTR);
    if (following) {
      following = false;
      body.removeAttribute(FOLLOWING_ATTR);
    }
    // Same picture, now held by the native scroll position.
    const at = toDevicePixels(y, dpr());
    velocity = 0;
    body.style.height = "";
    rows.style.transform = rowsTransform(0);
    body.scrollTop = at;
    measureNative();
  };

  // ── The reader, while driven ────────────────────────────────────────────
  const scrollBy = (delta: number, event?: Event): void => {
    const top = maxY();
    if (top <= 0) return; // nothing to scroll: the chat gets it
    if (delta < 0) {
      if (target <= 0.5 && y <= 0.5) return; // at the first row: the chat gets it
      event?.preventDefault();
      if (following) setFollowing(false);
      target = Math.max(0, target + delta);
    } else if (delta > 0) {
      if (following) return; // already on the newest row: the chat gets it
      event?.preventDefault();
      target = Math.min(top, target + delta);
      if (top - target <= FOLLOW_AGAIN_PX) setFollowing(true);
    }
    wake();
  };
  const onWheel = (event: WheelEvent) => {
    // Running and closed, the window is not scrollable by hand: the chat gets it.
    if (!driven || body.hasAttribute("data-window") || event.ctrlKey) return;
    // A sideways gesture is the code block's or chip strip's under it.
    if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? body.clientHeight : 1;
    const delta = event.deltaY * unit;
    // An expanded tool output (or anything inside a row) that can still move
    // that way scrolls first; at its end the wheel comes back to the card.
    if (innerScrollerTakes(event.target, rows, delta)) return;
    scrollBy(delta, event);
  };
  const onKey = (event: KeyboardEvent) => {
    if (!driven || event.target !== body) return;
    const page = body.clientHeight * 0.9;
    const deltas: Record<string, number> = {
      ArrowUp: -40,
      ArrowDown: 40,
      PageUp: -page,
      PageDown: page,
      Home: -Infinity,
      End: Infinity,
    };
    const delta = deltas[event.key];
    if (delta === undefined) return;
    scrollBy(Number.isFinite(delta) ? delta : delta < 0 ? -maxY() : maxY(), event);
  };

  // ── Native, once released ───────────────────────────────────────────────
  const measureNative = () => {
    if (driven) return;
    const overflow = body.scrollHeight - body.clientHeight;
    drawFades(overflow > 1 && body.scrollTop > 1, overflow > 1 && overflow - body.scrollTop > 1);
  };

  const onResize = () => {
    measureBox();
    if (driven) {
      if (following) target = maxY();
      else target = Math.min(target, maxY());
      wake();
    } else measureNative();
  };

  // ── Start ───────────────────────────────────────────────────────────────
  measureBox();
  rows.style.transform = rowsTransform(0);
  if (start.running) {
    driven = true;
    body.setAttribute(DRIVEN_ATTR, "");
    body.scrollTop = 0;
    boxH = wantedBox();
    drawBox();
    following = true;
    body.setAttribute(FOLLOWING_ATTR, "");
    y = target = maxY();
    draw();
  } else {
    body.scrollTop = 0;
    measureNative();
  }

  body.addEventListener("wheel", onWheel, { passive: false });
  body.addEventListener("keydown", onKey);
  body.addEventListener("scroll", measureNative, { passive: true });
  const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(onResize);
  observer?.observe(rows);
  // The box's max height follows the window (`--agw-transcript-h`).
  if (typeof window !== "undefined") window.addEventListener("resize", onResize);

  return {
    get following() {
      return following;
    },
    setFollowing,
    release,
    dispose() {
      body.removeEventListener("wheel", onWheel);
      body.removeEventListener("keydown", onKey);
      body.removeEventListener("scroll", measureNative);
      if (typeof window !== "undefined") window.removeEventListener("resize", onResize);
      observer?.disconnect();
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null;
    },
  };
}
