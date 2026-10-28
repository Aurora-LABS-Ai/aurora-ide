// @ts-expect-error The app intentionally omits Node typings; Vitest itself runs in Node.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import type { AgentAppearance } from "../types";
import { legibleAccent, MIN_ON_ACCENT_CONTRAST } from "./color";
import {
  AURORA_INPUTS,
  CODEX_INPUTS,
  contrastInput,
  derivePalette,
  type PaletteTokens,
} from "./palette";

const cwd = (globalThis as unknown as { process: { cwd: () => string } }).process.cwd();

/** Codex's own resolved tokens, both variants (`tokens/codex-tokens.resolved.json`). */
const resolved = JSON.parse(
  readFileSync(
    `${cwd}/thirdparty/aurora-visual-foundation-reference/tokens/codex-tokens.resolved.json`,
    "utf8",
  ),
) as Record<string, { light: string; dark: string }>;

/** Each derived token and the Codex token it must equal. */
const SAME_AS: Partial<Record<keyof PaletteTokens, string>> = {
  // Swapped on purpose (palette.ts): the frame is Codex's window colour, the
  // chat sheet Codex's recessed one.
  conversation: "--app-color-background-surface-under",
  rail: "--app-color-background-surface",
  canvas: "--app-color-background-surface",
  dock: "--app-color-background-surface",
  surface: "--color-background-panel",
  surfaceElevated: "--color-surface-elevated-secondary",
  // The composer takes the raised step (palette.ts), Codex's panel colour.
  composerSurface: "--color-background-panel",
  overlay: "--modal-backdrop-background",
  text: "--color-text",
  textMuted: "--color-text-secondary",
  textSubtle: "--color-text-tertiary",
  onAccent: "--app-color-text-on-accent",
  border: "--color-border",
  borderStrong: "--color-border-strong",
  ring: "--color-ring",
  accent: "--color-background-info-solid",
  accentHover: "--color-background-info-solid-hover",
  added: "--app-color-decoration-added",
  addedSurface: "--app-color-editor-added",
  removed: "--app-color-decoration-deleted",
  removedSurface: "--app-color-editor-deleted",
  warning: "--color-text-warning",
  info: "--color-text-info",
  bubbleUser: "--user-message-background-color",
  chipSurface: "--color-background-secondary-soft",
  controlMuted: "--app-color-background-button-secondary",
  hover: "--color-background-primary-ghost-hover",
  scrollThumb: "--color-token-scrollbar-slider-background",
  scrollThumbHover: "--color-token-scrollbar-slider-hover-background",
};

/** Tokens built from the text colour (not the ink), checked separately in dark. */
const TEXT_DERIVED = new Set(["text", "textMuted", "bubbleUser"]);

/** Codex writes `.5px` and `#0000001f`; compare the meaning, not the spelling. */
const normalize = (value: string): string =>
  value
    .replace(/\s+/g, " ")
    .replace(/\b0px\b/g, "0")
    .replace(/(^|[\s(])\.(\d)/g, "$10.$2")
    .replace(/#0000001f/g, "rgba(0, 0, 0, 0.122)")
    .trim();

describe("palette engine", () => {
  for (const appearance of ["dark", "light"] as AgentAppearance[]) {
    it(`reproduces Codex's stock ${appearance} theme`, () => {
      const tokens = derivePalette(CODEX_INPUTS[appearance], appearance);
      const differences: string[] = [];
      for (const [key, codexName] of Object.entries(SAME_AS)) {
        const ours = tokens[key as keyof PaletteTokens];
        // Dark text is pinned to the shipping app's measured #f0f0f0 rather than
        // the reference bundle's #dfdfdf (palette.ts VARIANT_FIXED), and the
        // tokens mixed from the text colour follow it.
        if (appearance === "dark" && TEXT_DERIVED.has(key)) continue;
        const theirs = resolved[codexName]?.[appearance];
        expect(theirs, `${codexName} is in the reference`).toBeDefined();
        if (normalize(ours) !== normalize(theirs)) differences.push(`${key}: ${ours} ≠ ${codexName} ${theirs}`);
      }
      expect(differences).toEqual([]);
      expect(normalize(tokens.shadowPop)).toBe(normalize(resolved["--menu-box-shadow"][appearance]));
    });
  }

  it("draws stock dark text at the shipping app's measured #f0f0f0", () => {
    const dark = derivePalette(CODEX_INPUTS.dark, "dark");
    expect(dark.text).toBe("#f0f0f0");
    expect(dark.textMuted).toBe("rgba(240, 240, 240, 0.65)");
  });

  it("lifts code and tool panels one step above the chat sheet, with a faint edge", () => {
    const dark = derivePalette(CODEX_INPUTS.dark, "dark");
    expect(dark.conversation).toBe("#141414");
    expect(dark.codeSurface).toBe("#1f1f1f");
    expect(dark.codeBorder).toBe("rgba(255, 255, 255, 0.042)");
  });

  it("the slider's neutral point is each variant's own default contrast", () => {
    expect(contrastInput("dark", 50)).toBe(60);
    expect(contrastInput("light", 50)).toBe(45);
    expect(contrastInput("dark", 0)).toBe(10);
    expect(contrastInput("dark", 100)).toBe(100);
  });

  it("more contrast means stronger lines and fainter-to-stronger text, never a new grey", () => {
    const base = derivePalette(CODEX_INPUTS.dark, "dark");
    const high = derivePalette({ ...CODEX_INPUTS.dark, contrast: 90 }, "dark");
    const alpha = (v: string) => Number(v.match(/,\s*([\d.]+)\)$/)?.[1]);
    expect(alpha(high.border)).toBeGreaterThan(alpha(base.border));
    expect(alpha(high.textSubtle)).toBeGreaterThan(alpha(base.textSubtle));
    // Contrast alone keeps the stock text; a changed surface takes the ink itself.
    expect(high.text).toBe("#f0f0f0");
    expect(derivePalette({ ...CODEX_INPUTS.dark, surface: "#101010" }, "dark").text).toBe("#ffffff");
  });

  it("Aurora's accent is Codex's walked to legibility on white and the light chat sheet", () => {
    expect(AURORA_INPUTS.dark).toEqual({ ...CODEX_INPUTS.dark, accent: "#2f90eb" });
    expect(AURORA_INPUTS.light).toEqual({ ...CODEX_INPUTS.light, accent: "#2f90eb" });
    const lightSheet = derivePalette(CODEX_INPUTS.light, "light").conversation;
    expect(
      legibleAccent(CODEX_INPUTS.dark.accent, ["#ffffff", lightSheet], MIN_ON_ACCENT_CONTRAST),
    ).toBe(AURORA_INPUTS.dark.accent);
  });
});
