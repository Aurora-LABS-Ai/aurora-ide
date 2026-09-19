/**
 * Agent Window — the exported appearance FILE (theme concern, pure).
 *
 * One shape, built once and read once, so "export, move machine, import"
 * reproduces the window rather than approximating it.
 *
 * ```jsonc
 * {
 *   "id": "agent-dark-custom",
 *   "name": "Aurora Dark (custom)",
 *   "appearance": "dark",        // light/dark, so a file knows its own mode
 *   "themeId": "agent-dark",     // the BASE the tokens were authored against
 *   "tokens": { … },             // every colour, type and radius token
 *   "preferences": { … },        // every switch, slider and segmented control
 *   "iconPack": "seti"           // Layout → File icons
 * }
 * ```
 *
 * ## What an importer is promised
 *
 * - **Present wins.** Any field the file carries is applied.
 * - **Absent is left alone.** A file with only `tokens` (a Cursor/Claude-style
 *   map, or an Aurora export from before preferences travelled) changes colours
 *   and touches nothing else. This is why `parseAppearancePrefs` returns a
 *   PARTIAL rather than a filled object with defaults: defaulting an absent
 *   field would silently reset settings the file never mentioned.
 * - **Complete in, identical out.** A file carrying everything reproduces the
 *   look exactly. That is what `appearance-file.test.ts` asserts by round
 *   tripping a fully non-default state.
 *
 * ## Why `themeId` has to be in there
 *
 * Tokens are stored as overrides ON a base theme, and the export flattens the
 * merge, so colour alone would survive without it. `appearance` would not: it
 * is a property of the base theme, it lands on `.agw-root` as
 * `data-appearance`, and V2's light-mode block keys off it. Importing a light
 * export onto a dark install without switching the base gives light colours
 * wearing dark-mode shadows.
 */

import type { AgentAppearance, AgentThemeTokens } from "../types";
import {
  type AppearancePrefs,
  exportableAppearancePrefs,
  parseAppearancePrefs,
} from "./appearance-prefs";

export interface AppearanceFile {
  id: string;
  name: string;
  appearance: AgentAppearance;
  themeId: string;
  tokens: AgentThemeTokens;
  preferences: Partial<AppearancePrefs>;
  iconPack?: string;
}

export interface AppearanceFileSource {
  themeId: string;
  themeName: string;
  appearance: AgentAppearance;
  /** The fully merged tokens the window is rendering, not the raw overrides. */
  tokens: AgentThemeTokens;
  prefs: AppearancePrefs;
  iconPack?: string;
}

/** Build the file for the state currently on screen. */
export function buildAppearanceFile(source: AppearanceFileSource): AppearanceFile {
  return {
    id: `${source.themeId}-custom`,
    name: `${source.themeName} (custom)`,
    appearance: source.appearance,
    themeId: source.themeId,
    tokens: source.tokens,
    preferences: exportableAppearancePrefs(source.prefs),
    ...(source.iconPack ? { iconPack: source.iconPack } : {}),
  };
}

export interface ParsedAppearanceFile {
  /** Recognized token overrides. Empty when the file carries none. */
  tokens: Partial<AgentThemeTokens>;
  /** Recognized preferences. Absent keys stay absent. */
  prefs: Partial<AppearancePrefs>;
  /** The base theme to switch to, when the file names one. */
  themeId: string | null;
  /** Light/dark the file was authored in, used to pick a base when `themeId`
   *  names a theme this install does not have. */
  appearance: AgentAppearance | null;
  iconPack: string | null;
  tokenCount: number;
  prefCount: number;
  /** Keys that were present but unusable, for an honest message. */
  skipped: string[];
}

/**
 * Parse an imported file. Accepts, in order of specificity:
 *   - a full Aurora appearance file (this module's shape)
 *   - `{ tokens: { … } }` from any older export
 *   - a FLAT token map (Cursor / Claude style), which is what the drop zone
 *     has always advertised
 *
 * `isTokenKey` is passed in rather than imported so this module stays pure and
 * free of a dependency on the store that owns the canonical key list.
 */
export function parseAppearanceFile(
  text: string,
  isTokenKey: (key: string) => boolean,
): ParsedAppearanceFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("That file isn't valid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("That file isn't an appearance theme.");
  }
  const root = parsed as Record<string, unknown>;

  // A nested `tokens` object wins; otherwise treat the root as a flat map. A
  // flat map is only read for keys we recognize, so the sibling `preferences`
  // / `themeId` fields of a full file never leak into it.
  const rawTokens =
    root.tokens && typeof root.tokens === "object" && !Array.isArray(root.tokens)
      ? (root.tokens as Record<string, unknown>)
      : root;

  const tokens: Record<string, string> = {};
  for (const [key, value] of Object.entries(rawTokens)) {
    if (isTokenKey(key) && typeof value === "string") tokens[key] = value;
  }

  const { prefs, applied: prefCount, skipped } = parseAppearancePrefs(root.preferences);

  const themeId = typeof root.themeId === "string" ? root.themeId : null;
  const appearance =
    root.appearance === "light" || root.appearance === "dark" ? root.appearance : null;
  const iconPack = typeof root.iconPack === "string" ? root.iconPack : null;

  const tokenCount = Object.keys(tokens).length;
  if (tokenCount === 0 && prefCount === 0 && !themeId && !iconPack) {
    throw new Error("No recognizable Aurora appearance settings in that file.");
  }

  return {
    tokens: tokens as Partial<AgentThemeTokens>,
    prefs,
    themeId,
    appearance,
    iconPack,
    tokenCount,
    prefCount,
    skipped,
  };
}

/**
 * One line describing what an import actually did. Says every part that landed
 * and stays silent about the parts a file did not carry — a token-only file
 * reporting "0 preferences" reads like a failure when it is the documented
 * behaviour.
 */
export function describeImport(result: {
  tokenCount: number;
  prefCount: number;
  themeSwitched: boolean;
  iconPackApplied: boolean;
  skipped: string[];
}): string {
  const parts: string[] = [];
  if (result.themeSwitched) parts.push("base theme");
  if (result.tokenCount > 0) {
    parts.push(`${result.tokenCount} colour${result.tokenCount === 1 ? "" : "s"}`);
  }
  if (result.prefCount > 0) {
    parts.push(`${result.prefCount} setting${result.prefCount === 1 ? "" : "s"}`);
  }
  if (result.iconPackApplied) parts.push("file icons");
  const applied = parts.length > 0 ? `Applied ${parts.join(", ")}.` : "Nothing to apply.";
  if (result.skipped.length === 0) return applied;
  return `${applied} Skipped ${result.skipped.join(", ")}.`;
}
