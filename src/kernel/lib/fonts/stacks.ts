/**
 * Font stacks — the ONE place a font family is decided.
 *
 * Every surface in both windows derives its families from here:
 *
 *   Agent window   `themes.ts` seeds the `fontUi` / `fontCode` theme tokens
 *                  from these stacks → `--agw-font-ui` / `--agw-font-code` on
 *                  `.agw-root` → every `.agw-*` rule, the canvas iframes, and
 *                  the agent terminal.
 *   IDE window     `useSettingsStore.applyUiPreferences` resolves its UI-font
 *                  presets onto `--aurora-ui-font-family`; the code font is
 *                  `--aurora-code-font-family` (set at boot from this module)
 *                  plus direct imports where a component needs a concrete
 *                  string (Monaco, xterm).
 *
 * If a family name is typed anywhere else — a component, a CSS literal, an
 * inline style — that is a bug: it will not follow the user's font settings
 * and will drift from what the rest of the window renders. Import from here
 * or read the CSS variable instead.
 */

/** Shared sans tail: what everything falls back to when nothing else loads. */
export const UI_FONT_FALLBACK =
  '"Segoe UI", system-ui, -apple-system, sans-serif';

/**
 * Agent-window UI stack. "Inter Variable" is the family the bundled
 * @fontsource-variable face registers — it is NOT interchangeable with
 * "Inter" (the static face), so it must come first or the variable weight
 * axis is never used and half-step weights (550/650) snap to statics.
 */
export const AGENT_UI_FONT_STACK = `"Inter Variable", "Inter", ${UI_FONT_FALLBACK}`;

/**
 * Code stack, shared by BOTH windows. JetBrains Mono is bundled (400 + 600),
 * so it resolves identically on every machine; the rest is defensive.
 */
export const CODE_FONT_STACK =
  '"JetBrains Mono", "Cascadia Code", "Cascadia Mono", Consolas, "Fira Code", ui-monospace, monospace';

/** Quote a family name for CSS unless it is a bare identifier or already quoted. */
export function quoteFamily(family: string): string {
  const trimmed = family.trim();
  if (/^["']/.test(trimmed)) return trimmed;
  return /^[a-zA-Z_-][a-zA-Z0-9_-]*$/.test(trimmed) ? trimmed : `"${trimmed}"`;
}

/** First family in a stack, unquoted — what a picker should display. */
export function primaryFamily(stack: string): string {
  const first = stack.split(",")[0] ?? "";
  return first.trim().replace(/^["']|["']$/g, "");
}

/**
 * Build a full stack from a picked family: the family first, then the
 * canonical fallback chain (minus a duplicate of itself). This is what a
 * font picker writes into a token — picking "Cambria" must not throw away
 * the fallbacks that keep missing glyphs and missing installs rendering.
 */
export function stackWithPrimary(family: string, baseStack: string): string {
  const bare = family.trim().replace(/^["']|["']$/g, "");
  if (!bare) return baseStack;
  const rest = baseStack
    .split(",")
    .map((f) => f.trim())
    .filter((f) => f.replace(/^["']|["']$/g, "").toLowerCase() !== bare.toLowerCase());
  return [quoteFamily(bare), ...rest].join(", ");
}
