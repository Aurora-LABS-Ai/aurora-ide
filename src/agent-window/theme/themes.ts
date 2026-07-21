/**
 * Agent Window — built-in themes.
 *
 * The default dark theme is sampled DIRECTLY from the Codex desktop app (the
 * agreed design target): a uniform near-black canvas (#101010) with a single
 * lighter composer/card fill (#2E2E2E) whose contrast against the canvas does
 * the work of a border (no glow). Aurora's iris accent is retained for brand.
 * Values live here (not read from JSON) because the agent-window theme is
 * intentionally isolated — it owns its own `--agw-*` set and can diverge per
 * user choice without touching the IDE theme.
 */

import type { AgentTheme } from "../types";

const SHARED_TYPE = {
  // Inter is bundled (@fontsource/inter, imported by AgentThemeProvider) so the
  // agent window renders a dedicated face rather than falling back to system UI.
  fontUi: '"Inter", "Segoe UI", system-ui, -apple-system, sans-serif',
  // JetBrains Mono if present, else Cascadia Code / Consolas (ship with Windows)
  // so code still uses a dedicated mono without an extra package.
  fontCode:
    '"JetBrains Mono", "Cascadia Code", "Cascadia Mono", Consolas, "Fira Code", ui-monospace, monospace',
  radiusSm: "6px",
  radiusMd: "10px",
  radiusLg: "14px",
} as const;

/** Default dark theme — two-layer shell: a lighter FRAME (canvas/rail/dock +
 * gutters) around a darker recessed content SHEET (conversation). The sheet
 * reads as a stage sunken into a bezel — the frame/sheet contrast does the
 * layering, not lines. Input fill (#2E2E2E) retained from the Codex sample. */
export const agentDark: AgentTheme = {
  id: "agent-dark",
  name: "Aurora Dark",
  appearance: "dark",
  tokens: {
    // surfaces — frame tier (canvas/rail/dock) sits LIGHTER than the sheet
    canvas: "#161616",
    rail: "#161616",
    conversation: "#0f0f0f", // recessed content sheet
    dock: "#161616",
    surface: "#1d1d1d", // subtle hover / quiet cards
    surfaceElevated: "#2e2e2e", // menus, pills, selected rows (Codex input fill)
    composerSurface: "#2e2e2e", // message input — own token, defaults to elevated
    overlay: "#000000aa",

    // text — Codex near-white on black
    text: "#ededed",
    textMuted: "#a0a0a0",
    textSubtle: "#727272",
    onAccent: "#ffffff",

    // lines — subtle; the fill contrast carries most of the separation
    border: "#222222",
    borderStrong: "#383838",
    ring: "#3994bc",

    // brand — Aurora iris accent (retained)
    accent: "#3994bc",
    accentHover: "#48a0c7",

    // semantic
    added: "#73c991",
    addedSurface: "#347d3926",
    removed: "#f48771",
    removedSurface: "#c93c3726",
    warning: "#e5ba7d",
    info: "#3a94bc",

    // conversation atoms
    bubbleUser: "#ffffff0f",
    bubbleAssistant: "transparent",
    codeSurface: "#1a1a1a",
    codeBorder: "#2a2a2a",
    chipSurface: "#1e1e1e",
    chipText: "#a0a0a0",
    controlMuted: "#ffffff14",
    hover: "#ffffff0a",

    // scrollbar
    scrollThumb: "#80808033",
    scrollThumbHover: "#80808066",

    // elevation
    shadowPop: "0 8px 24px rgba(0, 0, 0, 0.4)",

    ...SHARED_TYPE,
  },
};

/** Companion light theme. Same two-layer shell, inverted for light: the frame
 * is a soft cool gray and the recessed sheet is brighter paper white. */
export const agentLight: AgentTheme = {
  id: "agent-light",
  name: "Agent — Daylight",
  appearance: "light",
  tokens: {
    canvas: "#f0f1f4",
    rail: "#f0f1f4",
    conversation: "#ffffff",
    dock: "#f0f1f4",
    surface: "#ffffff",
    surfaceElevated: "#ffffff",
    composerSurface: "#ffffff",
    overlay: "rgba(15, 18, 24, 0.32)",

    text: "#1a1d23",
    textMuted: "#5b6472",
    textSubtle: "#8a93a3",
    onAccent: "#ffffff",

    border: "rgba(16, 22, 33, 0.10)",
    borderStrong: "rgba(16, 22, 33, 0.18)",
    ring: "#4f6bff",

    accent: "#4f6bff",
    accentHover: "#3a57f0",

    added: "#1a7f37",
    addedSurface: "rgba(26, 127, 55, 0.12)",
    removed: "#cf222e",
    removedSurface: "rgba(207, 34, 46, 0.10)",
    warning: "#9a6700",
    info: "#0969da",

    bubbleUser: "#eef1f6",
    bubbleAssistant: "transparent",
    codeSurface: "#f4f5f7",
    codeBorder: "rgba(16, 22, 33, 0.10)",
    chipSurface: "rgba(16, 22, 33, 0.05)",
    chipText: "#3a414d",
    controlMuted: "rgba(16, 22, 33, 0.06)",
    hover: "rgba(16, 22, 33, 0.04)",

    scrollThumb: "rgba(16, 22, 33, 0.18)",
    scrollThumbHover: "rgba(16, 22, 33, 0.3)",

    shadowPop: "0 8px 24px rgba(16, 22, 33, 0.14)",

    ...SHARED_TYPE,
  },
};

export const AGENT_THEMES: Record<string, AgentTheme> = {
  [agentDark.id]: agentDark,
  [agentLight.id]: agentLight,
};

export const DEFAULT_AGENT_THEME_ID = agentDark.id;
