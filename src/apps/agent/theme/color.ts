/**
 * Agent Window — small color helpers (theme concern, pure).
 *
 * Just enough hex math to power the Appearance page: parse/serialize hex,
 * blend two colors, derive a `<input type="color">`-safe `#rrggbb` value, and
 * apply a global contrast adjustment to the text/line tokens. Non-hex values
 * (rgba(), color-mix(), transparent) are passed through untouched so the
 * helpers never corrupt a token they don't understand.
 */

import type { AgentAppearance, AgentThemeTokens } from "../types";

export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** Parse `#rgb` / `#rgba` / `#rrggbb` / `#rrggbbaa` → rgba, else null. */
export function parseHex(input: string): Rgba | null {
  const s = input.trim();
  const m = /^#([0-9a-fA-F]{3,8})$/.exec(s);
  if (!m) return null;
  let h = m[1];
  if (h.length === 3 || h.length === 4) {
    h = h
      .split("")
      .map((c) => c + c)
      .join("");
  }
  if (h.length !== 6 && h.length !== 8) return null;
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
  return { r, g, b, a };
}

function clamp255(n: number): number {
  return Math.max(0, Math.min(255, Math.round(n)));
}

function hex2(n: number): string {
  return clamp255(n).toString(16).padStart(2, "0");
}

/** Serialize rgba → `#rrggbb` (or `#rrggbbaa` when alpha < 1). */
export function toHex({ r, g, b, a }: Rgba): string {
  const base = `#${hex2(r)}${hex2(g)}${hex2(b)}`;
  return a >= 1 ? base : `${base}${hex2(a * 255)}`;
}

/**
 * `#rrggbb` suitable for a native color input. Falls back to `fallback` for
 * any value we can't parse (rgba/color-mix/transparent), so the swatch always
 * has a sane base even when the underlying token keeps its richer form.
 */
export function toColorInputValue(value: string, fallback = "#000000"): string {
  const parsed = parseHex(value);
  if (!parsed) return fallback;
  return `#${hex2(parsed.r)}${hex2(parsed.g)}${hex2(parsed.b)}`;
}

/** Linear blend of two colors by `t` (0 → a, 1 → b). Passes through on parse fail. */
export function mix(a: string, b: string, t: number): string {
  const ca = parseHex(a);
  const cb = parseHex(b);
  if (!ca || !cb) return a;
  const k = Math.max(0, Math.min(1, t));
  return toHex({
    r: ca.r + (cb.r - ca.r) * k,
    g: ca.g + (cb.g - ca.g) * k,
    b: ca.b + (cb.b - ca.b) * k,
    a: ca.a + (cb.a - ca.a) * k,
  });
}

// ── Legibility ───────────────────────────────────────────────────────────────
//
// The Appearance page lets someone type any accent they like, and until now it
// took it without comment. A mid-yellow accent on the default near-black reads
// fine; the same yellow behind white `onAccent` label text does not, and the
// send button, primary dialog buttons and mode chips all draw exactly that.
// These helpers measure it so the page can SAY so.
//
// WCAG 2.1 relative luminance and contrast ratio, unmodified. Not because the
// numbers are sacred, but because a shared scale everyone already knows beats
// a bespoke one nobody can check.

/** WCAG relative luminance, 0 (black) → 1 (white). */
export function relativeLuminance(color: string): number | null {
  const c = parseHex(color);
  if (!c) return null;
  const channel = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
}

/**
 * WCAG contrast ratio between two colours, 1 → 21. Null when either side is a
 * value we cannot measure (`rgba()`, `color-mix()`, `transparent`) — the caller
 * shows nothing rather than a wrong number.
 *
 * Alpha is IGNORED: both arguments are treated as opaque. A translucent accent
 * would need the surface behind it composited first, and every colour this is
 * actually called with (accent, canvas, conversation) is opaque.
 */
export function contrastRatio(a: string, b: string): number | null {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  if (la === null || lb === null) return null;
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** Black or white, whichever reads better ON `background`. What `onAccent`
 *  should be for a given accent. */
export function readableForeground(background: string): "#ffffff" | "#000000" {
  const l = relativeLuminance(background);
  if (l === null) return "#ffffff";
  // Compare both rather than thresholding at 0.5: the crossover for the WCAG
  // curve sits near 0.179, not the midpoint, which is why mid-greys take black
  // text and not white.
  const onWhite = (1.05) / (l + 0.05);
  const onBlack = (l + 0.05) / 0.05;
  return onBlack >= onWhite ? "#000000" : "#ffffff";
}

/** The ratio a UI accent should clear against the surface it sits on. 3:1 is
 *  WCAG's bar for large text and graphical objects, which is what an accent
 *  fill, a marker dot and an active underline all are. */
export const MIN_ACCENT_CONTRAST = 3;

/**
 * What a LABEL on a filled accent button should clear before we say anything.
 *
 * WCAG AA for 14px/500 text is 4.5:1, and this is 3:1 — a deliberate gap, not
 * an oversight. **Both shipped accents are already under 4.5**: Aurora Dark's
 * `#3994bc` gives 3.42:1 under white, Daylight's `#4f6bff` gives 4.30:1
 * (`color.test.ts` pins both numbers, so a future accent change is measured
 * rather than guessed). Warning at 4.5 would therefore flag a fresh install on
 * first open, which teaches people to ignore the warning.
 *
 * 3:1 is where a label stops being merely low-contrast and starts being hard
 * to read, so it catches the case the warning exists for — a pale accent with
 * white `onAccent` — without crying wolf about the brand colour. Raising this
 * to 4.5 is a real option, but it is a decision about the ACCENT, not about
 * the threshold, and it belongs with whoever owns the brand.
 */
export const MIN_ON_ACCENT_CONTRAST = 3;

/** WCAG AA for normal-size text. Quoted in the warning copy so the gap above is
 *  visible to anyone reading it, rather than buried in this file. */
export const AA_NORMAL_TEXT_CONTRAST = 4.5;

/**
 * Nudge `accent` toward or away from `toward` until it clears `min` against
 * every background given, keeping its hue.
 *
 * Deliberately a LINEAR walk in 4% steps rather than a solve: the step size is
 * what stops a barely-failing colour being thrown to an unrecognisably
 * different one, and 25 steps is cheap. Returns the original when it already
 * passes, or when it cannot be measured — never a guess.
 */
export function legibleAccent(
  accent: string,
  backgrounds: string[],
  min = MIN_ACCENT_CONTRAST,
): string {
  const measurable = backgrounds.filter((b) => relativeLuminance(b) !== null);
  if (measurable.length === 0 || relativeLuminance(accent) === null) return accent;

  const worst = (candidate: string) =>
    Math.min(...measurable.map((b) => contrastRatio(candidate, b) ?? Infinity));
  if (worst(accent) >= min) return accent;

  // Walk AWAY from the darkest background: on a dark window that means toward
  // white, on a light one toward black. Using the darkest (not the average)
  // is what keeps the result legible on the conversation sheet, which is the
  // darkest surface an accent lands on.
  const darkest = measurable.reduce((a, b) =>
    (relativeLuminance(a) ?? 1) <= (relativeLuminance(b) ?? 1) ? a : b,
  );
  const target = (relativeLuminance(darkest) ?? 0) < 0.5 ? "#ffffff" : "#000000";

  let best = accent;
  for (let step = 1; step <= 25; step += 1) {
    const candidate = mix(accent, target, step * 0.04);
    best = candidate;
    if (worst(candidate) >= min) return candidate;
  }
  // Ran out of room: hand back the closest we got rather than the original, so
  // "fix it" always moves in the right direction even on a hopeless hue.
  return best;
}

/**
 * Apply a global contrast level (0–100, 50 = neutral) to the text + line
 * tokens. Above 50 pushes text/borders toward the appearance extreme (brighter
 * on dark, darker on light); below 50 softens them toward the canvas. Color
 * hues are never touched — only the foreground/background separation.
 */
export function applyContrast(
  tokens: AgentThemeTokens,
  appearance: AgentAppearance,
  contrast: number,
): AgentThemeTokens {
  if (contrast === 50) return tokens;
  const t = (contrast - 50) / 50; // -1 … 1
  const high = appearance === "dark" ? "#ffffff" : "#000000";
  const low = appearance === "dark" ? "#000000" : "#ffffff";
  const target = t >= 0 ? high : low;
  const amt = Math.abs(t);
  const adj = (color: string, strength: number) => mix(color, target, amt * strength);
  return {
    ...tokens,
    text: adj(tokens.text, 0.22),
    textMuted: adj(tokens.textMuted, 0.4),
    textSubtle: adj(tokens.textSubtle, 0.52),
    border: adj(tokens.border, 0.32),
    borderStrong: adj(tokens.borderStrong, 0.32),
  };
}
