# Aurora Theme Development

Aurora is fully theme-driven. **Every product color in the UI must come from this contract** — either a CSS variable (`var(--aurora-…)`) or a Tailwind utility that maps to one. This document is the single source of truth: the token list below is what theme JSON files declare, what the runtime injects into `:root`, and what components are allowed to consume.

If you are about to write a hardcoded color in a component, stop and either pick an existing token below or add a new one (instructions at the bottom).

## TL;DR for component authors

```tsx
// Good — uses the token contract
<div className="bg-sidebar text-text-primary border-border" />
<div style={{ background: "var(--aurora-chat-surface)" }} />

// Also good — arbitrary value that is a theme variable
<div className="bg-[var(--aurora-editor-background)]" />

// Bad — hardcoded color
<div className="bg-[#1f1f1f] text-[#cccccc]" />
<div style={{ background: "rgba(0, 0, 0, 0.45)" }} />
```

The only legitimate hardcoded colors are:

- Brand assets shipped as icons (e.g. `FileIcons.tsx` SVG fills)
- The `, #fallback` second argument to `var()` — kept so SSR / pre-hydration renders something readable

## Source files

| File | Role |
|------|------|
| `src/kernel/types/theme.ts` | `ThemeTokens`, `ThemeFile`, `ThemeDefinition` shapes |
| `src/apps/ide/services/theme-service.ts` | Validation, CSS variable injection, Monaco conversion, `DEFAULT_DARK_TOKENS` / `DEFAULT_LIGHT_TOKENS` |
| `src/themes/*.json` | Built-in themes (`dark`, `light`, `high-contrast`, `dark-neutral`, `alvan-aurora-dark`) |
| `src/themes/index.ts` | Built-in theme registry and IDs |
| `src/apps/ide/store/useThemeStore.ts` | Theme persistence, active-theme switching, custom-theme rows from SQLite |
| `tailwind.config.js` | Tailwind utilities mapped onto theme variables |
| `src/index.css` | Body, scrollbars, focus rings, markdown-content — all theme-driven |
| `src/apps/ide/features/settings/ThemeSettingsTab.tsx` | Appearance UI |
| `src/apps/ide/features/theme/ThemeEditorTab.tsx` | In-app theme editor |

> This contract covers the **IDE** surface. The Agent Window is a separate theme system:
> `src/apps/agent/theme/tokens.ts` maps `AgentThemeTokens` onto `--agw-*` custom properties on
> `.agw-root`, and all its styles live in the numbered partials under
> `src/apps/agent/theme/agent-window/` (no Tailwind, no hardcoded colors).

## Theme file shape

```json
{
  "name": "Theme Name",
  "author": "Author",
  "version": "1.0.0",
  "type": "dark",
  "description": "Optional description",
  "colors": { /* partial ThemeTokens */ },
  "tokenColors": [ /* TextMate-style rules */ ]
}
```

| Field | Type | Notes |
|---|---|---|
| `name` | string | Display name shown in Appearance. |
| `author` | string | Combined with `name` to generate stable custom-theme IDs. |
| `version` | string | Semver recommended (`1.0.0`). |
| `type` | `"dark"` \| `"light"` | Picks the base fallback theme. |
| `description` | string? | Optional. Shown in Appearance. |
| `colors` | object | Partial or complete `ThemeTokens`. Missing tokens fall back to `DEFAULT_DARK_TOKENS` or `DEFAULT_LIGHT_TOKENS` depending on `type`. |
| `tokenColors` | array | TextMate rules converted to Monaco token rules. |

**Important:** when `type` is `"light"`, missing tokens fall back to `DEFAULT_LIGHT_TOKENS`, and vice versa. So an unset token in a light theme will not accidentally pull in a dark color. But **a partial dark theme that omits, say, `common.textPrimary` will inherit the default dark text color**, which may differ from your theme's text palette. **Built-in themes should always declare every token**; only custom themes should be partial.

Color values accept `#RGB`, `#RGBA`, `#RRGGBB`, `#RRGGBBAA`, `rgb(...)`, and `rgba(...)`.

```json
"#1f1f1f"
"#264f7866"
"rgb(31 31 31)"
"rgba(38, 79, 120, 0.4)"
```

## CSS variable naming

| JSON path | CSS variable |
|---|---|
| `colors.editor.background` | `--aurora-editor-background` |
| `colors.chat.inputBackground` | `--aurora-chat-input-background` |
| `colors.statusBar.itemHover` | `--aurora-status-bar-item-hover` |
| `colors.titleBar.buttonHover` | `--aurora-title-bar-button-hover` |
| `colors.common.primaryForeground` | `--aurora-common-primary-foreground` |
| `colors.common.shadowElevated` | `--aurora-common-shadow-elevated` |

Rule: `--aurora-{category-kebab}-{token-kebab}`. The conversion is done in `getCSSVariableName()`.

## Categories

Aurora has seven token categories:

| Category | Purpose |
|---|---|
| `editor` | Monaco editor surface and editor-adjacent visuals |
| `sidebar` | Explorer, Git panel, side panels, tree rows |
| `chat` | Chat panel, agent mode, messages, input, code blocks |
| `terminal` | Integrated terminal and ANSI palette |
| `statusBar` | Bottom status bar |
| `titleBar` | Custom app title bar and window controls |
| `common` | Shared semantic colors used across the app |

---

## Editor tokens

| Token | CSS variable | Purpose |
|---|---|---|
| `background` | `--aurora-editor-background` | Main editor background |
| `foreground` | `--aurora-editor-foreground` | Main editor text |
| `lineNumbers` | `--aurora-editor-line-numbers` | Inactive line numbers |
| `lineNumbersActive` | `--aurora-editor-line-numbers-active` | Active line number |
| `selection` | `--aurora-editor-selection` | Primary selection background |
| `selectionHighlight` | `--aurora-editor-selection-highlight` | Other matching selections |
| `cursor` | `--aurora-editor-cursor` | Text cursor |
| `cursorLine` | `--aurora-editor-cursor-line` | Active line background |
| `whitespace` | `--aurora-editor-whitespace` | Whitespace glyphs |
| `indentGuide` | `--aurora-editor-indent-guide` | Indent guide rules |
| `matchingBracket` | `--aurora-editor-matching-bracket` | Bracket pair highlight |
| `wordHighlight` | `--aurora-editor-word-highlight` | Current-word highlight |
| `findMatch` | `--aurora-editor-find-match` | Active find result |
| `findMatchHighlight` | `--aurora-editor-find-match-highlight` | Other find results |

## Sidebar tokens

| Token | CSS variable | Purpose |
|---|---|---|
| `background` | `--aurora-sidebar-background` | Sidebar background |
| `foreground` | `--aurora-sidebar-foreground` | Sidebar text/icons |
| `border` | `--aurora-sidebar-border` | Section dividers |
| `itemHover` | `--aurora-sidebar-item-hover` | Tree-row hover |
| `itemActive` | `--aurora-sidebar-item-active` | Focused row |
| `itemSelected` | `--aurora-sidebar-item-selected` | Selected row |
| `sectionHeader` | `--aurora-sidebar-section-header` | Section header text |

The theme service auto-normalizes overly bright `itemHover`/`itemActive`/`itemSelected` values on dark themes (see `normalizeDarkSidebarInteractionTokens`) by mixing them with the sidebar background. Keep these subtle — pure-saturated colors will be dimmed at runtime.

## Chat tokens

| Token | CSS variable | Purpose |
|---|---|---|
| `background` | `--aurora-chat-background` | Chat / agent-mode background |
| `inputBackground` | `--aurora-chat-input-background` | Prompt input surface |
| `inputBorder` | `--aurora-chat-input-border` | Prompt input border |
| `surface` | `--aurora-chat-surface` | Message / panel surface |
| `surfaceBorder` | `--aurora-chat-surface-border` | Message / panel border |
| `surfaceMuted` | `--aurora-chat-surface-muted` | Subtle nested surface |
| `usageLow` | `--aurora-chat-usage-low` | Low context-usage indicator |
| `usageMedium` | `--aurora-chat-usage-medium` | Medium context-usage indicator |
| `usageHigh` | `--aurora-chat-usage-high` | High context-usage indicator |
| `userMessage` | `--aurora-chat-user-message` | User message background |
| `assistantMessage` | `--aurora-chat-assistant-message` | Assistant message background |
| `thinkingBackground` | `--aurora-chat-thinking-background` | Thinking block background |
| `thinkingBorder` | `--aurora-chat-thinking-border` | Thinking block border |
| `toolCallBackground` | `--aurora-chat-tool-call-background` | Tool-call background |
| `toolCallBorder` | `--aurora-chat-tool-call-border` | Tool-call border |
| `codeBlock` | `--aurora-chat-code-block` | Inline / fenced code surface |

## Terminal tokens

| Token | CSS variable | Purpose |
|---|---|---|
| `background` | `--aurora-terminal-background` | Terminal background |
| `foreground` | `--aurora-terminal-foreground` | Terminal foreground |
| `cursor` | `--aurora-terminal-cursor` | Terminal cursor |
| `selection` | `--aurora-terminal-selection` | Terminal selection |
| `black` | `--aurora-terminal-black` | ANSI black |
| `red` | `--aurora-terminal-red` | ANSI red |
| `green` | `--aurora-terminal-green` | ANSI green |
| `yellow` | `--aurora-terminal-yellow` | ANSI yellow |
| `blue` | `--aurora-terminal-blue` | ANSI blue |
| `magenta` | `--aurora-terminal-magenta` | ANSI magenta |
| `cyan` | `--aurora-terminal-cyan` | ANSI cyan |
| `white` | `--aurora-terminal-white` | ANSI white |
| `brightBlack` | `--aurora-terminal-bright-black` | Bright ANSI black |
| `brightRed` | `--aurora-terminal-bright-red` | Bright ANSI red |
| `brightGreen` | `--aurora-terminal-bright-green` | Bright ANSI green |
| `brightYellow` | `--aurora-terminal-bright-yellow` | Bright ANSI yellow |
| `brightBlue` | `--aurora-terminal-bright-blue` | Bright ANSI blue |
| `brightMagenta` | `--aurora-terminal-bright-magenta` | Bright ANSI magenta |
| `brightCyan` | `--aurora-terminal-bright-cyan` | Bright ANSI cyan |
| `brightWhite` | `--aurora-terminal-bright-white` | Bright ANSI white |

## Status bar tokens

| Token | CSS variable | Purpose |
|---|---|---|
| `background` | `--aurora-status-bar-background` | Status bar background |
| `foreground` | `--aurora-status-bar-foreground` | Status bar text |
| `border` | `--aurora-status-bar-border` | Top border |
| `itemHover` | `--aurora-status-bar-item-hover` | Item hover background |

## Title bar tokens

| Token | CSS variable | Purpose |
|---|---|---|
| `background` | `--aurora-title-bar-background` | Title bar background |
| `foreground` | `--aurora-title-bar-foreground` | Title bar text/icons |
| `border` | `--aurora-title-bar-border` | Title bar bottom border |
| `buttonHover` | `--aurora-title-bar-button-hover` | Window button hover |

## Common tokens

### Action and state colors

| Token | CSS variable | Purpose |
|---|---|---|
| `primary` | `--aurora-common-primary` | Primary action / brand accent |
| `primaryHover` | `--aurora-common-primary-hover` | Primary hover |
| `primaryForeground` | `--aurora-common-primary-foreground` | Text on primary surfaces |
| `secondary` | `--aurora-common-secondary` | Secondary surface |
| `secondaryHover` | `--aurora-common-secondary-hover` | Secondary hover |
| `secondaryForeground` | `--aurora-common-secondary-foreground` | Text on secondary surfaces |
| `success` | `--aurora-common-success` | Success state |
| `successForeground` | `--aurora-common-success-foreground` | Text on success surfaces |
| `warning` | `--aurora-common-warning` | Warning state |
| `warningForeground` | `--aurora-common-warning-foreground` | Text on warning surfaces |
| `error` | `--aurora-common-error` | Error state |
| `errorForeground` | `--aurora-common-error-foreground` | Text on error surfaces |
| `info` | `--aurora-common-info` | Informational state |
| `infoForeground` | `--aurora-common-info-foreground` | Text on info surfaces |
| `accent` | `--aurora-common-accent` | Secondary accent (file mentions, highlights) |
| `accentForeground` | `--aurora-common-accent-foreground` | Text on accent surfaces |
| `accentMuted` | `--aurora-common-accent-muted` | Low-emphasis accent surface |
| `destructive` | `--aurora-common-destructive` | Destructive action |
| `destructiveForeground` | `--aurora-common-destructive-foreground` | Text on destructive surfaces |
| `muted` | `--aurora-common-muted` | Muted surface |
| `mutedForeground` | `--aurora-common-muted-foreground` | Muted text |

### Surface and chrome

| Token | CSS variable | Purpose |
|---|---|---|
| `border` | `--aurora-common-border` | Default border (also set on Tailwind preflight) |
| `borderHover` | `--aurora-common-border-hover` | Hover border |
| `shadow` | `--aurora-common-shadow` | Default drop-shadow color |
| `shadowElevated` | `--aurora-common-shadow-elevated` | Heavier drop-shadow color for floating dialogs/popovers |
| `overlay` | `--aurora-common-overlay` | Generic overlay layer |
| `scrim` | `--aurora-common-scrim` | Modal/dialog backdrop scrim |
| `focusRing` | `--aurora-common-focus-ring` | Accessible focus-ring color (independent from `primary`) |
| `scrollbar` | `--aurora-common-scrollbar` | Scrollbar thumb |
| `scrollbarHover` | `--aurora-common-scrollbar-hover` | Scrollbar thumb hover |

### Text hierarchy

| Token | CSS variable | Purpose |
|---|---|---|
| `textPrimary` | `--aurora-common-text-primary` | Primary app text |
| `textSecondary` | `--aurora-common-text-secondary` | Secondary app text |
| `textDisabled` | `--aurora-common-text-disabled` | Disabled / placeholder text |

### Diff colors

| Token | CSS variable | Purpose |
|---|---|---|
| `diffAdded` | `--aurora-common-diff-added` | Added-line surface |
| `diffAddedForeground` | `--aurora-common-diff-added-foreground` | Added-line text |
| `diffRemoved` | `--aurora-common-diff-removed` | Removed-line surface |
| `diffRemovedForeground` | `--aurora-common-diff-removed-foreground` | Removed-line text |
| `diffModified` | `--aurora-common-diff-modified` | Modified-line surface |
| `diffModifiedForeground` | `--aurora-common-diff-modified-foreground` | Modified-line text |

### Status, tasks, security, actions

| Token | CSS variable | Purpose |
|---|---|---|
| `statusActive` | `--aurora-common-status-active` | Active status dot |
| `statusInactive` | `--aurora-common-status-inactive` | Inactive status dot |
| `statusError` | `--aurora-common-status-error` | Error status dot |
| `statusWarning` | `--aurora-common-status-warning` | Warning status dot |
| `taskPending` | `--aurora-common-task-pending` | Pending task |
| `taskInProgress` | `--aurora-common-task-in-progress` | In-progress task |
| `taskCompleted` | `--aurora-common-task-completed` | Completed task |
| `taskCancelled` | `--aurora-common-task-cancelled` | Cancelled task |
| `secureConnection` | `--aurora-common-secure-connection` | Secure connection indicator |
| `insecureConnection` | `--aurora-common-insecure-connection` | Insecure connection indicator |
| `localConnection` | `--aurora-common-local-connection` | Local connection indicator |
| `actionAnalyze` | `--aurora-common-action-analyze` | Analyze quick action |
| `actionDebug` | `--aurora-common-action-debug` | Debug quick action |
| `actionGenerate` | `--aurora-common-action-generate` | Generate quick action |
| `actionTest` | `--aurora-common-action-test` | Test quick action |
| `checkpoint` | `--aurora-common-checkpoint` | Checkpoint / restore accent |
| `checkpointForeground` | `--aurora-common-checkpoint-foreground` | Checkpoint / restore text |

---

## Syntax highlighting (`tokenColors`)

TextMate-style scopes. Aurora converts these into Monaco token rules via `convertToMonacoTheme()`.

```json
{
  "name": "Keywords",
  "scope": ["keyword", "storage.type", "storage.modifier"],
  "settings": {
    "foreground": "#569cd6",
    "fontStyle": "bold"
  }
}
```

Supported `fontStyle` values: `italic`, `bold`, `underline`, `strikethrough`, `italic bold`, `bold italic`.

The recommended baseline rules (Comments, Keywords, Strings, Functions, Types, Variables, Constants, Operators) are present in every built-in theme — use them as a starting point.

## Monaco mapping

Aurora maps its tokens to Monaco's color keys in `convertToMonacoTheme()`. You generally do **not** need to set any `editor.*` Monaco keys directly — they are derived from the corresponding Aurora tokens. The mapping covers, at minimum:

- All `editor.*` keys (background, foreground, line numbers, selection, cursor, indent guides, brackets, find match)
- Scrollbar and minimap thumb colors
- Editor widget, suggest widget, quick input, lists, menus, keybinding labels
- Input fields

If you add a new editor-adjacent surface, update `convertToMonacoTheme()` so themes can recolor it without touching Monaco directly.

## Tailwind utility mapping

`tailwind.config.js` aliases theme variables to Tailwind utility names. The wrapper `auroraColor()` produces `rgb(from var(...) r g b / <alpha-value>)`, so `bg-primary/40`, `text-text-primary`, `border-border-hover`, and `shadow-shadow-elevated/60` all work as expected.

Useful aliases:

| Utility | Token |
|---|---|
| `bg-editor`, `text-foreground` | `editor.background` / `editor.foreground` |
| `bg-sidebar`, `text-sidebar-foreground` | `sidebar.background` / `sidebar.foreground` |
| `bg-chat-bg`, `bg-msg-user`, `bg-msg-ai`, `bg-surface`, `bg-surface-muted` | chat surfaces |
| `bg-primary`, `text-primary-foreground`, `bg-primary-hover` | primary action |
| `bg-secondary`, `bg-muted`, `bg-accent`, `bg-destructive` | semantic surfaces |
| `text-text-primary`, `text-text-secondary`, `text-muted-foreground` | text hierarchy |
| `border-border`, `border-border-hover`, `border-border-focus` | borders |
| `bg-success`, `bg-warning`, `bg-error`, `bg-info` | status |
| `bg-diff-added`, `bg-diff-removed`, `bg-diff-modified` | diff highlights |
| `bg-scrim` | modal backdrop |
| `bg-shadow`, `bg-shadow-elevated` | drop-shadow color reference |
| `outline-focus-ring` | focus ring |
| `bg-usage-low`, `bg-usage-medium`, `bg-usage-high` | context-usage indicator |
| `bg-task-pending`, `bg-task-progress`, `bg-task-completed`, `bg-task-cancelled` | task states |
| `text-checkpoint`, `bg-checkpoint` | checkpoint accents |

If a token isn't aliased, use the arbitrary-value form: `bg-[var(--aurora-common-action-generate)]`.

## Runtime behavior

`applyTheme()` in `theme-service.ts`:

1. Calls `injectCSSVariables()` to write every token onto `:root` as `--aurora-…`
2. Normalizes overly bright sidebar `itemHover`/`itemActive`/`itemSelected` on dark themes
3. Sets `data-theme="dark"|"light"` and `data-theme-id="<id>"` on `<html>` (used by `color-scheme` and any theme-specific CSS)
4. Adds/removes the `dark` class on `<html>` for Tailwind `dark:` variants
5. Stores the active theme in memory for `getCurrentTheme()` / `getMonacoTheme()`

`color-scheme: dark|light` is also toggled in `index.css` based on `data-theme`, so native form controls (autofill, calendar picker, scrollbar fallback) match the active theme on Chromium.

## Component rules

1. **Never** hardcode a product color (hex, named, rgb/rgba) in a component or stylesheet. Brand-asset SVG fills and CSS-variable fallbacks (`var(--aurora-x, #fallback)`) are the only allowed exceptions.
2. Prefer Tailwind utilities that map to tokens. If a token isn't aliased, use `bg-[var(...)]`.
3. For overlay/scrim/shadow effects, use the dedicated tokens (`scrim`, `shadow`, `shadowElevated`) rather than `rgba(0, 0, 0, X)`.
4. For "tint of X" effects use `color-mix(in srgb, var(--aurora-...) NN%, transparent)` rather than guessing an alpha hex.
5. If a repeated UI role doesn't have a token (e.g. "git status added"), **add the token** before shipping the code. See below.

## Adding a new token

1. Add the field to the right interface in `src/kernel/types/theme.ts`.
2. Add a default value in **both** `DEFAULT_DARK_TOKENS` and `DEFAULT_LIGHT_TOKENS` in `src/apps/ide/services/theme-service.ts`.
3. Add the same field to every built-in theme in `src/themes/*.json` with a value tuned for that theme's palette. Partial themes (custom themes from users) will fall back to the default, but built-ins should declare every token explicitly.
4. (Optional) Add a Tailwind alias in `tailwind.config.js` if it will be used as `bg-`/`text-`/`border-` frequently.
5. (Optional) Map it into Monaco in `convertToMonacoTheme()` if it should affect the editor.
6. Add a row to the relevant table in this doc.

The validator (`validateThemeFile()`) accepts unknown keys silently; the field will simply not be applied. Once the type is updated and the runtime injects the new variable, every theme that defines it will work.

## Authoring checklist

- [ ] All seven categories present (built-ins should be complete; custom themes can be partial).
- [ ] Foreground/background contrast meets at least WCAG AA on body text.
- [ ] Sidebar `itemHover`/`itemActive`/`itemSelected` are subtle on dark themes (runtime will dim very bright values, but design for the final color).
- [ ] Scrim is dark enough that modals read as foregrounded against the editor on both deep-dark and light themes.
- [ ] `focusRing` has at least 3:1 contrast against the surfaces it overlays.
- [ ] Diff `Added`/`Removed`/`Modified` are distinguishable from each other and from `success`/`error`.
- [ ] Terminal ANSI palette is recognizable — don't fully recolor red/green/yellow into the theme's own hue.
- [ ] `tokenColors` set for at least the baseline scopes (Comments, Keywords, Strings, Functions, Types, Variables, Constants, Operators).
- [ ] Validate the JSON before importing (the Appearance import flow runs `validateThemeFile()` automatically).
- [ ] Test against the actual UI: chat panel, agent mode, terminal, git diff, modals, settings, file tree, status bar.

## Built-in themes

| ID | Type | Notes |
|---|---|---|
| `aurora-dark` | dark | Default. VS Code Modern Dark-inspired. |
| `aurora-light` | light | Default light theme. |
| `aurora-high-contrast` | dark | High-contrast accessibility theme. |
| `aurora-dark-neutral` | dark | Low-chroma dark for chat-heavy workflows. |
| `alvan-aurora-dark` | dark | Designer dark theme with cyan/teal accent. |

Built-in theme IDs are listed in `BUILT_IN_THEME_IDS` (`src/themes/index.ts`) and can't be overwritten by custom themes with the same display name.
