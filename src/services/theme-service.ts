/**
 * Theme Service
 * 
 * Provides theme validation, CSS variable injection, and Monaco theme conversion.
 * Implements Requirements 8.1-8.5 for theme file validation and management.
 */

import type {
  ThemeFile,
  ThemeTokens,
  ThemeDefinition,
  ThemeValidationResult,
  ColorValidationResult,
  MonacoThemeData,
  MonacoTokenRule,
  CSSVariableMap,
  DeepPartial,
} from '../types/theme';

// ============================================================================
// Color Validation
// ============================================================================

/**
 * Regex patterns for valid color formats
 */
const COLOR_PATTERNS = {
  hex3: /^#[0-9A-Fa-f]{3}$/,
  hex4: /^#[0-9A-Fa-f]{4}$/,
  hex6: /^#[0-9A-Fa-f]{6}$/,
  hex8: /^#[0-9A-Fa-f]{8}$/,
  rgb: /^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/,
  rgba: /^rgba\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(0|1|0?\.\d+)\s*\)$/,
};

/**
 * Validate a color value (hex, rgb, rgba)
 * Requirement 8.4: Validate color values
 */
export function validateColor(value: string): ColorValidationResult {
  if (!value || typeof value !== 'string') {
    return { valid: false, error: 'Color value must be a non-empty string' };
  }

  const trimmed = value.trim();

  // Check hex formats
  if (COLOR_PATTERNS.hex6.test(trimmed)) {
    return { valid: true, normalizedValue: trimmed.toLowerCase() };
  }
  if (COLOR_PATTERNS.hex8.test(trimmed)) {
    return { valid: true, normalizedValue: trimmed.toLowerCase() };
  }
  if (COLOR_PATTERNS.hex3.test(trimmed)) {
    // Expand #RGB to #RRGGBB
    const expanded = `#${trimmed[1]}${trimmed[1]}${trimmed[2]}${trimmed[2]}${trimmed[3]}${trimmed[3]}`;
    return { valid: true, normalizedValue: expanded.toLowerCase() };
  }
  if (COLOR_PATTERNS.hex4.test(trimmed)) {
    // Expand #RGBA to #RRGGBBAA
    const expanded = `#${trimmed[1]}${trimmed[1]}${trimmed[2]}${trimmed[2]}${trimmed[3]}${trimmed[3]}${trimmed[4]}${trimmed[4]}`;
    return { valid: true, normalizedValue: expanded.toLowerCase() };
  }

  // Check rgb format
  const rgbMatch = trimmed.match(COLOR_PATTERNS.rgb);
  if (rgbMatch) {
    const [, r, g, b] = rgbMatch;
    if (Number(r) <= 255 && Number(g) <= 255 && Number(b) <= 255) {
      return { valid: true, normalizedValue: trimmed };
    }
    return { valid: false, error: 'RGB values must be between 0 and 255' };
  }

  // Check rgba format
  const rgbaMatch = trimmed.match(COLOR_PATTERNS.rgba);
  if (rgbaMatch) {
    const [, r, g, b, a] = rgbaMatch;
    if (Number(r) <= 255 && Number(g) <= 255 && Number(b) <= 255 && Number(a) <= 1) {
      return { valid: true, normalizedValue: trimmed };
    }
    return { valid: false, error: 'RGBA values must be valid (RGB: 0-255, A: 0-1)' };
  }

  return { valid: false, error: `Invalid color format: ${value}` };
}


// ============================================================================
// Theme File Validation (Requirements 8.1-8.5)
// ============================================================================

/**
 * Required metadata fields for a theme file
 */
const REQUIRED_METADATA = ['name', 'author', 'version', 'type'] as const;

/**
 * Valid theme types
 */
const VALID_THEME_TYPES = ['dark', 'light'] as const;

/**
 * Validate theme file structure and content
 * Requirements 8.1, 8.2, 8.4, 8.5
 */
export function validateThemeFile(json: unknown): ThemeValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Check if input is an object
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    return {
      valid: false,
      errors: ['Theme file must be a JSON object'],
      warnings: [],
    };
  }

  const theme = json as Record<string, unknown>;

  // Validate required metadata (Requirement 8.2)
  for (const field of REQUIRED_METADATA) {
    if (!(field in theme)) {
      errors.push(`Missing required field: ${field}`);
    } else if (typeof theme[field] !== 'string') {
      errors.push(`Field '${field}' must be a string`);
    }
  }

  // Validate theme type
  if (theme.type && !VALID_THEME_TYPES.includes(theme.type as 'dark' | 'light')) {
    errors.push(`Invalid theme type: ${theme.type}. Must be 'dark' or 'light'`);
  }

  // Validate version format (semver-like)
  if (theme.version && typeof theme.version === 'string') {
    if (!/^\d+\.\d+\.\d+/.test(theme.version)) {
      warnings.push(`Version '${theme.version}' does not follow semantic versioning (x.y.z)`);
    }
  }

  // Validate colors object (Requirement 8.3 - partial definitions allowed)
  if ('colors' in theme) {
    if (typeof theme.colors !== 'object' || theme.colors === null) {
      errors.push("'colors' must be an object");
    } else {
      const colorErrors = validateColorTokens(theme.colors as Record<string, unknown>);
      errors.push(...colorErrors);
    }
  } else {
    warnings.push("No 'colors' defined - will use base theme defaults");
  }

  // Validate tokenColors array
  if ('tokenColors' in theme) {
    if (!Array.isArray(theme.tokenColors)) {
      errors.push("'tokenColors' must be an array");
    } else {
      const tokenErrors = validateTokenColorRules(theme.tokenColors);
      errors.push(...tokenErrors);
    }
  } else {
    warnings.push("No 'tokenColors' defined - syntax highlighting will use defaults");
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Validate color tokens recursively
 */
function validateColorTokens(colors: Record<string, unknown>, path = 'colors'): string[] {
  const errors: string[] = [];

  for (const [key, value] of Object.entries(colors)) {
    const currentPath = `${path}.${key}`;

    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      // Nested category - recurse
      errors.push(...validateColorTokens(value as Record<string, unknown>, currentPath));
    } else if (typeof value === 'string') {
      // Color value - validate
      const result = validateColor(value);
      if (!result.valid) {
        errors.push(`Invalid color at ${currentPath}: ${result.error}`);
      }
    } else if (value !== undefined) {
      errors.push(`Invalid value at ${currentPath}: expected string color value`);
    }
  }

  return errors;
}

/**
 * Validate token color rules for syntax highlighting
 */
function validateTokenColorRules(rules: unknown[]): string[] {
  const errors: string[] = [];

  rules.forEach((rule, index) => {
    if (typeof rule !== 'object' || rule === null) {
      errors.push(`tokenColors[${index}]: must be an object`);
      return;
    }

    const tokenRule = rule as Record<string, unknown>;

    // Validate scope
    if (!('scope' in tokenRule)) {
      errors.push(`tokenColors[${index}]: missing required 'scope' field`);
    } else if (
      typeof tokenRule.scope !== 'string' &&
      !Array.isArray(tokenRule.scope)
    ) {
      errors.push(`tokenColors[${index}]: 'scope' must be a string or array of strings`);
    }

    // Validate settings
    if (!('settings' in tokenRule)) {
      errors.push(`tokenColors[${index}]: missing required 'settings' field`);
    } else if (typeof tokenRule.settings !== 'object' || tokenRule.settings === null) {
      errors.push(`tokenColors[${index}]: 'settings' must be an object`);
    } else {
      const settings = tokenRule.settings as Record<string, unknown>;

      // Validate color values in settings
      if (settings.foreground && typeof settings.foreground === 'string') {
        const result = validateColor(settings.foreground);
        if (!result.valid) {
          errors.push(`tokenColors[${index}].settings.foreground: ${result.error}`);
        }
      }
      if (settings.background && typeof settings.background === 'string') {
        const result = validateColor(settings.background);
        if (!result.valid) {
          errors.push(`tokenColors[${index}].settings.background: ${result.error}`);
        }
      }
    }
  });

  return errors;
}


// ============================================================================
// Base Theme Defaults
// ============================================================================

/**
 * Default dark theme tokens (base fallback)
 */
export const DEFAULT_DARK_TOKENS: ThemeTokens = {
  editor: {
    background: '#0d0d0d',
    foreground: '#e4e4e7',
    lineNumbers: '#52525b',
    lineNumbersActive: '#a1a1aa',
    selection: '#10b98133',
    selectionHighlight: '#10b98122',
    cursor: '#10b981',
    cursorLine: '#18181b',
    whitespace: '#3f3f46',
    indentGuide: '#27272a',
    matchingBracket: '#10b98155',
    wordHighlight: '#10b98133',
    findMatch: '#fbbf2455',
    findMatchHighlight: '#fbbf2433',
  },
  sidebar: {
    background: '#111111',
    foreground: '#a1a1aa',
    border: '#27272a',
    itemHover: '#ffffff0d',
    itemActive: '#10b98120',
    itemSelected: '#10b98130',
    sectionHeader: '#71717a',
  },
  chat: {
    background: '#0d0d0d',
    inputBackground: '#18181b',
    inputBorder: '#27272a',
    surface: '#111111',
    surfaceBorder: '#1f1f1f',
    surfaceMuted: '#0f0f10',
    usageLow: '#22d3ee',
    usageMedium: '#facc15',
    usageHigh: '#ef4444',
    userMessage: '#1e3a5f',
    assistantMessage: '#18181b',
    thinkingBackground: '#1a1a2e',
    thinkingBorder: '#3730a3',
    toolCallBackground: '#1a2e1a',
    toolCallBorder: '#166534',
    codeBlock: '#1e1e1e',
  },
  terminal: {
    background: '#0d0d0d',
    foreground: '#e4e4e7',
    cursor: '#10b981',
    selection: '#10b98133',
    black: '#000000',
    red: '#ef4444',
    green: '#22c55e',
    yellow: '#eab308',
    blue: '#3b82f6',
    magenta: '#a855f7',
    cyan: '#06b6d4',
    white: '#f4f4f5',
    brightBlack: '#52525b',
    brightRed: '#f87171',
    brightGreen: '#4ade80',
    brightYellow: '#facc15',
    brightBlue: '#60a5fa',
    brightMagenta: '#c084fc',
    brightCyan: '#22d3ee',
    brightWhite: '#ffffff',
  },
  statusBar: {
    background: '#111111',
    foreground: '#a1a1aa',
    border: '#27272a',
    itemHover: '#ffffff0d',
  },
  titleBar: {
    background: '#0d0d0d',
    foreground: '#a1a1aa',
    border: '#27272a',
    buttonHover: '#ffffff0d',
  },
  common: {
    primary: '#10b981',
    primaryHover: '#059669',
    primaryForeground: '#ffffff',
    secondary: '#27272a',
    secondaryHover: '#3f3f46',
    secondaryForeground: '#e4e4e7',
    success: '#22c55e',
    successForeground: '#ffffff',
    warning: '#f59e0b',
    warningForeground: '#000000',
    error: '#ef4444',
    errorForeground: '#ffffff',
    info: '#3b82f6',
    infoForeground: '#ffffff',
    border: '#27272a',
    borderHover: '#3f3f46',
    shadow: '#00000066',
    overlay: '#00000080',
    scrollbar: '#3f3f46',
    scrollbarHover: '#52525b',
  },
};


/**
 * Default light theme tokens (base fallback)
 */
export const DEFAULT_LIGHT_TOKENS: ThemeTokens = {
  editor: {
    background: '#ffffff',
    foreground: '#1f2937',
    lineNumbers: '#9ca3af',
    lineNumbersActive: '#4b5563',
    selection: '#10b98133',
    selectionHighlight: '#10b98122',
    cursor: '#059669',
    cursorLine: '#f3f4f6',
    whitespace: '#d1d5db',
    indentGuide: '#e5e7eb',
    matchingBracket: '#10b98155',
    wordHighlight: '#10b98133',
    findMatch: '#fbbf2455',
    findMatchHighlight: '#fbbf2433',
  },
  sidebar: {
    background: '#f9fafb',
    foreground: '#4b5563',
    border: '#e5e7eb',
    itemHover: '#0000000d',
    itemActive: '#10b98120',
    itemSelected: '#10b98130',
    sectionHeader: '#6b7280',
  },
  chat: {
    background: '#ffffff',
    inputBackground: '#f9fafb',
    inputBorder: '#e5e7eb',
    surface: '#f3f4f6',
    surfaceBorder: '#e5e7eb',
    surfaceMuted: '#eef2f7',
    usageLow: '#0ea5e9',
    usageMedium: '#d97706',
    usageHigh: '#dc2626',
    userMessage: '#dbeafe',
    assistantMessage: '#f3f4f6',
    thinkingBackground: '#eef2ff',
    thinkingBorder: '#6366f1',
    toolCallBackground: '#dcfce7',
    toolCallBorder: '#22c55e',
    codeBlock: '#f3f4f6',
  },
  terminal: {
    background: '#ffffff',
    foreground: '#1f2937',
    cursor: '#059669',
    selection: '#10b98133',
    black: '#1f2937',
    red: '#dc2626',
    green: '#16a34a',
    yellow: '#ca8a04',
    blue: '#2563eb',
    magenta: '#9333ea',
    cyan: '#0891b2',
    white: '#f9fafb',
    brightBlack: '#6b7280',
    brightRed: '#ef4444',
    brightGreen: '#22c55e',
    brightYellow: '#eab308',
    brightBlue: '#3b82f6',
    brightMagenta: '#a855f7',
    brightCyan: '#06b6d4',
    brightWhite: '#ffffff',
  },
  statusBar: {
    background: '#f9fafb',
    foreground: '#4b5563',
    border: '#e5e7eb',
    itemHover: '#0000000d',
  },
  titleBar: {
    background: '#ffffff',
    foreground: '#4b5563',
    border: '#e5e7eb',
    buttonHover: '#0000000d',
  },
  common: {
    primary: '#059669',
    primaryHover: '#047857',
    primaryForeground: '#ffffff',
    secondary: '#e5e7eb',
    secondaryHover: '#d1d5db',
    secondaryForeground: '#1f2937',
    success: '#16a34a',
    successForeground: '#ffffff',
    warning: '#d97706',
    warningForeground: '#000000',
    error: '#dc2626',
    errorForeground: '#ffffff',
    info: '#2563eb',
    infoForeground: '#ffffff',
    border: '#e5e7eb',
    borderHover: '#d1d5db',
    shadow: '#00000022',
    overlay: '#00000040',
    scrollbar: '#d1d5db',
    scrollbarHover: '#9ca3af',
  },
};


// ============================================================================
// Theme Merging (Requirement 8.3)
// ============================================================================

/**
 * Deep merge partial theme tokens with base theme
 * Requirement 8.3: Support partial definitions with fallback to base theme
 */
export function mergeWithBaseTheme(
  partial: DeepPartial<ThemeTokens>,
  baseType: 'dark' | 'light'
): ThemeTokens {
  const base = baseType === 'dark' ? DEFAULT_DARK_TOKENS : DEFAULT_LIGHT_TOKENS;
  return deepMerge(base, partial) as ThemeTokens;
}

/**
 * Deep merge utility for nested objects
 */
function deepMerge<T>(
  target: T,
  source: DeepPartial<T>
): T {
  if (typeof target !== 'object' || target === null) {
    return target;
  }

  const result = { ...target } as T;

  for (const key in source) {
    const sourceValue = source[key as keyof typeof source];
    const targetValue = target[key as keyof T];

    if (
      sourceValue !== undefined &&
      typeof sourceValue === 'object' &&
      sourceValue !== null &&
      !Array.isArray(sourceValue) &&
      typeof targetValue === 'object' &&
      targetValue !== null
    ) {
      // Recursively merge nested objects
      (result as Record<string, unknown>)[key] = deepMerge(
        targetValue as Record<string, unknown>,
        sourceValue as DeepPartial<Record<string, unknown>>
      );
    } else if (sourceValue !== undefined) {
      // Override with source value
      (result as Record<string, unknown>)[key] = sourceValue;
    }
  }

  return result;
}

// ============================================================================
// Theme Conversion
// ============================================================================

/**
 * Convert a ThemeFile to a ThemeDefinition
 * Validates and merges with base theme
 */
export function themeFileToDefinition(
  themeFile: ThemeFile,
  id: string,
  isBuiltIn: boolean
): ThemeDefinition {
  const mergedColors = mergeWithBaseTheme(themeFile.colors, themeFile.type);

  return {
    id,
    name: themeFile.name,
    author: themeFile.author,
    version: themeFile.version,
    type: themeFile.type,
    isBuiltIn,
    colors: mergedColors,
    tokenColors: themeFile.tokenColors || [],
  };
}

/**
 * Convert a ThemeDefinition back to a ThemeFile
 * Used for serialization/export
 */
export function themeDefinitionToFile(theme: ThemeDefinition): ThemeFile {
  return {
    name: theme.name,
    author: theme.author,
    version: theme.version,
    type: theme.type,
    colors: theme.colors,
    tokenColors: theme.tokenColors,
  };
}


// ============================================================================
// CSS Variable Injection (Requirement 12.1, 12.4)
// ============================================================================

/**
 * Generate CSS variable name following pattern: --aurora-{category}-{token}
 * Requirement 12.4
 */
export function getCSSVariableName(category: string, token: string): string {
  // Convert camelCase to kebab-case
  const kebabToken = token.replace(/([A-Z])/g, '-$1').toLowerCase();
  return `--aurora-${category}-${kebabToken}`;
}

/**
 * Generate all CSS variables from theme tokens
 */
export function generateCSSVariables(tokens: ThemeTokens): CSSVariableMap {
  const variables: CSSVariableMap = {} as CSSVariableMap;

  // Process each category
  for (const [category, categoryTokens] of Object.entries(tokens)) {
    for (const [token, value] of Object.entries(categoryTokens as Record<string, string>)) {
      const varName = getCSSVariableName(category, token) as `--aurora-${string}-${string}`;
      variables[varName] = value;
    }
  }

  return variables;
}

/**
 * Inject CSS variables into document root
 * Requirement 12.1
 */
export function injectCSSVariables(tokens: ThemeTokens): void {
  const variables = generateCSSVariables(tokens);
  const root = document.documentElement;

  for (const [name, value] of Object.entries(variables)) {
    root.style.setProperty(name, value);
  }
}

/**
 * Remove all Aurora CSS variables from document root
 */
export function removeCSSVariables(): void {
  const root = document.documentElement;
  const style = root.style;

  // Remove all --aurora-* variables
  for (let i = style.length - 1; i >= 0; i--) {
    const name = style[i];
    if (name.startsWith('--aurora-')) {
      root.style.removeProperty(name);
    }
  }
}


// ============================================================================
// Monaco Theme Conversion (Requirement 11.2, 11.3, 11.5)
// ============================================================================

/**
 * Convert Aurora theme to Monaco editor theme format
 * Requirements 11.2, 11.3, 11.5
 */
export function convertToMonacoTheme(theme: ThemeDefinition): MonacoThemeData {
  const base = theme.type === 'dark' ? 'vs-dark' : 'vs';

  // Convert token color rules to Monaco format
  const rules: MonacoTokenRule[] = theme.tokenColors.flatMap((rule) => {
    const scopes = Array.isArray(rule.scope) ? rule.scope : [rule.scope];

    return scopes.map((scope) => ({
      token: scope,
      foreground: rule.settings.foreground?.replace('#', ''),
      background: rule.settings.background?.replace('#', ''),
      fontStyle: rule.settings.fontStyle,
    }));
  });

  // Map Aurora editor tokens to Monaco color keys
  const colors: Record<string, string> = {
    'editor.background': theme.colors.editor.background,
    'editor.foreground': theme.colors.editor.foreground,
    'editor.lineHighlightBackground': theme.colors.editor.cursorLine,
    'editor.selectionBackground': theme.colors.editor.selection,
    'editor.selectionHighlightBackground': theme.colors.editor.selectionHighlight,
    'editorCursor.foreground': theme.colors.editor.cursor,
    'editorLineNumber.foreground': theme.colors.editor.lineNumbers,
    'editorLineNumber.activeForeground': theme.colors.editor.lineNumbersActive,
    'editorWhitespace.foreground': theme.colors.editor.whitespace,
    'editorIndentGuide.background': theme.colors.editor.indentGuide,
    'editorBracketMatch.background': theme.colors.editor.matchingBracket,
    'editor.wordHighlightBackground': theme.colors.editor.wordHighlight,
    'editor.findMatchBackground': theme.colors.editor.findMatch,
    'editor.findMatchHighlightBackground': theme.colors.editor.findMatchHighlight,
    // Scrollbar
    'scrollbarSlider.background': theme.colors.common.scrollbar,
    'scrollbarSlider.hoverBackground': theme.colors.common.scrollbarHover,
    // Minimap
    'minimap.background': theme.colors.editor.background,
    'minimapSlider.background': theme.colors.common.scrollbar,
    'minimapSlider.hoverBackground': theme.colors.common.scrollbarHover,
    // Editor Widget (autocomplete, command palette, context menu, etc.)
    'editorWidget.background': theme.colors.sidebar.background,
    'editorWidget.foreground': theme.colors.editor.foreground,
    'editorWidget.border': theme.colors.common.border,
    'editorSuggestWidget.background': theme.colors.sidebar.background,
    'editorSuggestWidget.foreground': theme.colors.editor.foreground,
    'editorSuggestWidget.border': theme.colors.common.border,
    'editorSuggestWidget.selectedBackground': theme.colors.common.primary,
    'editorSuggestWidget.selectedForeground': theme.colors.common.primaryForeground,
    'editorSuggestWidget.highlightForeground': theme.colors.common.primary,
    'editorSuggestWidget.focusHighlightForeground': theme.colors.common.primaryForeground,
    // Quick Input (Command Palette)
    'quickInput.background': theme.colors.sidebar.background,
    'quickInput.foreground': theme.colors.editor.foreground,
    'quickInputTitle.background': theme.colors.titleBar.background,
    'quickInputList.focusBackground': theme.colors.common.primary,
    'quickInputList.focusForeground': theme.colors.common.primaryForeground,
    'pickerGroup.foreground': theme.colors.common.primary,
    'pickerGroup.border': theme.colors.common.border,
    // Input fields
    'input.background': theme.colors.chat.inputBackground,
    'input.foreground': theme.colors.editor.foreground,
    'input.border': theme.colors.chat.inputBorder,
    'input.placeholderForeground': theme.colors.sidebar.foreground + '80',
    'inputOption.activeBackground': theme.colors.common.primary + '40',
    'inputOption.activeBorder': theme.colors.common.primary,
    'inputOption.activeForeground': theme.colors.common.primaryForeground,
    // List/Tree (dropdown menus, context menus)
    'list.activeSelectionBackground': theme.colors.common.primary,
    'list.activeSelectionForeground': theme.colors.common.primaryForeground,
    'list.hoverBackground': theme.colors.sidebar.itemHover,
    'list.hoverForeground': theme.colors.editor.foreground,
    'list.focusBackground': theme.colors.sidebar.itemActive,
    'list.focusForeground': theme.colors.editor.foreground,
    'list.highlightForeground': theme.colors.common.primary,
    // Menu (context menu)
    'menu.background': theme.colors.sidebar.background,
    'menu.foreground': theme.colors.editor.foreground,
    'menu.selectionBackground': theme.colors.common.primary,
    'menu.selectionForeground': theme.colors.common.primaryForeground,
    'menu.separatorBackground': theme.colors.common.border,
    'menu.border': theme.colors.common.border,
    // Keybinding label
    'keybindingLabel.background': theme.colors.sidebar.itemHover,
    'keybindingLabel.foreground': theme.colors.editor.foreground,
    'keybindingLabel.border': theme.colors.common.border,
    'keybindingLabel.bottomBorder': theme.colors.common.border,
  };

  return {
    base,
    inherit: true,
    rules,
    colors,
  };
}

/**
 * Generate a unique Monaco theme ID from theme definition
 */
export function getMonacoThemeId(theme: ThemeDefinition): string {
  return `aurora-${theme.id}`;
}

// ============================================================================
// Theme Service Class
// ============================================================================

/**
 * Theme service singleton for managing theme operations
 */
class ThemeService {
  private currentTheme: ThemeDefinition | null = null;

  /**
   * Apply a theme to the application
   */
  applyTheme(theme: ThemeDefinition): void {
    // Inject CSS variables
    injectCSSVariables(theme.colors);

    // Store current theme
    this.currentTheme = theme;

    // Set data attribute for CSS selectors
    document.documentElement.setAttribute('data-theme', theme.type);
    document.documentElement.setAttribute('data-theme-id', theme.id);

    // Toggle dark class for Tailwind compatibility
    if (theme.type === 'dark') {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  }

  /**
   * Get the currently applied theme
   */
  getCurrentTheme(): ThemeDefinition | null {
    return this.currentTheme;
  }

  /**
   * Validate a theme file
   */
  validateThemeFile(json: unknown): ThemeValidationResult {
    return validateThemeFile(json);
  }

  /**
   * Convert theme file to definition
   */
  createThemeDefinition(
    themeFile: ThemeFile,
    id: string,
    isBuiltIn: boolean
  ): ThemeDefinition {
    return themeFileToDefinition(themeFile, id, isBuiltIn);
  }

  /**
   * Get Monaco theme data for a theme
   */
  getMonacoTheme(theme: ThemeDefinition): MonacoThemeData {
    return convertToMonacoTheme(theme);
  }

  /**
   * Get base theme tokens
   */
  getBaseTokens(type: 'dark' | 'light'): ThemeTokens {
    return type === 'dark' ? DEFAULT_DARK_TOKENS : DEFAULT_LIGHT_TOKENS;
  }
}

// Export singleton instance
export const themeService = new ThemeService();
