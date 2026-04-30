import { create } from "zustand";

import {
    auroraInvoke as invoke,
    isAuroraRuntimeAvailable,
} from "../lib/runtime";
import { themeService } from "../services/theme-service";
import type { ThemeDefinition, ThemeFile, ThemeStore } from "../types/theme";
import alvanAuroraDarkThemeFile from "../themes/alvan-aurora-dark.json";
import darkThemeFile from "../themes/dark.json";
import lightThemeFile from "../themes/light.json";

interface StoredThemeRow {
    id: string;
    name: string;
    author: string;
    version: string;
    type: 'dark' | 'light';
    colors: string;
    tokenColors: string;
}

interface StoredThemePayload {
    author: string;
    colors: string;
    createdAt: string;
    id: string;
    name: string;
    tokenColors: string;
    type: 'dark' | 'light';
    updatedAt: string;
    version: string;
}

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
const BUILT_IN_THEME_NAMES = ['aurora dark', 'aurora light', 'alvan aurora dark'];
let hasThemeStorageListener = false;

function canUseTauriThemeCommands(): boolean {
    return isAuroraRuntimeAvailable();
}

function deserializeStoredThemes(rows: StoredThemeRow[]): ThemeDefinition[] {
    return rows
        .map((theme) => {
            try {
                return {
                    id: theme.id,
                    name: theme.name,
                    author: theme.author,
                    version: theme.version,
                    type: theme.type,
                    colors: JSON.parse(theme.colors),
                    tokenColors: JSON.parse(theme.tokenColors),
                    isBuiltIn: false,
                };
            } catch (error) {
                console.error(`[ThemeStore] Failed to parse theme "${theme.name}":`, error);
                return null;
            }
        })
        .filter((theme): theme is ThemeDefinition => theme !== null);
}

function getBuiltInThemes(): ThemeDefinition[] {
    return [
        themeService.createThemeDefinition(darkThemeFile as ThemeFile, 'dark', true),
        themeService.createThemeDefinition(lightThemeFile as ThemeFile, 'light', true),
        themeService.createThemeDefinition(
            alvanAuroraDarkThemeFile as ThemeFile,
            'alvan-aurora-dark',
            true
        ),
    ];
}

async function loadCustomThemes(): Promise<ThemeDefinition[]> {
    if (!canUseTauriThemeCommands()) {
        return [];
    }

    const rows = await invoke<StoredThemeRow[]>('get_custom_themes');
    return deserializeStoredThemes(rows);
}

async function loadPersistedActiveThemeId(): Promise<string | null> {
    if (!canUseTauriThemeCommands()) {
        return null;
    }

    return invoke<string | null>('get_active_theme_id');
}

async function persistActiveThemeId(themeId: string): Promise<void> {
    if (!canUseTauriThemeCommands()) {
        return;
    }

    await invoke('set_active_theme_id', { themeId });
}

async function saveCustomTheme(payload: StoredThemePayload): Promise<void> {
    if (!canUseTauriThemeCommands()) {
        return;
    }

    await invoke('save_custom_theme', { theme: payload });
}

async function removeCustomTheme(themeId: string): Promise<void> {
    if (!canUseTauriThemeCommands()) {
        return;
    }

    await invoke('delete_custom_theme', { id: themeId });
}

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
            await persistActiveThemeId(themeId);

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
            await saveCustomTheme(payload);

            const builtInThemes = get().themes.filter(t => t.isBuiltIn);
            const customThemes = canUseTauriThemeCommands()
                ? await loadCustomThemes()
                : [
                    ...get().themes.filter(t => !t.isBuiltIn && t.id !== definition.id),
                    definition,
                ];

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
            await removeCustomTheme(themeId);

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

            const builtInThemes = getBuiltInThemes();
            const customThemes = await loadCustomThemes();
            const allThemes = [...builtInThemes, ...customThemes];

            set({
                themes: allThemes,
                isLoading: false
            });

            // Initialize with default or stored preference
            let initialThemeId = localStorage.getItem('aurora_theme_id');

            if (!initialThemeId) {
                const dbThemeId = await loadPersistedActiveThemeId();
                if (dbThemeId) initialThemeId = dbThemeId;
            }

            // Apply theme (fallback to dark if stored theme doesn't exist)
            const targetThemeId = initialThemeId || 'dark';
            const themeExists = allThemes.some(t => t.id === targetThemeId);
            await get().setActiveTheme(themeExists ? targetThemeId : 'dark');

            // Listen for storage changes to sync windows
            if (!hasThemeStorageListener) {
                window.addEventListener('storage', (e) => {
                    if (e.key === 'aurora_theme_id' && e.newValue) {
                        void get().setActiveTheme(e.newValue);
                    }
                });
                hasThemeStorageListener = true;
            }

        } catch (error) {
            set({ error: (error as Error).message, isLoading: false });
        }
    }
}));
