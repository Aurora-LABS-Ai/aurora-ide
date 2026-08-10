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
import { AGENT_THEMES, DEFAULT_AGENT_THEME_ID } from "@/apps/agent/theme/themes";
import { applyContrast } from "@/apps/agent/theme/color";

export type AgentTokenKey = keyof AgentThemeTokens;

/** The canonical token-key list, derived from the default theme. */
export const AGENT_TOKEN_KEYS = Object.keys(
  AGENT_THEMES[DEFAULT_AGENT_THEME_ID].tokens,
) as AgentTokenKey[];
const TOKEN_KEY_SET = new Set<string>(AGENT_TOKEN_KEYS);

/** Neutral contrast — no adjustment. */
export const DEFAULT_CONTRAST = 50;
export const DEFAULT_RAIL_GLIDE_MS = 580;

interface AgentThemeState {
  activeThemeId: string;
  /** User/imported agent themes, keyed by id (override built-ins of same id). */
  customThemes: Record<string, AgentTheme>;
  /** Live token overrides per base-theme id (applied on top of the base). */
  customizations: Record<string, Partial<AgentThemeTokens>>;
  /** Frosted, semi-transparent left rail / dock. */
  translucentSidebar: boolean;
  /** 0–100, 50 = neutral. Scales foreground/line separation. */
  contrast: number;
  /** Honor reduced motion (disables non-essential animation). */
  reduceMotion: boolean;
  /** Syntax-highlight code in tool cards, the file viewer, and message code
   *  blocks. When off, code renders in a single foreground colour. */
  syntaxHighlighting: boolean;
  /** Glide the left rail / right dock open & closed. When off they snap
   *  instantly (no width animation). */
  railGlide: boolean;
  /** Rail/dock glide duration in ms (only used when `railGlide` is on). */
  railGlideMs: number;
  /** Where the composer model selector sits: the top control row (left) or the
   *  bottom action row (right). */
  modelSelectorPosition: "top" | "bottom";
  /** Keyboard chord that opens the agent-window command center. */
  commandCenterShortcut: string;
  /** Draw a continuous vertical rule down the transcript, with each row's
   *  marker sitting on it, so a turn reads as one thread of work instead of a
   *  stack of separate cards. Purely visual — off is today's look. */
  transcriptSpine: boolean;
  /** Pin each user message to the top of the transcript while its reply scrolls
   *  underneath, so the question stays on screen through a long answer. Purely
   *  visual — off is today's look. */
  transcriptStickyUser: boolean;

  setActiveTheme: (id: string) => void;
  registerTheme: (theme: AgentTheme) => void;
  /** Set a single token on the active theme — instant + persisted. */
  setToken: (key: AgentTokenKey, value: string) => void;
  /** Merge several token overrides onto the active theme. */
  setTokens: (partial: Partial<AgentThemeTokens>) => void;
  /** Drop ALL appearance customizations back to the active theme's defaults. */
  resetCustomizations: () => void;
  setTranslucentSidebar: (v: boolean) => void;
  setContrast: (v: number) => void;
  setReduceMotion: (v: boolean) => void;
  setSyntaxHighlighting: (v: boolean) => void;
  setRailGlide: (v: boolean) => void;
  setRailGlideMs: (v: number) => void;
  setModelSelectorPosition: (v: "top" | "bottom") => void;
  setCommandCenterShortcut: (shortcut: string) => void;
  setTranscriptSpine: (v: boolean) => void;
  setTranscriptStickyUser: (v: boolean) => void;
  /**
   * Apply a pasted/dropped theme JSON to the active theme. Accepts a full
   * `AgentTheme`, a `{ tokens: {...} }` wrapper, or a flat token map. Only
   * recognized token keys are applied. Throws on unusable input.
   */
  importThemeJson: (text: string) => { applied: number };
}

export const useAgentThemeStore = create<AgentThemeState>()(
  persist(
    (set, get) => ({
      activeThemeId: DEFAULT_AGENT_THEME_ID,
      customThemes: {},
      customizations: {},
      translucentSidebar: false,
      contrast: DEFAULT_CONTRAST,
      reduceMotion: false,
      syntaxHighlighting: true,
      railGlide: true,
      railGlideMs: DEFAULT_RAIL_GLIDE_MS,
      modelSelectorPosition: "bottom",
      commandCenterShortcut: "Mod+K",
      transcriptSpine: false,
      transcriptStickyUser: false,

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
          return {
            customizations: next,
            contrast: DEFAULT_CONTRAST,
            translucentSidebar: false,
            reduceMotion: false,
            syntaxHighlighting: true,
            railGlide: true,
            railGlideMs: DEFAULT_RAIL_GLIDE_MS,
            transcriptSpine: false,
            transcriptStickyUser: false,
          };
        }),

      setTranslucentSidebar: (v) => set({ translucentSidebar: v }),
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

      importThemeJson: (text) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          throw new Error("That file isn't valid JSON.");
        }
        const obj = parsed as Record<string, unknown> | null;
        const rawTokens =
          obj && typeof obj === "object" && obj.tokens && typeof obj.tokens === "object"
            ? (obj.tokens as Record<string, unknown>)
            : (obj as Record<string, unknown> | null);
        if (!rawTokens || typeof rawTokens !== "object") {
          throw new Error("No theme tokens found in that file.");
        }
        const partial: Partial<AgentThemeTokens> = {};
        for (const [k, v] of Object.entries(rawTokens)) {
          if (TOKEN_KEY_SET.has(k) && typeof v === "string") {
            (partial as Record<string, string>)[k] = v;
          }
        }
        const applied = Object.keys(partial).length;
        if (applied === 0) {
          throw new Error("No recognizable agent-window tokens in that file.");
        }
        get().setTokens(partial);
        return { applied };
      },
    }),
    {
      name: "aurora-agent-window-theme",
      partialize: (s) => ({
        activeThemeId: s.activeThemeId,
        customThemes: s.customThemes,
        customizations: s.customizations,
        translucentSidebar: s.translucentSidebar,
        contrast: s.contrast,
        reduceMotion: s.reduceMotion,
        syntaxHighlighting: s.syntaxHighlighting,
        railGlide: s.railGlide,
        railGlideMs: s.railGlideMs,
        modelSelectorPosition: s.modelSelectorPosition,
        commandCenterShortcut: s.commandCenterShortcut,
        transcriptSpine: s.transcriptSpine,
        transcriptStickyUser: s.transcriptStickyUser,
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
  const overrides = state.customizations[state.activeThemeId];
  const tokens = overrides ? { ...base.tokens, ...overrides } : base.tokens;
  return {
    ...base,
    tokens: applyContrast(tokens, base.appearance, state.contrast),
  };
}

/** Back-compat selector alias. */
export const selectActiveAgentTheme = resolveAgentTheme;

/** All selectable themes (built-ins + user customs), de-duped by id. */
export function selectAllAgentThemes(state: AgentThemeState): AgentTheme[] {
  const map = new Map<string, AgentTheme>();
  for (const t of Object.values(AGENT_THEMES)) map.set(t.id, t);
  for (const t of Object.values(state.customThemes)) map.set(t.id, t);
  return Array.from(map.values());
}
