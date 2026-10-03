/**
 * Agent Window — theme store (feature state).
 *
 * Holds the active agent-window theme id, user-registered custom themes, and a
 * set of live per-theme token overrides plus global appearance prefs (contrast,
 * translucent sidebar, reduce-motion). Every edit is applied instantly because
 * `AgentThemeProvider` resolves the merged theme straight from this store.
 * Isolated from the IDE's `useThemeStore` and persisted under its own key.
 */

import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { AgentTheme, AgentThemeTokens } from "@/apps/agent/types";
import {
  AGENT_THEMES,
  DEFAULT_AGENT_THEME_ID,
  TYPOGRAPHY_DEFAULTS,
  TYPOGRAPHY_TOKEN_KEYS,
} from "@/apps/agent/theme/themes";
import { applyContrast } from "@/apps/agent/theme/color";
import {
  type AgentUiVersion,
  type AppearancePrefKey,
  type AppearancePrefs,
  type ModelSelectorPosition,
  type RailEdge,
  type TranscriptReasoning,
  type TranscriptTextPace,
  APPEARANCE_PREFS,
  defaultAppearancePrefs,
  hasAppearancePrefChanges,
  resettableAppearancePrefs,
} from "@/apps/agent/theme/appearance-prefs";
import {
  type AppearanceFile,
  buildAppearanceFile,
  parseAppearanceFile,
} from "@/apps/agent/theme/appearance-file";

export type AgentTokenKey = keyof AgentThemeTokens;

/**
 * Which generation of the agent window's design is drawn.
 *
 * `classic` — what the window has always rendered. FROZEN: it keeps its
 *   current look and stops receiving design work, so it never needs to be
 *   re-verified alongside every future change.
 * `v2` — the newer look. Cards give up fill contrast and gain elevation (a
 *   light-catch, a contact shadow, a soft ambient one) plus a faint grain, and
 *   the densest pages are restructured — Providers moves to a pinned header
 *   with Connection / Models tabs instead of one long centred column.
 *
 * It is NOT a theme. It rides on top of whichever theme is active: every
 * colour stays the user's. And it is presentation only — same fields, same
 * actions, same stored values in both, so a bug report never has to begin with
 * "which look are you on?".
 *
 * Declared in `theme/appearance-prefs.ts` with the rest of the preference
 * table; re-exported here because this store has always been where it is
 * imported from.
 */
export type {
  AgentUiVersion,
  ModelSelectorPosition,
  RailEdge,
  TranscriptReasoning,
  TranscriptTextPace,
} from "@/apps/agent/theme/appearance-prefs";
export { DEFAULT_CONTRAST, DEFAULT_RAIL_GLIDE_MS } from "@/apps/agent/theme/appearance-prefs";

/** The canonical token-key list, derived from the default theme. */
export const AGENT_TOKEN_KEYS = Object.keys(
  AGENT_THEMES[DEFAULT_AGENT_THEME_ID].tokens,
) as AgentTokenKey[];
const TOKEN_KEY_SET = new Set<string>(AGENT_TOKEN_KEYS);
const isTokenKey = (key: string): boolean => TOKEN_KEY_SET.has(key);

/** The preference keys, in table order. Persistence, reset and export all walk
 *  this rather than restating the fields. */
const APPEARANCE_PREF_KEYS = Object.keys(APPEARANCE_PREFS) as AppearancePrefKey[];

/** Lift just the preference slice out of the store state. */
function currentAppearancePrefs(state: AppearancePrefs): AppearancePrefs {
  const out = {} as Record<string, unknown>;
  for (const key of APPEARANCE_PREF_KEYS) out[key] = state[key];
  return out as AppearancePrefs;
}

/**
 * Base tokens + the user's overrides, with the accent family kept together.
 *
 * ## Why `controlAccent` is not a plain override
 *
 * `controlAccent` is the tint on small controls that carry state by colour
 * alone — a switch that is on, the pinned tack, the unread badge. It exists as
 * its own token so a brand accent can go NEUTRAL (black, white) without an on
 * switch becoming indistinguishable from an off one. That is a real need, and
 * it is the only thing the separate token is for.
 *
 * Both built-in themes ship it equal to `accent`, and the intent written beside
 * it is "small controls follow the brand until someone separates them". They
 * did not follow. Changing Accent wrote one token and left the other at the
 * shipped value, so a tan theme drew tan sliders and blue switches on the same
 * settings page, and nobody had chosen that.
 *
 * So the base value behaves as a REFERENCE rather than a copy: a customized
 * accent carries `controlAccent` with it, and only an explicit `controlAccent`
 * override stops it. That is the same shape as a CSS `var()` default
 * (`--control-accent: var(--primary)`, overridden only by the one palette whose
 * brand is deliberately neutral), expressed here because Aurora's tokens are
 * values a colour picker writes, not CSS references it could not display.
 *
 * Deliberately NOT part of the family:
 * - `ring`, the focus outline, which has its own row and its own reason to stay
 *   neutral.
 * - `added` / `removed` / `warning`, which signal status. A status colour that
 *   moved with the theme would stop being a signal.
 */
export function mergeAgentTokens(
  baseTokens: AgentThemeTokens,
  overrides: Partial<AgentThemeTokens> | undefined,
): AgentThemeTokens {
  if (!overrides) return baseTokens;
  const tokens = { ...baseTokens, ...overrides };
  if (overrides.accent && overrides.controlAccent === undefined) {
    tokens.controlAccent = overrides.accent;
  }
  return tokens;
}

/** The base theme behind the active id: a user's own, then a built-in, then
 *  the default. Same cascade `resolveAgentTheme` uses, without the contrast
 *  pass — an export carries contrast as a PREFERENCE, so baking it into the
 *  tokens too would apply it twice on import. */
function resolveBaseTheme(state: {
  activeThemeId: string;
  customThemes: Record<string, AgentTheme>;
}): AgentTheme {
  return (
    state.customThemes[state.activeThemeId] ??
    AGENT_THEMES[state.activeThemeId] ??
    AGENT_THEMES[DEFAULT_AGENT_THEME_ID]
  );
}

/**
 * Which base theme an imported file should land on.
 *
 * Prefer the id the file names, when this install actually has it. A file from
 * someone's own custom theme names an id we have never seen, so fall back to
 * the first built-in matching the file's light/dark — that keeps
 * `data-appearance` correct, which is what V2's light-mode shadow block and
 * every `[data-appearance="light"]` rule read. Returning null means "leave the
 * active theme alone", which is what a bare token map deserves.
 */
function resolveImportTarget(
  state: { customThemes: Record<string, AgentTheme> },
  themeId: string | null,
  appearance: "light" | "dark" | null,
): string | null {
  if (themeId && (state.customThemes[themeId] ?? AGENT_THEMES[themeId])) return themeId;
  if (!appearance) return null;
  const match = Object.values(AGENT_THEMES).find((t) => t.appearance === appearance);
  return match?.id ?? null;
}

/**
 * The preference FIELDS come from `AppearancePrefs`, which is derived from the
 * table in `theme/appearance-prefs.ts` — they are deliberately not restated
 * here. Adding one to the table gives this store the field, the default, the
 * persistence, the reset and the export in one edit; adding one here alone does
 * not compile.
 */
interface AgentThemeState extends AppearancePrefs {
  activeThemeId: string;
  /** User/imported agent themes, keyed by id (override built-ins of same id). */
  customThemes: Record<string, AgentTheme>;
  /** Live token overrides per base-theme id (applied on top of the base). */
  customizations: Record<string, Partial<AgentThemeTokens>>;

  setActiveTheme: (id: string) => void;
  registerTheme: (theme: AgentTheme) => void;
  /** Set a single token on the active theme — instant + persisted. */
  setToken: (key: AgentTokenKey, value: string) => void;
  /** Merge several token overrides onto the active theme. */
  setTokens: (partial: Partial<AgentThemeTokens>) => void;
  /** Drop ALL appearance customizations back to the active theme's defaults. */
  resetCustomizations: () => void;
  /**
   * Drop only the TYPOGRAPHY overrides (fonts + every text size/weight/leading)
   * on the active theme, restoring the shipped professional baseline while
   * leaving colors, radius and every other customization untouched.
   */
  resetTypography: () => void;
  setTranslucentSidebar: (v: boolean) => void;
  setRailEdge: (v: RailEdge) => void;
  setUiVersion: (v: AgentUiVersion) => void;
  setContrast: (v: number) => void;
  setReduceMotion: (v: boolean) => void;
  setSyntaxHighlighting: (v: boolean) => void;
  setRailGlide: (v: boolean) => void;
  setRailGlideMs: (v: number) => void;
  setModelSelectorPosition: (v: ModelSelectorPosition) => void;
  setCommandCenterShortcut: (shortcut: string) => void;
  setTranscriptSpine: (v: boolean) => void;
  setTranscriptStickyUser: (v: boolean) => void;
  setTranscriptReasoning: (v: TranscriptReasoning) => void;
  setTranscriptToolRunsOpen: (v: boolean) => void;
  setTranscriptActionsVisible: (v: boolean) => void;
  setTranscriptTimestamps: (v: boolean) => void;
  setTranscriptSmoothTools: (v: boolean) => void;
  setTranscriptTextPace: (v: TranscriptTextPace) => void;
  setTranscriptTurnSummary: (v: boolean) => void;
  /**
   * Build the exportable appearance file for whatever is on screen: the base
   * theme's identity, the FULLY MERGED tokens, and every exportable
   * preference. The icon pack is passed in because it lives in the kernel's
   * settings store, shared with the editor window, not here.
   */
  buildAppearanceExport: (iconPack?: string) => AppearanceFile;
  /**
   * Apply a pasted / dropped / opened appearance JSON.
   *
   * Accepts this module's full file, an older `{ tokens: {...} }` export, or a
   * flat Cursor/Claude-style token map. Whatever the file carries is applied;
   * whatever it omits is left exactly as the user has it. Throws only when the
   * text is not JSON or carries nothing recognizable at all.
   *
   * `iconPack` comes back in the result rather than being applied here — this
   * store does not own it. The caller writes it to the settings store.
   */
  importAppearanceJson: (text: string) => {
    tokenCount: number;
    prefCount: number;
    themeSwitched: boolean;
    iconPack: string | null;
    skipped: string[];
  };
}

export const useAgentThemeStore = create<AgentThemeState>()(
  persist(
    (set, get) => ({
      activeThemeId: DEFAULT_AGENT_THEME_ID,
      customThemes: {},
      customizations: {},
      // Every preference default, spread from the table. Not restated here:
      // a field with a row in the table but no line here used to be a silent
      // `undefined` at runtime, which is how a switch ends up persisting
      // nothing while its test stays green.
      ...defaultAppearancePrefs(),

      setActiveTheme: (id) => set({ activeThemeId: id }),
      registerTheme: (theme) =>
        set((s) => ({ customThemes: { ...s.customThemes, [theme.id]: theme } })),

      setToken: (key, value) =>
        set((s) => ({
          customizations: {
            ...s.customizations,
            [s.activeThemeId]: {
              ...(s.customizations[s.activeThemeId] ?? {}),
              [key]: value,
            },
          },
        })),

      setTokens: (partial) =>
        set((s) => ({
          customizations: {
            ...s.customizations,
            [s.activeThemeId]: {
              ...(s.customizations[s.activeThemeId] ?? {}),
              ...partial,
            },
          },
        })),

      resetCustomizations: () =>
        set((s) => {
          const next = { ...s.customizations };
          delete next[s.activeThemeId];
          // Only the preferences the table marks `reset`. Spreading the whole
          // default set here would also clear the two Preferences-page fields
          // this button has never touched.
          return { customizations: next, ...resettableAppearancePrefs() };
        }),

      resetTypography: () =>
        set((s) => {
          const overrides = s.customizations[s.activeThemeId];
          if (!overrides) return s;
          const next = { ...overrides };
          for (const key of TYPOGRAPHY_TOKEN_KEYS) delete next[key];
          const customizations = { ...s.customizations };
          if (Object.keys(next).length === 0) delete customizations[s.activeThemeId];
          else customizations[s.activeThemeId] = next;
          return { customizations };
        }),

      setTranslucentSidebar: (v) => set({ translucentSidebar: v }),
      setRailEdge: (v) => set({ railEdge: v }),
      setUiVersion: (v) => set({ uiVersion: v }),
      setContrast: (v) => set({ contrast: Math.max(0, Math.min(100, Math.round(v))) }),
      setReduceMotion: (v) => set({ reduceMotion: v }),
      setSyntaxHighlighting: (v) => set({ syntaxHighlighting: v }),
      setRailGlide: (v) => set({ railGlide: v }),
      setRailGlideMs: (v) =>
        set({ railGlideMs: Math.max(120, Math.min(1200, Math.round(v))) }),
      setModelSelectorPosition: (v) => set({ modelSelectorPosition: v }),
      setCommandCenterShortcut: (commandCenterShortcut) => set({ commandCenterShortcut }),
      setTranscriptSpine: (v) => set({ transcriptSpine: v }),
      setTranscriptStickyUser: (v) => set({ transcriptStickyUser: v }),
      setTranscriptReasoning: (v) => set({ transcriptReasoning: v }),
      setTranscriptToolRunsOpen: (v) => set({ transcriptToolRunsOpen: v }),
      setTranscriptActionsVisible: (v) => set({ transcriptActionsVisible: v }),
      setTranscriptTimestamps: (v) => set({ transcriptTimestamps: v }),
      setTranscriptSmoothTools: (v) => set({ transcriptSmoothTools: v }),
      setTranscriptTextPace: (v) => set({ transcriptTextPace: v }),
      setTranscriptTurnSummary: (v) => set({ transcriptTurnSummary: v }),

      buildAppearanceExport: (iconPack) => {
        const s = get();
        const base = resolveBaseTheme(s);
        return buildAppearanceFile({
          themeId: base.id,
          themeName: base.name,
          appearance: base.appearance,
          // The MERGED tokens, not the override slice. An export holding only
          // the overrides is meaningless on a machine whose base theme differs,
          // and it would silently lose every value the user never touched.
          // Merged through the same helper the window renders from, so the file
          // carries the control accent the sender was actually looking at.
          tokens: mergeAgentTokens(base.tokens, s.customizations[s.activeThemeId]),
          prefs: currentAppearancePrefs(s),
          iconPack,
        });
      },

      importAppearanceJson: (text) => {
        const parsed = parseAppearanceFile(text, isTokenKey);

        // ORDER MATTERS. The theme switches first, because token overrides are
        // keyed by the ACTIVE theme id — writing them before the switch files
        // them under the outgoing theme, where the window will never read them.
        let themeSwitched = false;
        const target = resolveImportTarget(get(), parsed.themeId, parsed.appearance);
        if (target && target !== get().activeThemeId) {
          set({ activeThemeId: target });
          themeSwitched = true;
        }

        if (parsed.tokenCount > 0) get().setTokens(parsed.tokens);
        if (parsed.prefCount > 0) set(parsed.prefs as Partial<AgentThemeState>);

        return {
          tokenCount: parsed.tokenCount,
          prefCount: parsed.prefCount,
          themeSwitched,
          iconPack: parsed.iconPack,
          skipped: parsed.skipped,
        };
      },
    }),
    {
      name: "aurora-agent-window-theme",
      version: 1,
      // v0 → v1: prune STALE typography overrides so old snapshots stop
      // silently overriding the shipped baseline. Two cases only, both safe:
      //   - an override equal to a RETIRED default (the pre-variable Inter
      //     stack) — the user never chose it, a previous default wrote it;
      //   - an override equal to the CURRENT default — a render no-op that
      //     would still pin the user to today's value if the default improves.
      // Anything else is a deliberate choice and is never touched.
      migrate: (persisted) => {
        const state = persisted as {
          customizations?: Record<string, Partial<AgentThemeTokens>>;
        } | null;
        const customizations = state?.customizations;
        if (!customizations) return persisted;
        const retired = new Set<string>([
          '"Inter", "Segoe UI", system-ui, -apple-system, sans-serif',
        ]);
        for (const [themeId, overrides] of Object.entries(customizations)) {
          const next = { ...overrides };
          for (const key of TYPOGRAPHY_TOKEN_KEYS) {
            const value = next[key];
            if (value === undefined) continue;
            if (value === TYPOGRAPHY_DEFAULTS[key] || retired.has(value)) {
              delete next[key];
            }
          }
          if (Object.keys(next).length === 0) delete customizations[themeId];
          else customizations[themeId] = next;
        }
        return persisted;
      },
      // Persist the three theme fields explicitly, then EVERY preference by
      // walking the table. This list used to be hand-written beside the field
      // declarations, which is exactly how a setting ends up applying at
      // runtime and vanishing on restart without a single test going red.
      partialize: (s) => ({
        activeThemeId: s.activeThemeId,
        customThemes: s.customThemes,
        customizations: s.customizations,
        ...currentAppearancePrefs(s),
      }),
    },
  ),
);

/**
 * Resolve the fully-merged active theme: base (custom → built-in → default),
 * with the user's live token overrides applied, then the global contrast
 * adjustment. This is the single source of truth for what the window renders.
 */
export function resolveAgentTheme(state: AgentThemeState): AgentTheme {
  const base =
    state.customThemes[state.activeThemeId] ??
    AGENT_THEMES[state.activeThemeId] ??
    AGENT_THEMES[DEFAULT_AGENT_THEME_ID];
  const tokens = mergeAgentTokens(base.tokens, state.customizations[state.activeThemeId]);
  return {
    ...base,
    tokens: applyContrast(tokens, base.appearance, state.contrast),
  };
}

/** Back-compat selector alias. */
export const selectActiveAgentTheme = resolveAgentTheme;

/**
 * Does "Reset appearance" have anything to do, preference-wise?
 *
 * Returns a BOOLEAN, not the preference slice: a selector that builds a fresh
 * object every call re-renders its subscriber on every unrelated store write.
 *
 * Derived from the same `reset` flag `resetCustomizations` walks, so the button
 * and the action can no longer disagree. They did: the Reset button ignored the
 * two transcript switches while the reset itself cleared them, so turning on
 * the spine left the only control that would undo it greyed out.
 */
export function selectHasAppearancePrefChanges(state: AgentThemeState): boolean {
  return hasAppearancePrefChanges(currentAppearancePrefs(state));
}

/** All selectable themes (built-ins + user customs), de-duped by id. */
export function selectAllAgentThemes(state: AgentThemeState): AgentTheme[] {
  const map = new Map<string, AgentTheme>();
  for (const t of Object.values(AGENT_THEMES)) map.set(t.id, t);
  for (const t of Object.values(state.customThemes)) map.set(t.id, t);
  return Array.from(map.values());
}
