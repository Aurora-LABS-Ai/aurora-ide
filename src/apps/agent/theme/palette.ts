/**
 * Agent Window — the palette engine (theme concern, pure).
 *
 * Every colour token of a built-in theme is DERIVED here from four inputs —
 * surface (window background), ink (foreground), accent, contrast — plus the
 * diff colours, the way the Codex desktop app derives its chrome
 * (`thirdparty/aurora-visual-foundation-reference/tokens/codex-theme-engine.mjs`,
 * `docs/COLOR.md`). Nothing else in the window picks a colour of its own:
 * borders, hovers and secondary text are ink at an alpha, surfaces that content
 * scrolls under are opaque mixes of the surface, and all of it moves with the
 * contrast input.
 *
 * The math is a 1:1 port of the reference engine (same rounding, same alpha
 * formatting), so the defaults below reproduce Codex's resolved values exactly
 * (`palette.test.ts` pins them against `tokens/codex-tokens.resolved.json`).
 * Where Codex's semantic layer uses a fixed ramp colour rather than an engine
 * output (status text, the scrim), the value is copied from the resolved
 * tokens and named as such in {@link VARIANT_FIXED}.
 */

import type { AgentAppearance, AgentThemeTokens, PaletteInputs } from "../types";

/** Codex's stock inputs (`source-excerpts/theme-defaults.original.js`). */
export const CODEX_INPUTS: Record<AgentAppearance, PaletteInputs> = {
  dark: {
    surface: "#181818",
    ink: "#ffffff",
    accent: "#339cff",
    contrast: 60,
    diffAdded: "#40c977",
    diffRemoved: "#fa423e",
  },
  light: {
    surface: "#ffffff",
    ink: "#1a1c1f",
    accent: "#339cff",
    contrast: 45,
    diffAdded: "#00a240",
    diffRemoved: "#ba2623",
  },
};

/**
 * Aurora's shipped inputs: Codex's, with ONE change. Codex's `#339cff` gives a
 * white button label 2.86:1 and sits at 2.65:1 on the light rail (`#f6f6f6`),
 * under the 3:1 bar `color.ts` warns at, so a fresh install would flag its own
 * accent. The accent is walked toward black in `legibleAccent`'s 4% steps until
 * it clears 3:1 against white AND the light rail: two steps, `#2f90eb` (3.33:1
 * under a white label, 3.08:1 on `#f6f6f6`, 5.3:1+ on the dark surfaces). One
 * accent for both variants, as Codex has. Every other input is Codex's exactly.
 * (Alvan, 2026-10-28: Codex everywhere, but nothing that fails our own check.)
 */
export const AURORA_INPUTS: Record<AgentAppearance, PaletteInputs> = {
  dark: { ...CODEX_INPUTS.dark, accent: "#2f90eb" },
  light: { ...CODEX_INPUTS.light, accent: "#2f90eb" },
};

/** `--color-background-info-solid-hover` for the stock accent (both variants). */
const STOCK_ACCENT_HOVER = "#0169cc";

/** The appearance slider's neutral point (`appearance-prefs.ts`). */
const SLIDER_NEUTRAL = 50;

/**
 * The contrast input for a slider position: the slider's neutral point is the
 * variant's own default, and each step moves the input one step.
 */
export function contrastInput(appearance: AgentAppearance, slider: number): number {
  const value = CODEX_INPUTS[appearance].contrast + (slider - SLIDER_NEUTRAL);
  return Math.max(0, Math.min(100, value));
}

/** Colours Codex's semantic layer takes from its fixed ramps, per variant. */
const VARIANT_FIXED: Record<
  AgentAppearance,
  {
    /** `--color-text-warning`. */
    warning: string;
    /** `--modal-backdrop-background`. */
    scrim: string;
    /** `--user-message-background-color` alpha over the text colour. */
    userMessageAlpha: number;
    /** Stock dark text sits one step off pure white (`--gray-fixed-150`). */
    stockText?: string;
  }
> = {
  dark: {
    warning: "#ff8549",
    scrim: "rgba(0, 0, 0, 0.502)",
    userMessageAlpha: 0.08,
    // Measured off the installed ChatGPT/Codex app by Alvan, 2026-10-28: its
    // text draws #f0f0f0. The reference bundle (v26.1021) resolves
    // `--gray-fixed-150` to #dfdfdf; the shipping app is newer and brighter,
    // and what it actually draws is the target.
    stockText: "#f0f0f0",
  },
  light: {
    warning: "#e25507",
    scrim: "rgba(0, 0, 0, 0.302)",
    userMessageAlpha: 0.05,
  },
};

// ── Colour math: sRGB channels 0–255, exactly as the reference rounds ───────

interface Rgb {
  r: number;
  g: number;
  b: number;
}

const BLACK: Rgb = { r: 0, g: 0, b: 0 };
const WHITE: Rgb = { r: 255, g: 255, b: 255 };

function hexToRgb(hex: string): Rgb {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? [...h].map((c) => c + c).join("") : h.slice(0, 6);
  return {
    r: Number.parseInt(full.slice(0, 2), 16),
    g: Number.parseInt(full.slice(2, 4), 16),
    b: Number.parseInt(full.slice(4, 6), 16),
  };
}

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));
const lerp = (a: number, b: number, t: number): number => Math.round(a + (b - a) * t);

function mix(a: Rgb, b: Rgb, t: number): Rgb {
  const k = clamp01(t);
  return { r: lerp(a.r, b.r, k), g: lerp(a.g, b.g, k), b: lerp(a.b, b.b, k) };
}

const alphaString = (a: number): string =>
  clamp01(a).toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
const rgba = (c: Rgb, a: number): string => `rgba(${c.r}, ${c.g}, ${c.b}, ${alphaString(a)})`;
const hex2 = (n: number): string => n.toString(16).padStart(2, "0");
const toHex = (c: Rgb): string => `#${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}`;

const channel = (v: number): number => {
  const s = v / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const luminance = (c: Rgb): number =>
  channel(c.r) * 0.2126 + channel(c.g) * 0.7152 + channel(c.b) * 0.0722;

/** Text on the accent: white or black, with the reference's carve-out for mid blues. */
function onAccent(c: Rgb): Rgb {
  if (c.b > c.r && c.b > c.g) {
    const chroma = c.b - Math.min(c.r, c.g);
    const hue = ((c.r - c.g) / chroma + 4) * 60;
    if (
      (chroma / c.b >= 0.8 && hue >= 205 && hue <= 212) ||
      (chroma / c.b >= 0.6 && hue >= 218 && hue <= 233 && luminance(c) <= 0.21)
    ) {
      return WHITE;
    }
  }
  return luminance(c) > 0.179 ? BLACK : WHITE;
}

/** The 0–100 input as a factor; above the variant default it grows twice as fast. */
function normalizeContrast(value: number, appearance: AgentAppearance): number {
  const def = CODEX_INPUTS[appearance].contrast;
  const base = def / 100;
  const linear = value / 100 + ((value - def) / 60) * 0.7;
  return value <= def ? linear : base + (linear - base) * 2;
}

/**
 * Whether the text sits on the stock surface and ink. Codex checks every input
 * here; only these two decide the text colour, and checking the rest would
 * flip the text to pure white the moment the accent or contrast moved.
 */
const isStockText = (inputs: PaletteInputs, appearance: AgentAppearance): boolean => {
  const d = CODEX_INPUTS[appearance];
  return inputs.surface.toLowerCase() === d.surface && inputs.ink.toLowerCase() === d.ink;
};

/** The colour half of {@link AgentThemeTokens}: everything a palette produces. */
export type PaletteTokens = Pick<
  AgentThemeTokens,
  | "canvas"
  | "rail"
  | "conversation"
  | "dock"
  | "surface"
  | "surfaceElevated"
  | "composerSurface"
  | "overlay"
  | "text"
  | "textMuted"
  | "textSubtle"
  | "onAccent"
  | "border"
  | "borderStrong"
  | "ring"
  | "accent"
  | "accentHover"
  | "controlAccent"
  | "added"
  | "addedSurface"
  | "removed"
  | "removedSurface"
  | "warning"
  | "info"
  | "bubbleUser"
  | "bubbleAssistant"
  | "codeSurface"
  | "codeBorder"
  | "chipSurface"
  | "chipText"
  | "controlMuted"
  | "hover"
  | "scrollThumb"
  | "scrollThumbHover"
  | "shadowPop"
>;

/**
 * Derive every colour token from the inputs. Each line names the reference
 * token it reproduces, so a mapping question is answered by reading one line.
 */
export function derivePalette(inputs: PaletteInputs, appearance: AgentAppearance): PaletteTokens {
  const dark = appearance === "dark";
  const fixed = VARIANT_FIXED[appearance];
  const c = normalizeContrast(inputs.contrast, appearance);
  const surface = hexToRgb(inputs.surface);
  const ink = hexToRgb(inputs.ink);
  const accent = hexToRgb(inputs.accent);

  // `--app-color-background-surface-under`: dark sinks toward black, light tints toward ink.
  const underT = (dark ? 0.16 : 0.04) + (inputs.contrast - CODEX_INPUTS[appearance].contrast) * (dark ? 0.0015 : 0.0012);
  const under = dark ? mix(surface, BLACK, underT) : mix(surface, ink, underT);
  // `--color-background-panel`.
  const panel = mix(surface, dark ? ink : WHITE, (dark ? 0.03 : 0.18) + c * (dark ? 0.03 : 0.008));
  // `--color-background-control-opaque` (menus: `--color-surface-elevated-secondary`).
  const control = dark ? mix(surface, ink, 0.06 + c * 0.05) : mix(surface, WHITE, 0.09 + c * 0.04);
  // `--app-color-text-accent` / focus ring source.
  const accentText = dark ? mix(accent, WHITE, 0.3 + c * 0.15) : accent;

  // `--color-text`: the stock dark theme keeps text one step off pure white.
  const textHex = fixed.stockText && isStockText(inputs, appearance) ? fixed.stockText : inputs.ink;
  const text = hexToRgb(textHex);

  const border = rgba(ink, 0.06 + c * 0.04); // --color-border
  const borderStrong = rgba(ink, (dark ? 0.12 : 0.09) + c * 0.06); // --color-border-strong

  // Codex's two window colours, placed the other way round: Aurora's frame
  // (rails, dock, gutters) is the window surface and the chat sheet is the
  // recessed one, so the conversation reads as a stage set into the frame
  // (Alvan, 2026-10-28: "what is in the rails make it the chat").
  return {
    canvas: inputs.surface, // --app-color-background-surface
    rail: inputs.surface,
    dock: inputs.surface,
    conversation: toHex(under), // --app-color-background-surface-under
    surface: toHex(panel), // --color-background-panel
    surfaceElevated: toHex(control), // --color-surface-elevated-secondary (menus)
    // The elevation ladder (sunk sheet → frame → raised → floating): the
    // composer is a RAISED object, Codex's panel step, `#232323` on stock dark.
    // Codex's own composer is its popover fill at 96%; one step lower keeps the
    // composer quieter than the menus that open from it.
    composerSurface: toHex(panel), // --color-background-panel
    overlay: fixed.scrim, // --modal-backdrop-background

    text: textHex, // --color-text
    textMuted: rgba(text, 0.65), // --color-text-secondary
    textSubtle: rgba(ink, (dark ? 0.42 : 0.45) + c * (dark ? 0.13 : 0.1)), // --color-text-tertiary
    onAccent: toHex(onAccent(accent)), // --app-color-text-on-accent

    border,
    borderStrong,
    ring: dark ? rgba(accentText, 0.7 + c * 0.1) : inputs.accent, // --color-ring

    accent: inputs.accent, // --color-background-info-solid
    // --color-background-info-solid-hover: a fixed ramp step for the stock
    // accent; any other accent darkens by the same amount instead.
    accentHover:
      inputs.accent.toLowerCase() === CODEX_INPUTS[appearance].accent
        ? STOCK_ACCENT_HOVER
        : toHex(mix(accent, BLACK, 0.2)),
    controlAccent: inputs.accent,

    added: inputs.diffAdded, // --app-color-decoration-added
    addedSurface: rgba(hexToRgb(inputs.diffAdded), dark ? 0.23 : 0.15), // --app-color-editor-added
    removed: inputs.diffRemoved, // --app-color-decoration-deleted
    removedSurface: rgba(hexToRgb(inputs.diffRemoved), dark ? 0.23 : 0.15), // --app-color-editor-deleted
    warning: fixed.warning, // --color-text-warning
    info: toHex(accentText), // --color-text-info

    bubbleUser: rgba(text, fixed.userMessageAlpha), // --user-message-background-color
    bubbleAssistant: "transparent",
    // Code and tool-output panels sit ONE step above the chat sheet they open
    // on, with a faint edge (Alvan's desktop setup, 2026-10-28: #1a1a1a on a
    // #0f0f0f sheet, #222 edge). Codex's own code block is darker than its
    // window; on Aurora's recessed sheet that read as a hole with a bright rim.
    codeSurface: toHex(mix(under, dark ? ink : BLACK, 0.045)),
    codeBorder: rgba(ink, (dark ? 0.03 : 0.04) + c * 0.02), // --color-border-subtle
    chipSurface: rgba(ink, 0.04 + c * 0.02), // --color-background-secondary-soft
    chipText: rgba(text, 0.65),
    controlMuted: rgba(ink, 0.04 + c * 0.02), // --app-color-background-button-secondary
    hover: rgba(ink, (dark ? 0.06 : 0.04) + c * 0.03), // --color-background-primary-ghost-hover

    scrollThumb: border, // --color-token-scrollbar-slider-background
    scrollThumbHover: borderStrong, // --color-token-scrollbar-slider-hover-background

    // --menu-box-shadow: a 0.5px hairline in the border colour plus one soft drop.
    shadowPop: `0 0 0 0.5px ${border}, 0 8px 16px -4px rgba(0, 0, 0, 0.122)`,
  };
}
