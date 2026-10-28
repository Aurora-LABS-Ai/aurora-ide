/**
 * Agent Window — built-in themes.
 *
 * Both built-in themes are the Codex desktop app's stock themes: their colours
 * are not written here but DERIVED from Codex's four inputs (surface, ink,
 * accent, contrast) by `palette.ts`, which reproduces Codex's resolved values
 * exactly. Appearance's per-colour overrides sit on top of that, so a user can
 * still move any one colour. Type, radius and the other non-colour tokens are
 * Aurora's own (`SHARED_TYPE`).
 * The agent-window theme is intentionally isolated — it owns its own `--agw-*`
 * set and can diverge per user choice without touching the IDE theme.
 */

import type { AgentTheme } from "../types";
import { AGENT_UI_FONT_STACK, CODE_FONT_STACK } from "@/kernel/lib/fonts/stacks";
import { AURORA_INPUTS, derivePalette } from "./palette";

const SHARED_TYPE = {
  // Families come from the kernel font module — the single place a stack is
  // decided (see kernel/lib/fonts/stacks.ts for why "Inter Variable" leads).
  // These seed the fontUi/fontCode THEME TOKENS, which the user can override
  // in Appearance; the tokens, not these constants, are what CSS reads.
  fontUi: AGENT_UI_FONT_STACK,
  fontCode: CODE_FONT_STACK,
  // Display face. Seeded to the UI stack ON PURPOSE: the token exists so the
  // wordmark, page headings and dialog titles CAN take a second voice, and
  // shipping them already diverged would be choosing that voice for everyone.
  // Picking a display font in Appearance is what makes the two differ.
  fontDisplay: AGENT_UI_FONT_STACK,
  // ── Interface text size ───────────────────────────────────────────────────
  // Multiplier on the whole chrome scale (--agw-fs-micro … --agw-fs-title).
  // 1 = the authored 12/13/14/15/16/17. Chrome is otherwise fixed, so without
  // this the only text a user could resize was the transcript.
  uiTextScale: "1",
  // ── Message typography ────────────────────────────────────────────────────
  // The transcript's reading tiers, exposed as tokens so Appearance can tune
  // them. Taken from the reference's chat renderer — reply text 15px on 1.75
  // leading, your own bubbles a step below at 14px — NOT from its `body`
  // default (16/24), which styles nothing it actually renders. Weight is a
  // string because tokens are CSS variable values.
  msgFontSize: "15px",
  // 1.75 came from the reference; side by side with Claude desktop (1.33,
  // measured 2026-10-23) it spread every paragraph apart and read light.
  msgLineHeight: "1.5",
  msgFontWeight: "400",
  // Fenced blocks only. Inline code stays relative (0.8em) so chips sit inside
  // their sentence; a block is its own surface and holds an absolute size.
  msgCodeFontSize: "13px",
  msgUserFontSize: "14px",
  msgUserLineHeight: "1.5",
  // ── Radius: ONE scale for the whole window ────────────────────────────────
  // Roles, not sizes: `lg` is a container, `md` is a control, `sm` is anything
  // nested inside a container. Settings used to run a second scale
  // (--agw-set-r-card 16 / --agw-set-r-inner 12), so a settings card and a
  // chat card rounded differently for no reason a user could name — the same
  // "almost aligned" noise the type scale exists to prevent. That fork is gone;
  // both now resolve here.
  //
  // 14 → 12 and 10 → 8 so nesting is concentric: a `sm` (6) child inside an
  // `lg` (12) container with 6px padding keeps its corner parallel to the
  // parent's, which is the detail that separates "made" from "assembled".
  radiusSm: "6px",
  radiusMd: "8px",
  radiusLg: "12px",
  // Fully-round ends. 55 rules hardcoded `999px` before this existed.
  radiusPill: "999px",
} as const;

/** Default dark theme: Codex's stock dark, with its two window colours placed
 * Aurora's way: the frame (rails, dock) is `#181818` and the chat sheet sits a
 * step below it at `#141414`. Menus and the composer are raised mixes toward
 * the ink, and every line and secondary text is ink at an alpha. */
export const agentDark: AgentTheme = {
  id: "agent-dark",
  name: "Aurora Dark",
  appearance: "dark",
  palette: AURORA_INPUTS.dark,
  tokens: {
    ...derivePalette(AURORA_INPUTS.dark, "dark"),
    ...SHARED_TYPE,
  },
};

/** Companion light theme: Codex's stock light, placed the same way: a white
 * frame (`#ffffff`) around a chat sheet tinted toward the ink (`#f6f6f6`). */
export const agentLight: AgentTheme = {
  id: "agent-light",
  name: "Aurora Light",
  appearance: "light",
  palette: AURORA_INPUTS.light,
  tokens: {
    ...derivePalette(AURORA_INPUTS.light, "light"),
    ...SHARED_TYPE,
  },
};

export const AGENT_THEMES: Record<string, AgentTheme> = {
  [agentDark.id]: agentDark,
  [agentLight.id]: agentLight,
};

export const DEFAULT_AGENT_THEME_ID = agentDark.id;

/**
 * The typography subset of the token set — what "Reset typography" clears and
 * what the persisted-state migration is allowed to prune. Derived from
 * SHARED_TYPE minus the radius scale (radius is shape, not type).
 */
export const TYPOGRAPHY_TOKEN_KEYS = [
  "fontUi",
  "fontCode",
  "fontDisplay",
  "uiTextScale",
  "msgFontSize",
  "msgLineHeight",
  "msgFontWeight",
  "msgCodeFontSize",
  "msgUserFontSize",
  "msgUserLineHeight",
] as const satisfies ReadonlyArray<keyof typeof SHARED_TYPE>;

/** The professional baseline: what every typography token resets to. */
export const TYPOGRAPHY_DEFAULTS: Readonly<
  Record<(typeof TYPOGRAPHY_TOKEN_KEYS)[number], string>
> = Object.fromEntries(
  TYPOGRAPHY_TOKEN_KEYS.map((key) => [key, SHARED_TYPE[key]]),
) as Record<(typeof TYPOGRAPHY_TOKEN_KEYS)[number], string>;
