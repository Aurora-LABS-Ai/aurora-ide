/**
 * The UI font and text size, as the editor/shared settings store applies them
 * to the page. `kernel/lib/fonts/boot.ts` reads the cached result before first
 * paint.
 */
import { cacheUiPreferences } from "@/kernel/lib/fonts/boot";

const UI_FONT_FAMILIES: Record<string, string> = {
  system: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, 'Open Sans', 'Helvetica Neue', sans-serif",
  inter: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
  segoe: "'Segoe UI', -apple-system, BlinkMacSystemFont, sans-serif",
  roboto: "'Roboto', -apple-system, BlinkMacSystemFont, sans-serif",
  manrope: "'Manrope', 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
  poppins: "'Poppins', 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
  sourceSans: "'Source Sans 3', 'Source Sans Pro', 'Segoe UI', sans-serif",
  openSans: "'Open Sans', 'Segoe UI', Roboto, sans-serif",
  nunito: "'Nunito Sans', 'Nunito', 'Segoe UI', sans-serif",
  lato: "'Lato', 'Segoe UI', Roboto, sans-serif",
  ubuntu: "'Ubuntu', 'Segoe UI', Roboto, sans-serif",
};

export const clampTextScale = (value: number): number => Math.min(1.4, Math.max(0.85, value));

export const applyUiPreferences = (fontFamily: string, textScale: number) => {
  if (typeof document === 'undefined') return;
  const resolvedFamily = UI_FONT_FAMILIES[fontFamily] ?? UI_FONT_FAMILIES.system;
  const scale = clampTextScale(textScale);
  // UI scaling is intentionally disabled. Keep this hardcoded at 1.
  document.documentElement.style.setProperty('--aurora-ui-scale', '1');
  document.documentElement.style.setProperty('--aurora-ui-text-scale', String(scale));
  document.documentElement.style.setProperty('--aurora-ui-font-family', resolvedFamily);
  // Mirror the RESOLVED values so the next boot can apply them synchronously
  // before first paint (kernel/lib/fonts/boot.ts) — these settings arrive over
  // async SQLite, and applying them only here made the window visibly
  // re-typeset itself moments after opening.
  cacheUiPreferences(resolvedFamily, scale);
};
