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
