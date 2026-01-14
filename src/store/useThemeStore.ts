import { invoke } from "@tauri-apps/api/core";

import { create } from "zustand";

import { themeService } from "../services/theme-service";
import type { ThemeDefinition, ThemeFile, ThemeStore } from "../types/theme";

/**
 * Generate a stable theme ID from name and author
 */
function generateThemeId(name: string, author: string): string {
    const nameSlug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').substring(0, 30);
    const authorSlug = author.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').substring(0, 15);
    return `theme-${nameSlug}-${authorSlug}`;
}

/**
 * Check if a theme name is reserved for built-in themes
 */
function isBuiltInThemeName(name: string): boolean {
    return BUILT_IN_THEME_NAMES.includes(name.toLowerCase().trim());
}

// Built-in themes - these cannot be overwritten
const BUILT_IN_THEME_NAMES = ['aurora dark', 'aurora light'];

export const useThemeStore = create<ThemeStore>((set, get) => ({
    activeThemeId: 'dark',
    themes: [], // Will be populated on init
    isLoading: true,
    error: null,

    setActiveTheme: async (themeId: string) => {
        try {
            set({ isLoading: true, error: null });

            const theme = get().themes.find(t => t.id === themeId);
            if (!theme) {
                throw new Error(`Theme '${themeId}' not found`);
            }

            // Apply the theme via service
            themeService.applyTheme(theme);

            // Persist to local storage for cross-window sync
            localStorage.setItem('aurora_theme_id', themeId);

            // Persist to settings
            await invoke('set_active_theme_id', { themeId });

            set({ activeThemeId: themeId, isLoading: false });
        } catch (error) {
            set({ error: (error as Error).message, isLoading: false });
        }
    },

    importTheme: async (themeFile: ThemeFile) => {
        try {
            set({ isLoading: true, error: null });

            // Validate theme file structure
            const validation = themeService.validateThemeFile(themeFile);
            if (!validation.valid) {
                throw new Error(`Invalid theme file: ${validation.errors.join(', ')}`);
            }

            // Prevent overwriting built-in themes
            if (isBuiltInThemeName(themeFile.name)) {
                throw new Error(`Cannot import theme with reserved name "${themeFile.name}". Built-in themes cannot be overwritten.`);
            }

            // Generate stable ID from name+author
            const themeId = generateThemeId(themeFile.name, themeFile.author);

            // Convert to definition (merges with base theme for missing tokens)
            const definition = themeService.createThemeDefinition(themeFile, themeId, false);

            // Prepare payload for database
            // Backend handles duplicate detection by name+author - will update if exists
            const payload = {
                id: themeId,
                name: definition.name,
                author: definition.author,
                version: definition.version,
                type: definition.type,
                colors: JSON.stringify(definition.colors),
                tokenColors: JSON.stringify(definition.tokenColors),
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString()
            };

            // Save to DB - backend handles duplicates (upsert by name+author)
            await invoke('save_custom_theme', { theme: payload });

            // Reload all themes from database to get clean state
            const customThemesRaw = await invoke<any[]>('get_custom_themes');
            const customThemes: ThemeDefinition[] = customThemesRaw
                .map(t => {
                    try {
                        return {
                            id: t.id,
                            name: t.name,
                            author: t.author,
                            version: t.version,
                            type: t.type,
                            colors: JSON.parse(t.colors),
                            tokenColors: JSON.parse(t.tokenColors),
                            isBuiltIn: false
                        };
                    } catch (e) {
                        console.error(`[ThemeStore] Failed to parse theme "${t.name}":`, e);
                        return null;
                    }
                })
                .filter((t): t is ThemeDefinition => t !== null);

            // Rebuild themes list with built-ins + fresh custom themes
            const builtInThemes = get().themes.filter(t => t.isBuiltIn);
            set({
                themes: [...builtInThemes, ...customThemes],
                isLoading: false
            });

            return definition;
        } catch (error) {
            set({ error: (error as Error).message, isLoading: false });
            throw error;
        }
    },

    deleteTheme: async (themeId: string) => {
        try {
            set({ isLoading: true, error: null });

            const theme = get().themes.find(t => t.id === themeId);
            if (!theme) {
                throw new Error(`Theme '${themeId}' not found`);
            }

            if (theme.isBuiltIn) {
                throw new Error('Cannot delete built-in themes');
            }

            // If deleting active theme, switch to default dark
            if (get().activeThemeId === themeId) {
                await get().setActiveTheme('dark');
            }

            // Delete from DB
            await invoke('delete_custom_theme', { id: themeId });

            set(state => ({
                themes: state.themes.filter(t => t.id !== themeId),
                isLoading: false
            }));
        } catch (error) {
            set({ error: (error as Error).message, isLoading: false });
        }
    },

    getTheme: (themeId: string) => {
        return get().themes.find(t => t.id === themeId);
    },

    getActiveTheme: () => {
        const { activeThemeId, themes } = get();
        return themes.find(t => t.id === activeThemeId) || themes[0]; // Fallback to first if not found
    },

    initializeFromDatabase: async () => {
        try {
            set({ isLoading: true });

            // Load built-in themes
            const darkTokens = themeService.getBaseTokens('dark');
            const lightTokens = themeService.getBaseTokens('light');

            const darkTheme: ThemeDefinition = {
                id: 'dark',
                name: 'Aurora Dark',
                author: 'Aurora Team',
                version: '1.0.0',
                type: 'dark',
                isBuiltIn: true,
                colors: darkTokens,
                tokenColors: []
            };

            const lightTheme: ThemeDefinition = {
                id: 'light',
                name: 'Aurora Light',
                author: 'Aurora Team',
                version: '1.0.0',
                type: 'light',
                isBuiltIn: true,
                colors: lightTokens,
                tokenColors: []
            };

            // Load custom themes from DB (backend handles deduplication)
            const customThemesRaw = await invoke<any[]>('get_custom_themes');
            const customThemes: ThemeDefinition[] = customThemesRaw
                .map(t => {
                    try {
                        return {
                            id: t.id,
                            name: t.name,
                            author: t.author,
                            version: t.version,
                            type: t.type,
                            colors: JSON.parse(t.colors),
                            tokenColors: JSON.parse(t.tokenColors),
                            isBuiltIn: false
                        };
                    } catch (e) {
                        console.error(`[ThemeStore] Failed to parse theme "${t.name}":`, e);
                        return null;
                    }
                })
                .filter((t): t is ThemeDefinition => t !== null);

            const allThemes = [darkTheme, lightTheme, ...customThemes];

            set({
                themes: allThemes,
                isLoading: false
            });

            // Initialize with default or stored preference
            let initialThemeId = localStorage.getItem('aurora_theme_id');

            if (!initialThemeId) {
                const dbThemeId = await invoke<string | null>('get_active_theme_id');
                if (dbThemeId) initialThemeId = dbThemeId;
            }

            // Apply theme (fallback to dark if stored theme doesn't exist)
            const targetThemeId = initialThemeId || 'dark';
            const themeExists = allThemes.some(t => t.id === targetThemeId);
            get().setActiveTheme(themeExists ? targetThemeId : 'dark');

            // Listen for storage changes to sync windows
            window.addEventListener('storage', (e) => {
                if (e.key === 'aurora_theme_id' && e.newValue) {
                    get().setActiveTheme(e.newValue);
                }
            });

        } catch (error) {
            set({ error: (error as Error).message, isLoading: false });
        }
    }
}));
