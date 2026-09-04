/**
 * Agent Window — what colour the image placeholder's shader runs at (leaf, non-component).
 *
 * Its own module because `SilkPlaceholder.tsx` may export only its component
 * (react-refresh), and because this is the one part of the placeholder with
 * real logic worth testing on its own.
 */

export type Rgb = [number, number, number];
export type Hsl = [number, number, number];

/**
 * The colour the shader was authored against, in
 * `public/image-placeholder-loop.html`.
 *
 * Kept as the source of truth for the placeholder's FEEL rather than its hue —
 * see {@link silkColor}. Its saturation and lightness are derived from this
 * constant at runtime rather than written down as numbers, so they cannot drift
 * from it.
 */
export const SILK_REFERENCE_HEX = "#7298bb";

/** Parse `#rgb`, `#rrggbb`, or `rgb(r g b)` / `rgb(r, g, b)` into 0–1 RGB. */
export function parseColor(input: string): Rgb | null {
  const value = input.trim();
  if (!value) return null;

  const hex = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value);
  if (hex) {
    const digits =
      hex[1].length === 3
        ? hex[1]
            .split("")
            .map((c) => c + c)
            .join("")
        : hex[1];
    const n = parseInt(digits, 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  }

  const rgb = /^rgba?\(([^)]+)\)$/i.exec(value);
  if (rgb) {
    const parts = rgb[1]
      .split(/[\s,/]+/)
      .filter(Boolean)
      .slice(0, 3)
      .map((p) => (p.endsWith("%") ? (parseFloat(p) / 100) * 255 : parseFloat(p)));
    if (parts.length === 3 && parts.every((p) => Number.isFinite(p))) {
      return [parts[0] / 255, parts[1] / 255, parts[2] / 255];
    }
  }
  return null;
}

export function rgbToHsl([r, g, b]: Rgb): Hsl {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return [0, 0, l];
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return [h, s, l];
}

export function hslToRgb([h, s, l]: Hsl): Rgb {
  if (s === 0) return [l, l, l];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const channel = (t: number): number => {
    let v = t;
    if (v < 0) v += 1;
    if (v > 1) v -= 1;
    if (v < 1 / 6) return p + (q - p) * 6 * v;
    if (v < 1 / 2) return q;
    if (v < 2 / 3) return p + (q - p) * (2 / 3 - v) * 6;
    return p;
  };
  return [channel(h + 1 / 3), channel(h), channel(h - 1 / 3)];
}

/**
 * The colour to drive the shader with, for a given accent.
 *
 * **Hue from the accent, saturation and lightness from
 * {@link SILK_REFERENCE_HEX}.**
 *
 * Following the accent outright was too harsh. Measured: Aurora Dark's accent
 * `#3994bc` is both more saturated and darker than the colour the shader was
 * drawn against, and at full strength the placeholder stopped reading as a
 * picture loading and started reading as a piece of themed UI. Taking only the
 * hue keeps the reference's exact feel while letting someone who changes their
 * accent watch the placeholder follow it.
 *
 * An accent this cannot parse (a `color-mix(…)`, an empty custom property)
 * falls back to the reference rather than to an accidental black.
 */
export function silkColor(accent: string | null | undefined): Rgb {
  const reference = parseColor(SILK_REFERENCE_HEX) as Rgb;
  const [, refS, refL] = rgbToHsl(reference);
  const parsed = accent ? parseColor(accent) : null;
  if (!parsed) return reference;
  const [hue] = rgbToHsl(parsed);
  return hslToRgb([hue, refS, refL]);
}
