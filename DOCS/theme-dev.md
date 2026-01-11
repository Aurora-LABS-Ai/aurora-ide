# Theme Development Guide

This guide explains how to create, test, and share themes for the Aurora Editor.

## 1. Theme File Structure

Themes are JSON files that define colors for various UI components. A valid theme file must follow this structure:

```json
{
  "name": "My Custom Theme",
  "type": "dark",
  "author": "Your Name",
  "version": "1.0.0",
  "description": "Optional description of your theme.",
  "colors": {
    "editor": { ... },
    "sidebar": { ... },
    "chat": { ... },
    "terminal": { ... },
    "statusBar": { ... },
    "titleBar": { ... },
    "common": { ... }
  },
  "tokenColors": [
    // syntax highlighting rules
  ]
}
```

### Required Fields
- **name**: Display name of the theme (must be unique per author).
- **type**: Base type (`dark` or `light`). Determines fallback colors for undefined tokens.
- **author**: Creator's name.
- **version**: Semantic version string (e.g., "1.0.0").
- **colors**: Object containing color definitions grouped by category.
- **tokenColors**: Array of syntax highlighting rules.

### Optional Fields
- **description**: Brief description of your theme.

> **Note**: All color categories are optional. Missing tokens will automatically fall back to the base theme (dark or light) defaults.

---

## 2. Color Categories

Aurora supports **7 color categories** with **107 tokens**. All colors must be valid Hex (`#RRGGBB`, `#RGB`, `#RRGGBBAA`), `rgb()`, or `rgba()` strings.

### 2.1 Editor (14 tokens)
Controls the main code editing area.

| Token | Description |
|-------|-------------|
| `background` | Main editor background |
| `foreground` | Default text color |
| `lineNumbers` | Line number color |
| `lineNumbersActive` | Active line number color |
| `selection` | Selection background |
| `selectionHighlight` | Selection highlight (other occurrences) |
| `cursor` | Cursor color |
| `cursorLine` | Current line background |
| `whitespace` | Whitespace characters color |
| `indentGuide` | Indentation guide lines |
| `matchingBracket` | Matching bracket highlight |
| `wordHighlight` | Word highlight on selection |
| `findMatch` | Current find match background |
| `findMatchHighlight` | Other find matches background |

### 2.2 Sidebar (7 tokens)
Controls the file explorer and side panels.

| Token | Description |
|-------|-------------|
| `background` | Panel background |
| `foreground` | Text color |
| `border` | Border separating sidebar from editor |
| `itemHover` | Background on hover |
| `itemActive` | Background when active/pressed |
| `itemSelected` | Background when selected |
| `sectionHeader` | Section header text color |

### 2.3 Chat (16 tokens)
Controls the AI chat panel.

| Token | Description |
|-------|-------------|
| `background` | Chat panel background |
| `inputBackground` | Input field background |
| `inputBorder` | Input field border |
| `surface` | Surface/card background |
| `surfaceBorder` | Surface border color |
| `surfaceMuted` | Muted surface background |
| `usageLow` | Context usage indicator (low) |
| `usageMedium` | Context usage indicator (medium) |
| `usageHigh` | Context usage indicator (high/critical) |
| `userMessage` | User message background |
| `assistantMessage` | Assistant message background |
| `thinkingBackground` | Thinking block background |
| `thinkingBorder` | Thinking block border |
| `toolCallBackground` | Tool call block background |
| `toolCallBorder` | Tool call block border |
| `codeBlock` | Code block background |

### 2.4 Terminal (20 tokens)
Controls the integrated terminal with full ANSI color support.

| Token | Description |
|-------|-------------|
| `background` | Terminal background |
| `foreground` | Terminal text color |
| `cursor` | Terminal cursor color |
| `selection` | Selection background |
| `black` | ANSI Black |
| `red` | ANSI Red |
| `green` | ANSI Green |
| `yellow` | ANSI Yellow |
| `blue` | ANSI Blue |
| `magenta` | ANSI Magenta |
| `cyan` | ANSI Cyan |
| `white` | ANSI White |
| `brightBlack` | ANSI Bright Black |
| `brightRed` | ANSI Bright Red |
| `brightGreen` | ANSI Bright Green |
| `brightYellow` | ANSI Bright Yellow |
| `brightBlue` | ANSI Bright Blue |
| `brightMagenta` | ANSI Bright Magenta |
| `brightCyan` | ANSI Bright Cyan |
| `brightWhite` | ANSI Bright White |

### 2.5 Status Bar (4 tokens)
Controls the bottom status bar.

| Token | Description |
|-------|-------------|
| `background` | Status bar background |
| `foreground` | Status bar text color |
| `border` | Top border color |
| `itemHover` | Item hover background |

### 2.6 Title Bar (4 tokens)
Controls the window title bar.

| Token | Description |
|-------|-------------|
| `background` | Title bar background |
| `foreground` | Title bar text color |
| `border` | Bottom border color |
| `buttonHover` | Window button hover background |

### 2.7 Common (42 tokens)
Shared UI elements used throughout the application. This is the most extensive category with semantic tokens for all UI states.

#### Core UI Colors (20 tokens)

| Token | Description |
|-------|-------------|
| `primary` | Primary accent color (buttons, focus rings) |
| `primaryHover` | Primary color on hover |
| `primaryForeground` | Text on primary background |
| `secondary` | Secondary/muted background |
| `secondaryHover` | Secondary color on hover |
| `secondaryForeground` | Text on secondary background |
| `success` | Success state color |
| `successForeground` | Text on success background |
| `warning` | Warning state color |
| `warningForeground` | Text on warning background |
| `error` | Error state color |
| `errorForeground` | Text on error background |
| `info` | Info state color |
| `infoForeground` | Text on info background |
| `border` | Default border color |
| `borderHover` | Border color on hover |
| `shadow` | Shadow color for popups |
| `overlay` | Modal overlay background |
| `scrollbar` | Scrollbar thumb color |
| `scrollbarHover` | Scrollbar thumb on hover |

#### Muted/Disabled States (2 tokens)

| Token | Description |
|-------|-------------|
| `muted` | Muted background for disabled/inactive elements |
| `mutedForeground` | Text color for muted/disabled states |

#### Accent Colors (3 tokens)

| Token | Description |
|-------|-------------|
| `accent` | Accent color for highlights, file mentions |
| `accentForeground` | Text on accent background |
| `accentMuted` | Subtle accent background (with transparency) |

#### Destructive Actions (2 tokens)

| Token | Description |
|-------|-------------|
| `destructive` | Color for delete/remove actions |
| `destructiveForeground` | Text on destructive background |

#### Git/File Diff Colors (6 tokens)

| Token | Description |
|-------|-------------|
| `diffAdded` | Background for added lines/files |
| `diffAddedForeground` | Text color for added content |
| `diffRemoved` | Background for removed lines/files |
| `diffRemovedForeground` | Text color for removed content |
| `diffModified` | Background for modified lines/files |
| `diffModifiedForeground` | Text color for modified content |

#### Status Indicators (4 tokens)

| Token | Description |
|-------|-------------|
| `statusActive` | Active/online status dot |
| `statusInactive` | Inactive/offline status dot |
| `statusError` | Error status indicator |
| `statusWarning` | Warning status indicator |

#### Task/Todo Status (4 tokens)

| Token | Description |
|-------|-------------|
| `taskPending` | Pending task indicator |
| `taskInProgress` | In-progress task indicator |
| `taskCompleted` | Completed task indicator |
| `taskCancelled` | Cancelled task indicator |

#### Security/Connection Indicators (3 tokens)

| Token | Description |
|-------|-------------|
| `secureConnection` | HTTPS/secure connection indicator |
| `insecureConnection` | HTTP/insecure connection warning |
| `localConnection` | Localhost/local development indicator |

#### Quick Action Colors (4 tokens)

| Token | Description |
|-------|-------------|
| `actionAnalyze` | Analyze action button color |
| `actionDebug` | Debug action button color |
| `actionGenerate` | Generate action button color |
| `actionTest` | Test action button color |

#### Checkpoint/Restore (2 tokens)

| Token | Description |
|-------|-------------|
| `checkpoint` | Checkpoint indicator color |
| `checkpointForeground` | Checkpoint text/icon color |

---

## 3. Syntax Highlighting (`tokenColors`)

Aurora uses TextMate-style scopes for syntax highlighting, compatible with VS Code themes.

```json
"tokenColors": [
  {
    "name": "Comments",
    "scope": ["comment", "punctuation.definition.comment"],
    "settings": {
      "foreground": "#6A9955",
      "fontStyle": "italic"
    }
  },
  {
    "name": "Keywords",
    "scope": ["keyword", "storage.type", "storage.modifier"],
    "settings": {
      "foreground": "#C586C0",
      "fontStyle": "bold"
    }
  }
]
```

### Common Scopes

| Scope | Description |
|-------|-------------|
| `comment` | Comments |
| `string`, `string.quoted` | String literals |
| `keyword` | Language keywords |
| `storage.type`, `storage.modifier` | Type declarations |
| `variable`, `variable.other` | Variables |
| `entity.name.function` | Function names |
| `entity.name.class` | Class names |
| `entity.name.type` | Type names |
| `entity.name.tag` | HTML/XML tags |
| `constant`, `constant.numeric` | Constants and numbers |
| `keyword.operator` | Operators |
| `support.function` | Built-in functions |
| `support.type` | Built-in types |

### Font Styles
Available `fontStyle` values:
- `italic`
- `bold`
- `underline`
- `strikethrough`
- `italic bold` or `bold italic`

---

## 4. Partial Themes & Fallbacks

You don't need to define every token. Aurora automatically fills missing values from the base theme:

```json
{
  "name": "Minimal Theme",
  "type": "dark",
  "author": "Your Name",
  "version": "1.0.0",
  "colors": {
    "common": {
      "primary": "#ff6b6b"
    }
  },
  "tokenColors": []
}
```

This theme only changes the primary color - all other tokens use the default dark theme values.

---

## 5. Theme Validation

The editor validates themes on import and rejects them if:
- Required metadata is missing (`name`, `author`, `version`, `type`)
- Invalid color formats are used (must be hex, rgb, or rgba)
- JSON syntax is incorrect
- Version doesn't follow semantic versioning (warning only)

---

## 6. Duplicate Prevention

Aurora prevents duplicate themes using these rules:
- **Same name + same author** = Update existing theme
- **Same name + different author** = Allowed (different themes)
- Built-in themes (`Aurora Dark`, `Aurora Light`) cannot be overwritten

When you import a theme with the same name and author as an existing one, it updates the existing theme rather than creating a duplicate.

---

## 7. Testing Your Theme

1. Open Aurora Editor
2. Go to **Settings > Appearance**
3. Click **Import Theme**
4. Select your JSON file
5. If valid, it will be added to the list and automatically applied

---

## 8. Complete Example Theme

```json
{
  "name": "Oceanic Deep",
  "type": "dark",
  "author": "Aurora Community",
  "version": "1.0.0",
  "description": "A deep ocean-inspired dark theme",
  "colors": {
    "editor": {
      "background": "#0a1929",
      "foreground": "#b2bac2",
      "lineNumbers": "#3e5060",
      "lineNumbersActive": "#8796a5",
      "selection": "#1e4976",
      "selectionHighlight": "#1e497644",
      "cursor": "#5090d3",
      "cursorLine": "#0d2137",
      "whitespace": "#2d4356",
      "indentGuide": "#1e3448",
      "matchingBracket": "#5090d366",
      "wordHighlight": "#5090d333",
      "findMatch": "#c4820066",
      "findMatchHighlight": "#c4820033"
    },
    "sidebar": {
      "background": "#071318",
      "foreground": "#8796a5",
      "border": "#1e3448",
      "itemHover": "#ffffff0a",
      "itemActive": "#5090d322",
      "itemSelected": "#5090d333",
      "sectionHeader": "#5a7184"
    },
    "chat": {
      "background": "#0a1929",
      "inputBackground": "#0d2137",
      "inputBorder": "#1e3448",
      "surface": "#0d2137",
      "surfaceBorder": "#1e3448",
      "surfaceMuted": "#081520",
      "usageLow": "#4fc3f7",
      "usageMedium": "#ffb74d",
      "usageHigh": "#ef5350",
      "userMessage": "#1e3a5f",
      "assistantMessage": "#0d2137",
      "thinkingBackground": "#1a237e22",
      "thinkingBorder": "#3f51b5",
      "toolCallBackground": "#1b5e2022",
      "toolCallBorder": "#4caf50",
      "codeBlock": "#071318"
    },
    "terminal": {
      "background": "#0a1929",
      "foreground": "#b2bac2",
      "cursor": "#5090d3",
      "selection": "#1e4976",
      "black": "#071318",
      "red": "#ef5350",
      "green": "#66bb6a",
      "yellow": "#ffca28",
      "blue": "#42a5f5",
      "magenta": "#ab47bc",
      "cyan": "#26c6da",
      "white": "#b2bac2",
      "brightBlack": "#546e7a",
      "brightRed": "#e57373",
      "brightGreen": "#81c784",
      "brightYellow": "#ffd54f",
      "brightBlue": "#64b5f6",
      "brightMagenta": "#ba68c8",
      "brightCyan": "#4dd0e1",
      "brightWhite": "#eceff1"
    },
    "statusBar": {
      "background": "#071318",
      "foreground": "#8796a5",
      "border": "#1e3448",
      "itemHover": "#ffffff0a"
    },
    "titleBar": {
      "background": "#071318",
      "foreground": "#8796a5",
      "border": "#1e3448",
      "buttonHover": "#ffffff0a"
    },
    "common": {
      "primary": "#5090d3",
      "primaryHover": "#3a7fc4",
      "primaryForeground": "#ffffff",
      "secondary": "#1e3448",
      "secondaryHover": "#2d4356",
      "secondaryForeground": "#b2bac2",
      "success": "#66bb6a",
      "successForeground": "#ffffff",
      "warning": "#ffca28",
      "warningForeground": "#000000",
      "error": "#ef5350",
      "errorForeground": "#ffffff",
      "info": "#29b6f6",
      "infoForeground": "#ffffff",
      "border": "#1e3448",
      "borderHover": "#2d4356",
      "shadow": "#00000066",
      "overlay": "#00000088",
      "scrollbar": "#2d4356",
      "scrollbarHover": "#3e5060",
      "muted": "#1e3448",
      "mutedForeground": "#5a7184",
      "accent": "#5090d3",
      "accentForeground": "#ffffff",
      "accentMuted": "#5090d320",
      "destructive": "#ef5350",
      "destructiveForeground": "#ffffff",
      "diffAdded": "#66bb6a",
      "diffAddedForeground": "#81c784",
      "diffRemoved": "#ef5350",
      "diffRemovedForeground": "#e57373",
      "diffModified": "#ffca28",
      "diffModifiedForeground": "#ffd54f",
      "statusActive": "#66bb6a",
      "statusInactive": "#546e7a",
      "statusError": "#ef5350",
      "statusWarning": "#ffca28",
      "taskPending": "#546e7a",
      "taskInProgress": "#42a5f5",
      "taskCompleted": "#66bb6a",
      "taskCancelled": "#ef5350",
      "secureConnection": "#66bb6a",
      "insecureConnection": "#ffca28",
      "localConnection": "#42a5f5",
      "actionAnalyze": "#42a5f5",
      "actionDebug": "#ef5350",
      "actionGenerate": "#ab47bc",
      "actionTest": "#66bb6a",
      "checkpoint": "#ffca28",
      "checkpointForeground": "#ffd54f"
    }
  },
  "tokenColors": [
    {
      "name": "Comments",
      "scope": ["comment", "punctuation.definition.comment"],
      "settings": { "foreground": "#546e7a", "fontStyle": "italic" }
    },
    {
      "name": "Keywords",
      "scope": ["keyword", "storage.type", "storage.modifier"],
      "settings": { "foreground": "#c792ea" }
    },
    {
      "name": "Strings",
      "scope": ["string", "string.quoted"],
      "settings": { "foreground": "#c3e88d" }
    },
    {
      "name": "Functions",
      "scope": ["entity.name.function", "support.function"],
      "settings": { "foreground": "#82aaff" }
    },
    {
      "name": "Types",
      "scope": ["entity.name.type", "support.type"],
      "settings": { "foreground": "#ffcb6b" }
    },
    {
      "name": "Variables",
      "scope": ["variable", "variable.other"],
      "settings": { "foreground": "#b2bac2" }
    },
    {
      "name": "Constants",
      "scope": ["constant", "constant.numeric"],
      "settings": { "foreground": "#f78c6c" }
    },
    {
      "name": "Operators",
      "scope": ["keyword.operator"],
      "settings": { "foreground": "#89ddff" }
    },
    {
      "name": "Tags",
      "scope": ["entity.name.tag"],
      "settings": { "foreground": "#f07178" }
    }
  ]
}
```

---

## 9. Tips for Theme Development

1. **Start with a base**: Copy an existing theme and modify it
2. **Use consistent colors**: Pick a palette and stick to it
3. **Test contrast**: Ensure text is readable on all backgrounds
4. **Test syntax highlighting**: Open files in different languages
5. **Use alpha channels**: `#RRGGBBAA` format for subtle overlays
6. **Version your changes**: Increment version when updating

---

## 10. CSS Variable Mapping

Themes are converted to CSS variables following this pattern:
```
--aurora-{category}-{tokenName}
```

Examples:
- `--aurora-editor-background`
- `--aurora-common-primary`
- `--aurora-chat-userMessage`
