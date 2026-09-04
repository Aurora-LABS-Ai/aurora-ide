import { describe, expect, it } from "vitest";

import {
  hslToRgb,
  parseColor,
  rgbToHsl,
  silkColor,
} from "@/apps/agent/components/theme/silk-color";

/** The colour the shader was authored against. */
const REFERENCE = "#7298bb";
/** Aurora Dark's accent. */
const DARK_ACCENT = "#3994bc";
/** The deliberately-unlike accent from the custom probe theme. */
const PURPLE_ACCENT = "#d158a8";

const hex = ([r, g, b]: [number, number, number]): string =>
  `#${[r, g, b]
    .map((c) => Math.round(c * 255).toString(16).padStart(2, "0"))
    .join("")}`;

describe("parseColor", () => {
  it("reads the three spellings the cascade actually hands back", () => {
    expect(parseColor("#7298bb")).toEqual([114 / 255, 152 / 255, 187 / 255]);
    expect(parseColor("7298bb")).toEqual([114 / 255, 152 / 255, 187 / 255]);
    // getComputedStyle returns a leading space for a custom property.
    expect(parseColor("  #7298bb ")).toEqual([114 / 255, 152 / 255, 187 / 255]);
    // Shorthand hex.
    expect(parseColor("#fff")).toEqual([1, 1, 1]);
    // Both rgb() spellings — comma-separated and the modern space-separated.
    expect(parseColor("rgb(114, 152, 187)")).toEqual([114 / 255, 152 / 255, 187 / 255]);
    expect(parseColor("rgb(114 152 187)")).toEqual([114 / 255, 152 / 255, 187 / 255]);
  });

  it("returns null for anything it cannot read, rather than guessing", () => {
    // A theme could hand back a `color-mix(...)`; the caller must fall back to
    // the reference rather than paint the shader an accidental black.
    expect(parseColor("color-mix(in srgb, red 20%, blue)")).toBeNull();
    expect(parseColor("")).toBeNull();
    expect(parseColor("not a colour")).toBeNull();
  });
});

describe("rgbToHsl / hslToRgb", () => {
  it("round-trips the reference colour", () => {
    const rgb = parseColor(REFERENCE)!;
    expect(hex(hslToRgb(rgbToHsl(rgb)))).toBe(REFERENCE);
  });

  it("round-trips greys, where hue is undefined", () => {
    for (const grey of ["#000000", "#808080", "#ffffff"]) {
      expect(hex(hslToRgb(rgbToHsl(parseColor(grey)!)))).toBe(grey);
    }
  });
});

describe("silkColor", () => {
  /**
   * The rule Alvan chose: follow the accent, but not so harshly. Hue from the
   * accent, saturation and lightness from the reference.
   */
  it("takes the hue from the accent and the feel from the reference", () => {
    const reference = rgbToHsl(parseColor(REFERENCE)!);
    const accentHsl = rgbToHsl(parseColor(DARK_ACCENT)!);
    const result = rgbToHsl(silkColor(DARK_ACCENT));

    expect(result[0]).toBeCloseTo(accentHsl[0], 5);
    expect(result[1]).toBeCloseTo(reference[1], 5);
    expect(result[2]).toBeCloseTo(reference[2], 5);
  });

  /**
   * The harshness this rule exists to remove, stated as a measurement rather
   * than a matter of taste: Aurora's accent really is more saturated and
   * darker than the colour the shader was drawn against, and the result must
   * not inherit either.
   */
  it("softens an accent that is more saturated and darker than the reference", () => {
    const reference = rgbToHsl(parseColor(REFERENCE)!);
    const accent = rgbToHsl(parseColor(DARK_ACCENT)!);
    expect(accent[1]).toBeGreaterThan(reference[1]);
    expect(accent[2]).toBeLessThan(reference[2]);

    const result = rgbToHsl(silkColor(DARK_ACCENT));
    expect(result[1]).toBeLessThan(accent[1]);
    expect(result[2]).toBeGreaterThan(accent[2]);
  });

  it("follows a user's own accent into a different hue", () => {
    const blue = rgbToHsl(silkColor(DARK_ACCENT));
    const purple = rgbToHsl(silkColor(PURPLE_ACCENT));
    expect(purple[0]).not.toBeCloseTo(blue[0], 2);
    // …while staying at the same saturation and lightness, so a purple theme
    // gets a muted violet silk rather than a neon one.
    expect(purple[1]).toBeCloseTo(blue[1], 5);
    expect(purple[2]).toBeCloseTo(blue[2], 5);
  });

  it("falls back to the reference when the accent is missing or unreadable", () => {
    const reference = parseColor(REFERENCE)!;
    expect(silkColor(null)).toEqual(reference);
    expect(silkColor(undefined)).toEqual(reference);
    expect(silkColor("")).toEqual(reference);
    expect(silkColor("color-mix(in srgb, red 20%, blue)")).toEqual(reference);
  });

  it("returns the reference itself when handed the reference", () => {
    expect(hex(silkColor(REFERENCE))).toBe(REFERENCE);
  });

  it("never returns a channel outside 0–1", () => {
    for (const accent of [
      "#000000",
      "#ffffff",
      "#ff0000",
      "#00ff00",
      "#0000ff",
      DARK_ACCENT,
      PURPLE_ACCENT,
    ]) {
      for (const channel of silkColor(accent)) {
        expect(channel).toBeGreaterThanOrEqual(0);
        expect(channel).toBeLessThanOrEqual(1);
      }
    }
  });

  /**
   * A greyscale accent has no hue to take. Hue 0 with the reference's
   * saturation is a red, which would be a bizarre placeholder for a theme
   * whose accent is grey — but it is what the rule says, and it is stable.
   * Pinned so that changing it later is a decision rather than a surprise.
   */
  it("gives a hueless accent hue 0, deterministically", () => {
    expect(silkColor("#808080")).toEqual(silkColor("#404040"));
  });
});
