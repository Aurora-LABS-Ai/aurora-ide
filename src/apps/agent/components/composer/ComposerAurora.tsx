/**
 * The recording visualiser — curtains of light hanging inside the composer's
 * top edge, reaching further down the louder you speak.
 *
 * ## Why this replaced the shimmer bar
 *
 * What shipped before was a 104×14 pill beside the mic button with a white
 * highlight sweeping across it every 1.7s. The sweep ran on a CSS animation
 * whether or not anyone was speaking, so the brightest event on the whole
 * control had nothing to do with your voice — the bar looked equally alive
 * during silence. Your actual level only nudged the fill, the glow and a
 * `scaleY`, which a 14px-tall element cannot show.
 *
 * Here the voice IS the animation: level drives how far the rays reach and how
 * far their hue travels from the brand blue toward green. Stop talking and the
 * curtain drops on its own.
 *
 * ## Why it is a canvas and not CSS
 *
 * A curtain is per-column: every ray needs its own height from a drifting
 * ragged ceiling. Drawn as a filled shape with a gradient it stops being an
 * aurora and becomes a coloured header bar — that was the first thing tried
 * and it looked like a banner. Rays are cheap (a `fillRect` per 3px column,
 * two layers) and they are the whole effect.
 *
 * ## Handing over at stop
 *
 * `stopRecording` flips `isRecording` false the instant the button is pressed
 * and only then awaits the transcriber, which is a child process and not fast.
 * Cutting the curtain dead on that edge is abrupt, but holding it through the
 * whole wait is a lie — nothing is being heard any more.
 *
 * So the curtain drops over ~0.35s and the WAIT is carried by the composer's
 * travelling border instead (`.agw-composer-busy`, the same shine already used
 * while a file is dragged over the window — see `26-attachments-drag.css`).
 * The light going out is the listening ending; the border picking up is the
 * transcriber working. Two different facts, two different signals, neither of
 * them invented for this.
 */

import { useEffect, useRef } from "react";
import type { RefObject } from "react";

interface ComposerAuroraProps {
  /** Live microphone capture is running. */
  recording: boolean;
  /** Audio is captured and the transcriber is working. */
  transcribing: boolean;
  /** Smoothed 0..1 speech level from `useAgentSpeech`. */
  levelRef: RefObject<number>;
}

/** Column width. Narrower buys nothing visible and costs fill rate. */
const RAY_STEP = 3;
/** Two layers read as depth; a third is not distinguishable at this height. */
const LAYERS = 2;
/**
 * Per-frame decay once recording stops — ~0.35s from full to dark at 60fps.
 * Short on purpose: the curtain is only covering the hand-off to the border
 * shine, it is not the waiting state itself.
 */
const SETTLE_DECAY = 0.83;
/** Below this the curtain is not visible, so the loop can stop. */
const DARK = 0.004;

/**
 * How far the hue may travel from the theme's accent, in degrees.
 *
 * The drift is what makes it read as light rather than a coloured panel, but
 * it has to stay in the accent's family or the composer ends up with a rainbow
 * that belongs to no theme. These three sum to ~56° at a shout, which keeps
 * every ray analogous to the accent — a blue accent shifts toward teal, an
 * amber one toward gold, a violet one toward magenta.
 */
const HUE_TRAVEL_LOUD = 38;
const HUE_TRAVEL_LAYER = 10;
const HUE_TRAVEL_SHIMMER = 8;

/** Re-read the theme roughly twice a second — the accent is user-editable. */
const ACCENT_POLL_FRAMES = 30;

interface Tone {
  hue: number;
  saturation: number;
  lightness: number;
}

/** The brand blue, used only if the accent cannot be resolved at all. */
const FALLBACK_TONE: Tone = { hue: 197, saturation: 66, lightness: 60 };

/**
 * Resolve `--agw-accent` to HSL.
 *
 * The token is authored as a hex today but the derived role tokens are
 * `color-mix()` expressions, and a user-supplied accent can be any CSS colour.
 * Rather than parse, this assigns the value to a throwaway element and reads
 * `color` back — the browser normalises whatever it was to `rgb()`.
 */
function readAccentTone(host: HTMLElement): Tone {
  const raw = getComputedStyle(host).getPropertyValue("--agw-accent").trim();
  if (!raw) return FALLBACK_TONE;

  const probe = document.createElement("span");
  probe.style.cssText = "position:absolute;width:0;height:0;visibility:hidden";
  probe.style.color = raw;
  host.appendChild(probe);
  const resolved = getComputedStyle(probe).color;
  probe.remove();

  const match = resolved.match(/-?[\d.]+/g);
  if (!match || match.length < 3) return FALLBACK_TONE;
  const r = Number(match[0]) / 255;
  const g = Number(match[1]) / 255;
  const b = Number(match[2]) / 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  const lightness = (max + min) / 2;

  let hue = 0;
  if (delta !== 0) {
    if (max === r) hue = ((g - b) / delta) % 6;
    else if (max === g) hue = (b - r) / delta + 2;
    else hue = (r - g) / delta + 4;
    hue *= 60;
    if (hue < 0) hue += 360;
  }
  const saturation = delta === 0 ? 0 : delta / (1 - Math.abs(2 * lightness - 1));

  return {
    hue,
    // A near-grey accent would give a colourless curtain, and a fully
    // saturated one would glare against the composer fill. Both ends are
    // pulled back into a range that still reads as the user's colour.
    saturation: Math.min(80, Math.max(42, saturation * 100)),
    // Light enough to register on #2e2e2e without washing the text under it.
    lightness: Math.min(68, Math.max(50, lightness * 100)),
  };
}

/**
 * Ray height at `u` (0..1 across the composer) for one layer.
 *
 * Three sines at spread frequencies: a slow arc that drifts, a mid ripple, and
 * a fine one that keeps the top edge ragged. A single sine gives a clean curve
 * that reads as a graph rather than light.
 */
function ceilingAt(u: number, layer: number, speed: number, t: number): number {
  return (
    0.55 +
    0.45 * Math.sin(u * (4 + layer * 3) + t * speed + layer * 2.1) +
    0.22 * Math.sin(u * 23 - t * speed * 1.7) +
    0.12 * Math.sin(u * 61 + t * speed * 0.6)
  );
}

export function ComposerAurora({ recording, transcribing, levelRef }: ComposerAuroraProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const frameRef = useRef<number | null>(null);
  // Carried across renders: the settle has to survive `recording` flipping to
  // false without restarting from zero.
  const settleRef = useRef(1);
  const heldRef = useRef(0);
  const tRef = useRef(0);

  const active = recording || transcribing;

  useEffect(() => {
    if (!active) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    if (recording) {
      // A fresh take: full strength again.
      settleRef.current = 1;
      heldRef.current = 0;
    }

    const dpr = Math.max(1, window.devicePixelRatio || 1);
    let width = 0;
    let height = 0;

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const w = Math.max(1, Math.round(rect.width * dpr));
      const h = Math.max(1, Math.round(rect.height * dpr));
      if (w === width && h === height) return;
      width = w;
      height = h;
      canvas.width = w;
      canvas.height = h;
    };
    resize();

    const observer = new ResizeObserver(resize);
    observer.observe(canvas);

    // The composer's own reduced-motion switch. The curtain still responds to
    // your voice — that is the feedback, not decoration — but it stops
    // drifting, so nothing moves unless you are speaking.
    const still =
      canvas.closest(".agw-root")?.hasAttribute("data-reduce-motion") ?? false;

    const step = RAY_STEP * dpr;

    // The curtain is painted in the theme's own colour. Polled rather than
    // read once because the accent is editable in Appearance and applies
    // live — a curtain still glowing in the previous accent is exactly the
    // mismatch this replaced.
    let tone = readAccentTone(canvas);
    let sinceAccentRead = 0;

    const render = () => {
      frameRef.current = window.requestAnimationFrame(render);
      if (!still) tRef.current += 1;
      const t = tRef.current;

      sinceAccentRead += 1;
      if (sinceAccentRead >= ACCENT_POLL_FRAMES) {
        sinceAccentRead = 0;
        tone = readAccentTone(canvas);
      }

      let level: number;
      if (recording) {
        level = levelRef.current ?? 0;
        heldRef.current = level;
      } else {
        // Recording has stopped. Drop the curtain and let the border shine
        // carry the wait. Floored so a take that ended on a quiet syllable
        // still has something visible to fade out of.
        settleRef.current *= SETTLE_DECAY;
        level = Math.max(heldRef.current, 0.28) * settleRef.current;
      }

      ctx.clearRect(0, 0, width, height);
      if (level <= DARK) return;

      ctx.globalCompositeOperation = "lighter";
      for (let layer = 0; layer < LAYERS; layer += 1) {
        const speed = 0.01 + layer * 0.006;
        const reach = height * (0.26 + level * 0.66) * (1 - layer * 0.3);
        const alpha = (0.05 + level * 0.3) * (1 - layer * 0.35);
        for (let x = 0; x < width; x += step) {
          const u = x / width;
          const rayHeight = reach * ceilingAt(u, layer, speed, t) * 0.75;
          if (rayHeight < 1) continue;
          // Every hue is measured FROM the theme's accent, never an absolute.
          // Loudness, layer depth and a slow shimmer each nudge it a little,
          // which is what makes it move like light — but the total stays
          // inside the accent's own family so the curtain belongs to whatever
          // colour the user picked.
          const hue =
            tone.hue -
            level * HUE_TRAVEL_LOUD +
            layer * HUE_TRAVEL_LAYER +
            Math.sin(u * 6 + t * 0.004) * HUE_TRAVEL_SHIMMER;
          const { saturation: s, lightness: l } = tone;
          // Three stops, not two: the mid stop is what gives a ray a bright
          // core that falls off, which is the difference between light and a
          // flat gradient wipe.
          const gradient = ctx.createLinearGradient(0, 0, 0, rayHeight);
          gradient.addColorStop(0, `hsla(${hue}, ${s}%, ${l}%, ${alpha})`);
          gradient.addColorStop(
            0.55,
            `hsla(${hue + 10}, ${Math.min(100, s + 6)}%, ${l - 6}%, ${alpha * 0.55})`,
          );
          gradient.addColorStop(1, `hsla(${hue + 20}, ${Math.min(100, s + 10)}%, ${l - 10}%, 0)`);
          ctx.fillStyle = gradient;
          ctx.fillRect(x, 0, step * 0.85, rayHeight);
        }
      }
      ctx.globalCompositeOperation = "source-over";
    };

    frameRef.current = window.requestAnimationFrame(render);

    return () => {
      observer.disconnect();
      if (frameRef.current !== null) {
        window.cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    };
  }, [active, recording, levelRef]);

  if (!active) return null;

  return (
    <div className="agw-composer-aurora" aria-hidden>
      <canvas ref={canvasRef} />
    </div>
  );
}
