/**
 * Built-in Theme Exports
 * 
 * Provides access to Aurora's built-in themes: Dark, Light, and High Contrast.
 * Requirement 7.4: Include at least 3 built-in themes
 */
import { themeFileToDefinition } from "../services/theme-service";
import type { ThemeDefinition, ThemeFile } from "../types/theme";
import darkNeutralTheme from "./dark-neutral.json";
// Import theme JSON files
import darkTheme from "./dark.json";
import highContrastTheme from "./high-contrast.json";
import lightTheme from "./light.json";

/**
 * Get a specific built-in theme by ID
 */
export function getBuiltInTheme(id: string): ThemeDefinition | undefined {
  const themes = getBuiltInThemes();
  return themes.find(t => t.id === id);
}

/**
 * Get all built-in theme files
 */
export function getBuiltInThemeFiles(): ThemeFile[] {
  return [
    darkTheme as ThemeFile,
    lightTheme as ThemeFile,
    highContrastTheme as ThemeFile,
    darkNeutralTheme as ThemeFile,
  ];
}

/**
 * Get all built-in theme definitions (fully resolved)
 */
export function getBuiltInThemes(): ThemeDefinition[] {
  return [
    themeFileToDefinition(darkTheme as ThemeFile, BUILT_IN_THEME_IDS.DARK, true),
    themeFileToDefinition(lightTheme as ThemeFile, BUILT_IN_THEME_IDS.LIGHT, true),
    themeFileToDefinition(highContrastTheme as ThemeFile, BUILT_IN_THEME_IDS.HIGH_CONTRAST, true),
    themeFileToDefinition(darkNeutralTheme as ThemeFile, BUILT_IN_THEME_IDS.DARK_NEUTRAL, true),
  ];
}

/**
 * Check if a theme ID is a built-in theme
 */
export function isBuiltInTheme(id: string): boolean {
  return Object.values(BUILT_IN_THEME_IDS).includes(id as typeof BUILT_IN_THEME_IDS[keyof typeof BUILT_IN_THEME_IDS]);
}

/**
 * Built-in theme IDs
 */
export const BUILT_IN_THEME_IDS = {
  DARK: 'aurora-dark',
  LIGHT: 'aurora-light',
  HIGH_CONTRAST: 'aurora-high-contrast',
  DARK_NEUTRAL: 'aurora-dark-neutral',
} as const;

/**
 * Default theme ID
 */
export const DEFAULT_THEME_ID = BUILT_IN_THEME_IDS.DARK;
