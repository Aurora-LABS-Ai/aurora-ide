# Aurora Theme Development

Aurora uses a centralized theme system based on CSS variables. Components should not hard-code product colors. They should read color values from variables generated from the active theme.

The variable naming format is:

```css
--aurora-{category}-{token}
```

Examples:

```css
background: var(--aurora-editor-background);
color: var(--aurora-editor-foreground);
border-color: var(--aurora-common-border);
```

This document is the token reference used by theme architecture notices in TSX, CSS, and MDTSX-style documentation.

## Source Files

- Theme types: `src/types/theme.ts`
- Theme service and validation: `src/services/theme-service.ts`
- Built-in themes: `src/themes/`
- Importable example themes: `example-themes/`
- Appearance UI: `src/components/modals/ThemeSettingsTab.tsx`

## Theme File Shape

Aurora themes are JSON files with this top-level shape:

```json
{
  "name": "Theme Name",
  "author": "Author",
  "version": "1.0.0",
  "type": "dark",
  "description": "Optional description",
  "colors": {},
  "tokenColors": []
}
```

Required fields:

| Field | Type | Notes |
| --- | --- | --- |
| `name` | string | Display name shown in Appearance. |
| `author` | string | Used with `name` to generate stable custom theme IDs. |
| `version` | string | Prefer semantic versioning such as `1.0.0`. |
| `type` | `"dark"` or `"light"` | Selects the base fallback theme. |
| `colors` | object | Partial or complete `ThemeTokens`. Missing tokens fall back to the base theme. |
| `tokenColors` | array | TextMate-style syntax rules converted to Monaco rules. |

Color values may be hex, RGB, or RGBA:

```json
"#1f1f1f"
"#264f7866"
"rgb(31 31 31)"
"rgba(38, 79, 120, 0.4)"
```

## CSS Variable Mapping

Theme token keys are camelCase in JSON and converted to kebab-case CSS variables.

| JSON path | CSS variable |
| --- | --- |
| `colors.editor.background` | `--aurora-editor-background` |
| `colors.chat.inputBackground` | `--aurora-chat-input-background` |
| `colors.statusBar.itemHover` | `--aurora-status-bar-item-hover` |
| `colors.titleBar.buttonHover` | `--aurora-title-bar-button-hover` |
| `colors.common.primaryForeground` | `--aurora-common-primary-foreground` |

## Token Categories

Aurora currently uses seven token categories:

| Category | Purpose |
| --- | --- |
| `editor` | Monaco editor and editor-adjacent surfaces. |
| `sidebar` | Explorer, Git panel, sidebars, tree rows. |
| `chat` | Chat panel, agent mode, message surfaces, input. |
| `terminal` | Integrated terminal colors and ANSI palette. |
| `statusBar` | Bottom status bar. |
| `titleBar` | Custom app title bar and window controls. |
| `common` | Shared semantic colors used across the app. |

## Editor Tokens

| Token | CSS variable | Purpose |
| --- | --- | --- |
| `background` | `--aurora-editor-background` | Main editor background. |
| `foreground` | `--aurora-editor-foreground` | Main editor text. |
| `lineNumbers` | `--aurora-editor-line-numbers` | Inactive line numbers. |
| `lineNumbersActive` | `--aurora-editor-line-numbers-active` | Active line number. |
| `selection` | `--aurora-editor-selection` | Primary selected text background. |
| `selectionHighlight` | `--aurora-editor-selection-highlight` | Secondary selection highlights. |
| `cursor` | `--aurora-editor-cursor` | Text cursor color. |
| `cursorLine` | `--aurora-editor-cursor-line` | Active line background. |
| `whitespace` | `--aurora-editor-whitespace` | Whitespace glyphs. |
| `indentGuide` | `--aurora-editor-indent-guide` | Indentation guide color. |
| `matchingBracket` | `--aurora-editor-matching-bracket` | Matching bracket highlight. |
| `wordHighlight` | `--aurora-editor-word-highlight` | Current word highlight. |
| `findMatch` | `--aurora-editor-find-match` | Active find result. |
| `findMatchHighlight` | `--aurora-editor-find-match-highlight` | Other find results. |

## Sidebar Tokens

| Token | CSS variable | Purpose |
| --- | --- | --- |
| `background` | `--aurora-sidebar-background` | Sidebar background. |
| `foreground` | `--aurora-sidebar-foreground` | Sidebar text and icons. |
| `border` | `--aurora-sidebar-border` | Sidebar dividers. |
| `itemHover` | `--aurora-sidebar-item-hover` | Tree row hover. |
| `itemActive` | `--aurora-sidebar-item-active` | Active row or focused item. |
| `itemSelected` | `--aurora-sidebar-item-selected` | Selected row. |
| `sectionHeader` | `--aurora-sidebar-section-header` | Sidebar section labels. |

## Chat Tokens

| Token | CSS variable | Purpose |
| --- | --- | --- |
| `background` | `--aurora-chat-background` | Chat and agent-mode background. |
| `inputBackground` | `--aurora-chat-input-background` | Prompt input surface. |
| `inputBorder` | `--aurora-chat-input-border` | Prompt input border. |
| `surface` | `--aurora-chat-surface` | Message and panel surfaces. |
| `surfaceBorder` | `--aurora-chat-surface-border` | Message and panel borders. |
| `surfaceMuted` | `--aurora-chat-surface-muted` | Subtle nested surfaces. |
| `usageLow` | `--aurora-chat-usage-low` | Low context usage indicator. |
| `usageMedium` | `--aurora-chat-usage-medium` | Medium context usage indicator. |
| `usageHigh` | `--aurora-chat-usage-high` | High context usage indicator. |
| `userMessage` | `--aurora-chat-user-message` | User message background. |
| `assistantMessage` | `--aurora-chat-assistant-message` | Assistant message background. |
| `thinkingBackground` | `--aurora-chat-thinking-background` | Thinking block background. |
| `thinkingBorder` | `--aurora-chat-thinking-border` | Thinking block border. |
| `toolCallBackground` | `--aurora-chat-tool-call-background` | Tool call background. |
| `toolCallBorder` | `--aurora-chat-tool-call-border` | Tool call border. |
| `codeBlock` | `--aurora-chat-code-block` | Inline and fenced code surfaces. |

## Terminal Tokens

| Token | CSS variable | Purpose |
| --- | --- | --- |
| `background` | `--aurora-terminal-background` | Terminal background. |
| `foreground` | `--aurora-terminal-foreground` | Terminal foreground. |
| `cursor` | `--aurora-terminal-cursor` | Terminal cursor. |
| `selection` | `--aurora-terminal-selection` | Terminal selection. |
| `black` | `--aurora-terminal-black` | ANSI black. |
| `red` | `--aurora-terminal-red` | ANSI red. |
| `green` | `--aurora-terminal-green` | ANSI green. |
| `yellow` | `--aurora-terminal-yellow` | ANSI yellow. |
| `blue` | `--aurora-terminal-blue` | ANSI blue. |
| `magenta` | `--aurora-terminal-magenta` | ANSI magenta. |
| `cyan` | `--aurora-terminal-cyan` | ANSI cyan. |
| `white` | `--aurora-terminal-white` | ANSI white. |
| `brightBlack` | `--aurora-terminal-bright-black` | Bright ANSI black. |
| `brightRed` | `--aurora-terminal-bright-red` | Bright ANSI red. |
| `brightGreen` | `--aurora-terminal-bright-green` | Bright ANSI green. |
| `brightYellow` | `--aurora-terminal-bright-yellow` | Bright ANSI yellow. |
| `brightBlue` | `--aurora-terminal-bright-blue` | Bright ANSI blue. |
| `brightMagenta` | `--aurora-terminal-bright-magenta` | Bright ANSI magenta. |
| `brightCyan` | `--aurora-terminal-bright-cyan` | Bright ANSI cyan. |
| `brightWhite` | `--aurora-terminal-bright-white` | Bright ANSI white. |

## Status Bar Tokens

| Token | CSS variable | Purpose |
| --- | --- | --- |
| `background` | `--aurora-status-bar-background` | Status bar background. |
| `foreground` | `--aurora-status-bar-foreground` | Status bar text and icons. |
| `border` | `--aurora-status-bar-border` | Status bar top border. |
| `itemHover` | `--aurora-status-bar-item-hover` | Hover background for status items. |

## Title Bar Tokens

| Token | CSS variable | Purpose |
| --- | --- | --- |
| `background` | `--aurora-title-bar-background` | App title bar background. |
| `foreground` | `--aurora-title-bar-foreground` | App title bar text and icons. |
| `border` | `--aurora-title-bar-border` | Title bar border. |
| `buttonHover` | `--aurora-title-bar-button-hover` | Window button hover background. |

## Common Tokens

| Token | CSS variable | Purpose |
| --- | --- | --- |
| `primary` | `--aurora-common-primary` | Primary action and accent color. |
| `primaryHover` | `--aurora-common-primary-hover` | Primary hover state. |
| `primaryForeground` | `--aurora-common-primary-foreground` | Text on primary surfaces. |
| `secondary` | `--aurora-common-secondary` | Secondary surface color. |
| `secondaryHover` | `--aurora-common-secondary-hover` | Secondary hover state. |
| `secondaryForeground` | `--aurora-common-secondary-foreground` | Text on secondary surfaces. |
| `success` | `--aurora-common-success` | Success state. |
| `successForeground` | `--aurora-common-success-foreground` | Text on success surfaces. |
| `warning` | `--aurora-common-warning` | Warning state. |
| `warningForeground` | `--aurora-common-warning-foreground` | Text on warning surfaces. |
| `error` | `--aurora-common-error` | Error state. |
| `errorForeground` | `--aurora-common-error-foreground` | Text on error surfaces. |
| `info` | `--aurora-common-info` | Informational state. |
| `infoForeground` | `--aurora-common-info-foreground` | Text on info surfaces. |
| `border` | `--aurora-common-border` | Default border. |
| `borderHover` | `--aurora-common-border-hover` | Hover border. |
| `shadow` | `--aurora-common-shadow` | Shadow color. |
| `overlay` | `--aurora-common-overlay` | Modal and scrim overlays. |
| `scrollbar` | `--aurora-common-scrollbar` | Scrollbar thumb. |
| `scrollbarHover` | `--aurora-common-scrollbar-hover` | Scrollbar hover. |
| `muted` | `--aurora-common-muted` | Muted surface. |
| `mutedForeground` | `--aurora-common-muted-foreground` | Muted text. |
| `accent` | `--aurora-common-accent` | Secondary accent. |
| `accentForeground` | `--aurora-common-accent-foreground` | Text on accent surfaces. |
| `accentMuted` | `--aurora-common-accent-muted` | Low-emphasis accent surface. |
| `destructive` | `--aurora-common-destructive` | Destructive action color. |
| `destructiveForeground` | `--aurora-common-destructive-foreground` | Text on destructive surfaces. |
| `textPrimary` | `--aurora-common-text-primary` | Primary app text. |
| `textSecondary` | `--aurora-common-text-secondary` | Secondary app text. |
| `textDisabled` | `--aurora-common-text-disabled` | Disabled text. |
| `diffAdded` | `--aurora-common-diff-added` | Added diff surface. |
| `diffAddedForeground` | `--aurora-common-diff-added-foreground` | Added diff text. |
| `diffRemoved` | `--aurora-common-diff-removed` | Removed diff surface. |
| `diffRemovedForeground` | `--aurora-common-diff-removed-foreground` | Removed diff text. |
| `diffModified` | `--aurora-common-diff-modified` | Modified diff surface. |
| `diffModifiedForeground` | `--aurora-common-diff-modified-foreground` | Modified diff text. |
| `statusActive` | `--aurora-common-status-active` | Active status dot. |
| `statusInactive` | `--aurora-common-status-inactive` | Inactive status dot. |
| `statusError` | `--aurora-common-status-error` | Error status dot. |
| `statusWarning` | `--aurora-common-status-warning` | Warning status dot. |
| `taskPending` | `--aurora-common-task-pending` | Pending task state. |
| `taskInProgress` | `--aurora-common-task-in-progress` | In-progress task state. |
| `taskCompleted` | `--aurora-common-task-completed` | Completed task state. |
| `taskCancelled` | `--aurora-common-task-cancelled` | Cancelled task state. |
| `secureConnection` | `--aurora-common-secure-connection` | Secure connection indicator. |
| `insecureConnection` | `--aurora-common-insecure-connection` | Insecure connection indicator. |
| `localConnection` | `--aurora-common-local-connection` | Local connection indicator. |
| `actionAnalyze` | `--aurora-common-action-analyze` | Analyze quick action. |
| `actionDebug` | `--aurora-common-action-debug` | Debug quick action. |
| `actionGenerate` | `--aurora-common-action-generate` | Generate quick action. |
| `actionTest` | `--aurora-common-action-test` | Test quick action. |
| `checkpoint` | `--aurora-common-checkpoint` | Checkpoint/restore accent. |
| `checkpointForeground` | `--aurora-common-checkpoint-foreground` | Checkpoint/restore text. |

## Syntax Highlighting

`tokenColors` accepts TextMate-style rules. Aurora converts these rules into Monaco token rules.

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

Supported `fontStyle` values:

- `italic`
- `bold`
- `underline`
- `strikethrough`
- `italic bold`
- `bold italic`

## Component Rules

Use theme variables at the component boundary:

```tsx
<div style={{ background: "var(--aurora-chat-background)" }} />
```

Tailwind arbitrary values are acceptable when the value is a theme variable:

```tsx
<div className="bg-[var(--aurora-editor-background)] text-[var(--aurora-editor-foreground)]" />
```

Avoid raw product colors in components unless the color is data-owned content, such as an icon pack asset or a user-supplied preview. Add a new token when a repeated UI role needs a stable color contract.

## Authoring Checklist

- Keep foreground/background contrast readable.
- Set all seven color categories for portable theme files.
- Use alpha hex values for translucent selections and highlights.
- Keep dark sidebar hover and selected colors subtle; the runtime normalizes overly bright dark sidebar interaction tokens.
- Include `tokenColors` for syntax highlighting when the theme should control Monaco colors.
- Validate the JSON file before importing it into Aurora.
