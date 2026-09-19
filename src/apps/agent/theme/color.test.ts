/**
 * Colour legibility maths behind the Appearance page's accent warning.
 *
 * These are checked against values that can be verified by hand (black/white is
 * exactly 21:1 by definition) and against the real shipped tokens, so a change
 * to the default accent that made it illegible would fail here rather than
 * being noticed by someone squinting at a marker dot.
 */

import { describe, expect, it } from "vitest";

import {
  AA_NORMAL_TEXT_CONTRAST,
  MIN_ACCENT_CONTRAST,
  MIN_ON_ACCENT_CONTRAST,
  contrastRatio,
  legibleAccent,
  readableForeground,
  relativeLuminance,
} from "./color";
import { agentDark, agentLight } from "./themes";

describe("contrast", () => {
  it("anchors at the two values that are defined, not measured", () => {
    expect(relativeLuminance("#000000")).toBe(0);
    expect(relativeLuminance("#ffffff")).toBe(1);
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrastRatio("#777777", "#777777")).toBeCloseTo(1, 5);
  });

  it("is symmetric", () => {
    expect(contrastRatio("#3994bc", "#161616")).toBe(
      contrastRatio("#161616", "#3994bc"),
    );
  });

  it("returns null for a colour it cannot measure rather than guessing", () => {
    // The page shows NOTHING for these. A wrong ratio is worse than no ratio.
    expect(contrastRatio("transparent", "#000000")).toBeNull();
    expect(contrastRatio("color-mix(in srgb, red, blue)", "#000000")).toBeNull();
    expect(contrastRatio("rgba(255,255,255,0.4)", "#000000")).toBeNull();
    expect(relativeLuminance("not a colour")).toBeNull();
  });
});

describe("readableForeground", () => {
  it("crosses over on the WCAG curve, not at the midpoint of the range", () => {
    // #777777 is past the middle of 0–255 in brightness terms but its relative
    // luminance is ~0.18, so BLACK reads better on it. A naive `l > 0.5`
    // threshold gets this one wrong, which is the whole reason for the test.
    expect(readableForeground("#777777")).toBe("#000000");
    expect(readableForeground("#000000")).toBe("#ffffff");
    expect(readableForeground("#ffffff")).toBe("#000000");
  });

  it("falls back to white when it cannot measure", () => {
    expect(readableForeground("transparent")).toBe("#ffffff");
  });
});

describe("legibleAccent", () => {
  const darkSurfaces = [agentDark.tokens.conversation, agentDark.tokens.canvas];

  it("leaves an accent that already passes completely alone", () => {
    const accent = agentDark.tokens.accent;
    expect(legibleAccent(accent, darkSurfaces)).toBe(accent);
  });

  it("lifts a too-dark accent off a dark window until it clears the bar", () => {
    // Near-black accent on the near-black conversation sheet: markers, active
    // underlines and links all disappear.
    const fixed = legibleAccent("#1a1a1a", darkSurfaces);
    expect(fixed).not.toBe("#1a1a1a");
    for (const surface of darkSurfaces) {
      expect(contrastRatio(fixed, surface)!).toBeGreaterThanOrEqual(MIN_ACCENT_CONTRAST);
    }
  });

  it("darkens a too-light accent on a light window", () => {
    const lightSurfaces = [agentLight.tokens.conversation, agentLight.tokens.canvas];
    const fixed = legibleAccent("#fafafa", lightSurfaces);
    expect(relativeLuminance(fixed)!).toBeLessThan(relativeLuminance("#fafafa")!);
    for (const surface of lightSurfaces) {
      expect(contrastRatio(fixed, surface)!).toBeGreaterThanOrEqual(MIN_ACCENT_CONTRAST);
    }
  });

  it("keeps the hue recognisable instead of jumping to the extreme", () => {
    // A barely-failing blue should come back a lighter blue, not white. The
    // 4%-per-step walk is what guarantees this; a solve would overshoot.
    const fixed = legibleAccent("#1c4f6b", darkSurfaces);
    const [r, g, b] = [
      parseInt(fixed.slice(1, 3), 16),
      parseInt(fixed.slice(3, 5), 16),
      parseInt(fixed.slice(5, 7), 16),
    ];
    expect(b).toBeGreaterThan(r);
    expect(g).toBeGreaterThan(r);
    expect(fixed).not.toBe("#ffffff");
  });

  it("passes through anything it cannot measure", () => {
    expect(legibleAccent("var(--x)", darkSurfaces)).toBe("var(--x)");
    expect(legibleAccent("#3994bc", ["transparent"])).toBe("#3994bc");
  });
});

describe("the shipped themes pass their own check", () => {
  // If a default accent failed this, the warning would fire on a FRESH install
  // — shipping a theme the page itself flags, which teaches people to ignore
  // the warning.
  for (const theme of [agentDark, agentLight]) {
    it(`${theme.id} accent is legible on its own surfaces`, () => {
      for (const surface of [theme.tokens.conversation, theme.tokens.canvas]) {
        expect(contrastRatio(theme.tokens.accent, surface)!).toBeGreaterThanOrEqual(
          MIN_ACCENT_CONTRAST,
        );
      }
    });

    it(`${theme.id} label text on a filled accent button clears the warning bar`, () => {
      expect(
        contrastRatio(theme.tokens.onAccent, theme.tokens.accent)!,
      ).toBeGreaterThanOrEqual(MIN_ON_ACCENT_CONTRAST);
    });
  }

  /**
   * The known gap, pinned rather than hidden.
   *
   * Neither brand accent reaches WCAG AA (4.5:1) for the 14px label on a filled
   * accent button, which is why `MIN_ON_ACCENT_CONTRAST` warns at 3 instead.
   * These numbers are asserted exactly so that changing an accent shows up here
   * as a measured move — up or down — instead of silently shifting how far
   * short we are.
   */
  it("records how far the brand accents sit below WCAG AA for button labels", () => {
    expect(contrastRatio(agentDark.tokens.onAccent, agentDark.tokens.accent)).toBeCloseTo(
      3.42,
      2,
    );
    expect(
      contrastRatio(agentLight.tokens.onAccent, agentLight.tokens.accent),
    ).toBeCloseTo(4.3, 2);
    expect(AA_NORMAL_TEXT_CONTRAST).toBe(4.5);
  });
});
