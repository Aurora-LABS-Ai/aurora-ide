/**
 * Theme Service
 * 
 * Provides theme validation, CSS variable injection, and Monaco theme conversion.
 * Implements Requirements 8.1-8.5 for theme file validation and management.
 */
import type { CSSVariableMap, ColorValidationResult, DeepPartial, MonacoThemeData, MonacoTokenRule, ThemeDefinition, ThemeFile, ThemeTokens, ThemeValidationResult } from "../types/theme";

// ============================================================================
// Theme Service Class
// ============================================================================

interface RgbaColor {
  a: number;
  b: number;
  g: number;
  r: number;
}

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

const parseHexColor = (value: string): RgbaColor | null => {
  const hex = value.trim().replace(/^#/, "");

  if (![3, 4, 6, 8].includes(hex.length)) {
    return null;
  }

  const normalized =
    hex.length === 3 || hex.length === 4
      ? hex
          .split("")
          .map((ch) => ch + ch)
          .join("")
      : hex;

  const hasAlpha = normalized.length === 8;
  const r = Number.parseInt(normalized.slice(0, 2), 16);
  const g = Number.parseInt(normalized.slice(2, 4), 16);
  const b = Number.parseInt(normalized.slice(4, 6), 16);
  const a = hasAlpha ? Number.parseInt(normalized.slice(6, 8), 16) / 255 : 1;

  if ([r, g, b].some(Number.isNaN) || Number.isNaN(a)) {
    return null;
  }

  return { r, g, b, a: clamp01(a) };
};

const parseRgbColor = (value: string): RgbaColor | null => {
  const rgbMatch = value.trim().match(
    /^rgba?\(\s*(\d{1,3})\s*[, ]\s*(\d{1,3})\s*[, ]\s*(\d{1,3})(?:\s*[,/]\s*([0-9]*\.?[0-9]+))?\s*\)$/i
  );

  if (!rgbMatch) {
    return null;
  }

  const r = Number(rgbMatch[1]);
  const g = Number(rgbMatch[2]);
  const b = Number(rgbMatch[3]);
  const a = rgbMatch[4] !== undefined ? Number(rgbMatch[4]) : 1;

  if (
    [r, g, b].some((channel) => Number.isNaN(channel) || channel < 0 || channel > 255) ||
    Number.isNaN(a) ||
    a < 0 ||
    a > 1
  ) {
    return null;
  }

  return {
    r,
    g,
    b,
    a: clamp01(a),
  };
};

const parseColor = (value: string): RgbaColor | null => {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed.startsWith("#")) {
    return parseHexColor(trimmed);
  }
  if (trimmed.toLowerCase().startsWith("rgb")) {
    return parseRgbColor(trimmed);
  }
  return null;
};

const srgbToLinear = (value: number): number => {
  const normalized = value / 255;
  if (normalized <= 0.04045) {
    return normalized / 12.92;
  }
  return ((normalized + 0.055) / 1.055) ** 2.4;
};

const getLuminance = (color: RgbaColor): number =>
  0.2126 * srgbToLinear(color.r) +
  0.7152 * srgbToLinear(color.g) +
  0.0722 * srgbToLinear(color.b);

const mixColors = (base: RgbaColor, overlay: RgbaColor, overlayRatio: number): RgbaColor => {
  const ratio = clamp01(overlayRatio);
  const inverse = 1 - ratio;
  return {
    r: Math.round(base.r * inverse + overlay.r * ratio),
    g: Math.round(base.g * inverse + overlay.g * ratio),
    b: Math.round(base.b * inverse + overlay.b * ratio),
    a: clamp01(base.a * inverse + overlay.a * ratio),
  };
};

const toCssRgba = (color: RgbaColor): string => {
  if (color.a >= 0.999) {
    return `rgb(${color.r} ${color.g} ${color.b})`;
  }
  return `rgba(${color.r}, ${color.g}, ${color.b}, ${Number(color.a.toFixed(3))})`;
};

const normalizeDarkSidebarToken = (
  root: HTMLElement,
  tokenName: "--aurora-sidebar-item-hover" | "--aurora-sidebar-item-active" | "--aurora-sidebar-item-selected",
  baseBackground: RgbaColor,
  originalValue: string,
  overlayRatio: number
): void => {
  const parsedOriginal = parseColor(originalValue);
  if (!parsedOriginal) {
    return;
  }

  // Only correct very bright interaction colors in dark themes.
  if (getLuminance(parsedOriginal) < 0.35) {
    return;
  }

  const normalized = mixColors(baseBackground, parsedOriginal, overlayRatio);
  root.style.setProperty(tokenName, toCssRgba(normalized));
};

const normalizeDarkSidebarInteractionTokens = (theme: ThemeDefinition): void => {
  if (theme.type !== "dark") {
    return;
  }

  const root = document.documentElement;
  const baseBackground = parseColor(theme.colors.sidebar.background);

  if (!baseBackground) {
    return;
  }

  normalizeDarkSidebarToken(
    root,
    "--aurora-sidebar-item-hover",
    baseBackground,
    theme.colors.sidebar.itemHover,
    0.2
  );
  normalizeDarkSidebarToken(
    root,
    "--aurora-sidebar-item-active",
    baseBackground,
    theme.colors.sidebar.itemActive,
    0.3
  );
  normalizeDarkSidebarToken(
    root,
    "--aurora-sidebar-item-selected",
    baseBackground,
    theme.colors.sidebar.itemSelected,
    0.35
  );
};

/**
 * Theme service singleton for managing theme operations
 */
class ThemeService {
  private currentTheme: ThemeDefinition | null = null;

  /**
   * Apply a theme to the application
   */
  public applyTheme(theme: ThemeDefinition): void {
    // Inject CSS variables
    injectCSSVariables(theme.colors);
    normalizeDarkSidebarInteractionTokens(theme);

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
   * Convert theme file to definition
   */
  public createThemeDefinition(
    themeFile: ThemeFile,
    id: string,
    isBuiltIn: boolean
  ): ThemeDefinition {
    return themeFileToDefinition(themeFile, id, isBuiltIn);
  }

  /**
   * Get base theme tokens
   */
  public getBaseTokens(type: 'dark' | 'light'): ThemeTokens {
    return type === 'dark' ? DEFAULT_DARK_TOKENS : DEFAULT_LIGHT_TOKENS;
  }

  /**
   * Get the currently applied theme
   */
  public getCurrentTheme(): ThemeDefinition | null {
    return this.currentTheme;
  }

  /**
   * Get Monaco theme data for a theme
   */
  public getMonacoTheme(theme: ThemeDefinition): MonacoThemeData {
    return convertToMonacoTheme(theme);
  }

  /**
   * Validate a theme file
   */
  public validateThemeFile(json: unknown): ThemeValidationResult {
    return validateThemeFile(json);
  }
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

// ============================================================================
// CSS Variable Injection (Requirement 12.1, 12.4)
// ============================================================================

/**
 * Generate CSS variable name following pattern: --aurora-{category}-{token}
 * Requirement 12.4
 */
export function getCSSVariableName(category: string, token: string): string {
  // Convert camelCase to kebab-case for both category and token
  const kebabCategory = category.replace(/([A-Z])/g, '-$1').toLowerCase();
  const kebabToken = token.replace(/([A-Z])/g, '-$1').toLowerCase();
  return `--aurora-${kebabCategory}-${kebabToken}`;
}

/**
 * Generate a unique Monaco theme ID from theme definition
 */
export function getMonacoThemeId(theme: ThemeDefinition): string {
  return `aurora-${theme.id}`;
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

  // Check rgb / rgba formats using the shared parser so validation and
  // runtime parsing accept the same surface area.
  if (trimmed.toLowerCase().startsWith('rgb')) {
    const parsed = parseRgbColor(trimmed);
    if (parsed) {
      return { valid: true, normalizedValue: trimmed };
    }
    return { valid: false, error: 'RGB/RGBA values must be valid (RGB: 0-255, A: 0-1)' };
  }

  return { valid: false, error: `Invalid color format: ${value}` };
}

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
  rgba: /^rgba\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(?:0(?:\.\d+)?|1(?:\.0+)?)\s*\)$/,
};

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

// ============================================================================
// Base Theme Defaults
// ============================================================================

/**
 * Default dark theme tokens (base fallback)
 */
export const DEFAULT_DARK_TOKENS: ThemeTokens = {
  editor: {
    background: '#1f1f1f',
    foreground: '#cccccc',
    lineNumbers: '#6e7681',
    lineNumbersActive: '#cccccc',
    selection: '#264f78',
    selectionHighlight: '#264f7866',
    cursor: '#cccccc',
    cursorLine: '#252526',
    whitespace: '#3c3c3c',
    indentGuide: '#2b2b2b',
    matchingBracket: '#616161',
    wordHighlight: '#57575755',
    findMatch: '#9e6a03',
    findMatchHighlight: '#bb800966',
  },
  sidebar: {
    background: '#181818',
    foreground: '#cccccc',
    border: '#2b2b2b',
    itemHover: '#2b2b2b',
    itemActive: '#313131',
    itemSelected: '#313131',
    sectionHeader: '#cccccc',
  },
  chat: {
    background: '#181818',
    inputBackground: '#313131',
    inputBorder: '#3c3c3c',
    surface: '#1f1f1f',
    surfaceBorder: '#2b2b2b',
    surfaceMuted: '#202020',
    usageLow: '#22d3ee',
    usageMedium: '#facc15',
    usageHigh: '#f85149',
    userMessage: '#1f1f1f',
    assistantMessage: '#181818',
    thinkingBackground: '#202020',
    thinkingBorder: '#3c3c3c',
    toolCallBackground: '#1f1f1f',
    toolCallBorder: '#2b2b2b',
    codeBlock: '#2b2b2b',
  },
  terminal: {
    background: '#181818',
    foreground: '#cccccc',
    cursor: '#cccccc',
    selection: '#264f78',
    black: '#000000',
    red: '#f85149',
    green: '#2ea043',
    yellow: '#e2c08d',
    blue: '#0078d4',
    magenta: '#85b6ff',
    cyan: '#4daafc',
    white: '#d0d0d0',
    brightBlack: '#868686',
    brightRed: '#ff7b72',
    brightGreen: '#56d364',
    brightYellow: '#f2cc60',
    brightBlue: '#4daafc',
    brightMagenta: '#a5d6ff',
    brightCyan: '#79c0ff',
    brightWhite: '#ffffff',
  },
  statusBar: {
    background: '#181818',
    foreground: '#cccccc',
    border: '#2b2b2b',
    itemHover: '#f1f1f133',
  },
  titleBar: {
    background: '#181818',
    foreground: '#cccccc',
    border: '#2b2b2b',
    buttonHover: '#2b2b2b',
  },
  common: {
    primary: '#0078d4',
    primaryHover: '#026ec1',
    primaryForeground: '#ffffff',
    secondary: '#2b2b2b',
    secondaryHover: '#313131',
    secondaryForeground: '#cccccc',
    success: '#2ea043',
    successForeground: '#ffffff',
    warning: '#9e6a03',
    warningForeground: '#ffffff',
    error: '#f85149',
    errorForeground: '#ffffff',
    info: '#0078d4',
    infoForeground: '#ffffff',
    border: '#2b2b2b',
    borderHover: '#3c3c3c',
    shadow: '#00000066',
    overlay: '#00000080',
    scrollbar: '#616161',
    scrollbarHover: '#868686',

    // === Extended Semantic Tokens (Dark) ===

    // Muted/disabled states
    muted: '#1f1f1f',
    mutedForeground: '#9d9d9d',

    // Accent colors (emerald-based for consistency with primary)
    accent: '#0078d4',
    accentForeground: '#ffffff',
    accentMuted: '#2489db82',

    // Destructive actions
    destructive: '#f85149',
    destructiveForeground: '#ffffff',
    
    // General text colors
    textPrimary: '#cccccc',
    textSecondary: '#9d9d9d',
    textDisabled: '#868686',

    // Git/File diff colors
    diffAdded: '#2ea043',
    diffAddedForeground: '#56d364',
    diffRemoved: '#f85149',
    diffRemovedForeground: '#ff7b72',
    diffModified: '#0078d4',
    diffModifiedForeground: '#4daafc',

    // Status indicator dots
    statusActive: '#2ea043',
    statusInactive: '#868686',
    statusError: '#f85149',
    statusWarning: '#9e6a03',

    // Task/Todo status colors
    taskPending: '#868686',
    taskInProgress: '#0078d4',
    taskCompleted: '#2ea043',
    taskCancelled: '#f85149',

    // Security/Trust indicators
    secureConnection: '#2ea043',
    insecureConnection: '#9e6a03',
    localConnection: '#0078d4',

    // Quick action colors
    actionAnalyze: '#0078d4',
    actionDebug: '#f85149',
    actionGenerate: '#85b6ff',
    actionTest: '#2ea043',

    // Checkpoint/restore
    checkpoint: '#9e6a03',
    checkpointForeground: '#e2c08d',
  },
};

/**
 * Default light theme tokens (base fallback)
 */
export const DEFAULT_LIGHT_TOKENS: ThemeTokens = {
  editor: {
    background: '#ffffff',
    foreground: '#000000',
    lineNumbers: '#237893',
    lineNumbersActive: '#000000',
    selection: '#add6ff',
    selectionHighlight: '#add6ff80',
    cursor: '#000000',
    cursorLine: '#0000000d',
    whitespace: '#d1d5db',
    indentGuide: '#e5e7eb',
    matchingBracket: '#000000',
    wordHighlight: '#57575740',
    findMatch: '#ea5c0055',
    findMatchHighlight: '#ea5c0033',
  },
  sidebar: {
    background: '#f3f3f3',
    foreground: '#616161',
    border: '#e5e5e5',
    itemHover: '#e8e8e8',
    itemActive: '#e8e8e8',
    itemSelected: '#e8e8e8',
    sectionHeader: '#616161',
  },
  chat: {
    background: '#ffffff',
    inputBackground: '#ffffff',
    inputBorder: '#e5e5e5',
    surface: '#f3f3f3',
    surfaceBorder: '#e5e5e5',
    surfaceMuted: '#f8f8f8',
    usageLow: '#0ea5e9',
    usageMedium: '#d97706',
    usageHigh: '#dc2626',
    userMessage: '#e3f2fd',
    assistantMessage: '#f3f3f3',
    thinkingBackground: '#e0e7ff',
    thinkingBorder: '#6366f1',
    toolCallBackground: '#dcfce7',
    toolCallBorder: '#22c55e',
    codeBlock: '#f3f3f3',
  },
  terminal: {
    background: '#ffffff',
    foreground: '#333333',
    cursor: '#000000',
    selection: '#add6ff',
    black: '#000000',
    red: '#cd3131',
    green: '#00bc00',
    yellow: '#949800',
    blue: '#0451a5',
    magenta: '#bc05bc',
    cyan: '#0598bc',
    white: '#555555',
    brightBlack: '#666666',
    brightRed: '#cd3131',
    brightGreen: '#14ce14',
    brightYellow: '#b5ba00',
    brightBlue: '#0451a5',
    brightMagenta: '#bc05bc',
    brightCyan: '#0598bc',
    brightWhite: '#a5a5a5',
  },
  statusBar: {
    background: '#007acc',
    foreground: '#ffffff',
    border: '#007acc',
    itemHover: '#ffffff20',
  },
  titleBar: {
    background: '#dddddd',
    foreground: '#333333',
    border: '#cccccc',
    buttonHover: '#00000010',
  },
  common: {
    primary: '#007acc',
    primaryHover: '#0062a3',
    primaryForeground: '#ffffff',
    secondary: '#e5e5e5',
    secondaryHover: '#d4d4d4',
    secondaryForeground: '#333333',
    success: '#16a34a',
    successForeground: '#ffffff',
    warning: '#d97706',
    warningForeground: '#ffffff',
    error: '#dc2626',
    errorForeground: '#ffffff',
    info: '#0451a5',
    infoForeground: '#ffffff',
    border: '#e5e5e5',
    borderHover: '#c5c5c5',
    shadow: '#00000022',
    overlay: '#00000040',
    scrollbar: '#64646466',
    scrollbarHover: '#64646499',

    // === Extended Semantic Tokens (Light) ===

    // Muted/disabled states
    muted: '#f3f3f3',
    mutedForeground: '#616161',

    // Accent colors
    accent: '#007acc',
    accentForeground: '#ffffff',
    accentMuted: '#007acc20',

    // Destructive actions
    destructive: '#dc2626',
    destructiveForeground: '#ffffff',
    
    // General text colors
    textPrimary: '#333333',
    textSecondary: '#616161',
    textDisabled: '#9ca3af',

    // Git/File diff colors
    diffAdded: '#16a34a',
    diffAddedForeground: '#15803d',
    diffRemoved: '#dc2626',
    diffRemovedForeground: '#b91c1c',
    diffModified: '#d97706',
    diffModifiedForeground: '#b45309',

    // Status indicator dots
    statusActive: '#16a34a',
    statusInactive: '#616161',
    statusError: '#dc2626',
    statusWarning: '#d97706',

    // Task/Todo status colors
    taskPending: '#616161',
    taskInProgress: '#0451a5',
    taskCompleted: '#16a34a',
    taskCancelled: '#dc2626',

    // Security/Trust indicators
    secureConnection: '#16a34a',
    insecureConnection: '#d97706',
    localConnection: '#0451a5',

    // Quick action colors
    actionAnalyze: '#0451a5',
    actionDebug: '#dc2626',
    actionGenerate: '#7c3aed',
    actionTest: '#16a34a',

    // Checkpoint/restore
    checkpoint: '#d97706',
    checkpointForeground: '#b45309',
  },
};

// Export singleton instance
export const themeService = new ThemeService();
