/**
 * Font boot — everything that must happen BEFORE first paint so text never
 * visibly changes face or size after the window appears.
 *
 * Two mechanisms, both driven from `main.tsx`:
 *
 * 1. `applyCachedUiPreferences()` — the IDE window's UI font + text scale live
 *    in SQLite and arrive over an async Tauri call, which used to mean the
 *    window painted at the CSS defaults (14px × 1, Inter) and then visibly
 *    re-set itself once settings loaded. `applyUiPreferences` now mirrors its
 *    last applied values into localStorage; this reads that mirror and applies
 *    the same CSS variables synchronously at boot. SQLite stays the authority —
 *    the mirror is only a paint-time cache, and a later authoritative apply
 *    with the same values is a no-op visually.
 *
 * 2. `preloadBundledFonts()` — the bundled faces (Inter static/variable,
 *    Manrope, JetBrains Mono, Geist) all register with `font-display: swap`,
 *    so the first paint used the platform fallback and swapped once the woff2
 *    arrived — the "text changes right after open" the owner reported. The
 *    assets are local, so forcing the fetch and waiting (briefly, capped) puts
 *    the real faces in place before React mounts. A face that cannot load
 *    within the cap must not hold the app hostage — the deadline resolves and
 *    the swap behaviour remains as the backstop.
 */

import { CODE_FONT_STACK } from "./stacks";

export const UI_PREFS_CACHE_KEY = "aurora-ui-prefs";

/** Matches `clampTextScale` in `useSettingsStore` — keep in lockstep. */
const clampScale = (value: number): number =>
  Math.min(1.4, Math.max(0.85, value));

interface CachedUiPrefs {
  /** RESOLVED CSS family stack (not a preset key). */
  fontFamily?: string;
  textScale?: number;
}

/** Write the mirror. Called by `applyUiPreferences` on every authoritative apply. */
export function cacheUiPreferences(resolvedFamily: string, textScale: number): void {
  try {
    localStorage.setItem(
      UI_PREFS_CACHE_KEY,
      JSON.stringify({ fontFamily: resolvedFamily, textScale } satisfies CachedUiPrefs),
    );
  } catch {
    // Quota/privacy failures only cost the next boot a flash, never the apply.
  }
}

/**
 * Apply the cached IDE UI preferences (and the code-font variable, which is
 * static) synchronously. Safe to call in any window — the agent window scopes
 * its own typography under `.agw-root` and ignores these variables.
 */
export function applyCachedUiPreferences(): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;

  // The code font has no user setting yet; the variable exists so every CSS
  // rule and component resolves the SAME stack from the same source.
  root.style.setProperty("--aurora-code-font-family", CODE_FONT_STACK);

  let cached: CachedUiPrefs | null = null;
  try {
    cached = JSON.parse(localStorage.getItem(UI_PREFS_CACHE_KEY) ?? "null");
  } catch {
    cached = null;
  }
  if (!cached || typeof cached !== "object") return;

  if (typeof cached.fontFamily === "string" && cached.fontFamily.trim()) {
    root.style.setProperty("--aurora-ui-font-family", cached.fontFamily);
  }
  if (typeof cached.textScale === "number" && Number.isFinite(cached.textScale)) {
    root.style.setProperty("--aurora-ui-text-scale", String(clampScale(cached.textScale)));
  }
}

/**
 * Force-load the bundled faces and resolve when they are usable (or when the
 * deadline passes — whichever is first). `document.fonts.load` is what makes
 * this real: @font-face registration alone is lazy, and `fonts.ready` resolves
 * immediately when nothing has *started* loading yet.
 */
/** Generic CSS families — never a real face to preload. */
const GENERIC = new Set([
  "serif",
  "sans-serif",
  "monospace",
  "system-ui",
  "ui-monospace",
  "ui-sans-serif",
  "ui-serif",
  "-apple-system",
  "blinkmacsystemfont",
  "cursive",
  "fantasy",
]);

/** First real family in a CSS stack — the one that will actually paint. */
function firstFamily(stack: string): string | null {
  for (const part of stack.split(",")) {
    const bare = part.trim().replace(/^["']|["']$/g, "");
    if (bare && !GENERIC.has(bare.toLowerCase())) return bare;
  }
  return null;
}

/**
 * Font families the user has actually CHOSEN, which are not necessarily the
 * shipped defaults.
 *
 * Preloading a fixed list of defaults only keeps the promise for people who
 * never opened Appearance. Pick a different face and it is no longer preloaded,
 * so the window paints in the fallback and swaps once the woff2 lands — the
 * exact startup re-typeset this module exists to prevent, reintroduced by the
 * act of customising. Bundling more faces makes that far more likely, so the
 * preload has to follow the user rather than the defaults.
 *
 * Two sources, because the two windows store this differently:
 *   - the IDE's stacks are already on the root element by the time this runs
 *     (`applyCachedUiPreferences` is synchronous and called first);
 *   - the agent window's live in its own persisted store and are applied at
 *     mount, so they are read straight from that snapshot. Only CUSTOMISED
 *     values matter — an untouched theme uses the defaults, already covered.
 */
function chosenFamilies(): string[] {
  const out: string[] = [];
  if (typeof document !== "undefined") {
    const root = getComputedStyle(document.documentElement);
    for (const name of ["--aurora-ui-font-family", "--aurora-code-font-family"]) {
      const family = firstFamily(root.getPropertyValue(name));
      if (family) out.push(family);
    }
  }
  try {
    const raw = localStorage.getItem("aurora-agent-window-theme");
    const parsed = raw ? JSON.parse(raw) : null;
    const state = parsed?.state ?? parsed;
    const overrides = state?.customizations?.[state?.activeThemeId];
    for (const key of ["fontUi", "fontCode"]) {
      const value = overrides?.[key];
      if (typeof value !== "string") continue;
      const family = firstFamily(value);
      if (family) out.push(family);
    }
  } catch {
    // A malformed or absent snapshot just means no custom faces to add. The
    // defaults below still load, so the window is never worse off than before.
  }
  return out;
}

export function preloadBundledFonts(deadlineMs = 350): Promise<void> {
  if (typeof document === "undefined" || !document.fonts?.load) {
    return Promise.resolve();
  }
  const fonts = [
    // One weight per family is enough to pull the file for variable faces;
    // statics fetch per-weight, so name the weights the UI actually uses.
    '400 1em "Inter Variable"',
    "400 1em Inter",
    "500 1em Inter",
    "600 1em Inter",
    "400 1em Manrope",
    '400 1em "JetBrains Mono"',
    "400 1em Geist",
  ];
  // The user's own picks, at the one weight that carries first paint. The other
  // bundled faces are deliberately NOT preloaded: they are options in a picker,
  // and fetching every one of them at boot would spend the deadline on bytes
  // nobody is about to look at.
  for (const family of chosenFamilies()) {
    const quoted = `400 1em "${family}"`;
    if (!fonts.includes(quoted)) fonts.push(quoted);
  }
  const loads = fonts.map((font) =>
    document.fonts.load(font).catch(() => {
      // A single failed face must not reject the whole preload.
    }),
  );
  return Promise.race([
    Promise.all(loads).then(() => undefined),
    new Promise<void>((resolve) => window.setTimeout(resolve, deadlineMs)),
  ]);
}
