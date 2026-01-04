/**
 * Integration Tests for Theme System
 * 
 * Verifies the end-to-end functionality of the theme system:
 * 1. Theme Service logic (validation, merging, injection)
 * 2. Theme Store state management (import, select, delete)
 * 3. Monaco Theme conversion
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useThemeStore } from "../store/useThemeStore";
import type { ThemeFile } from "../types/theme";
import { themeService } from "./theme-service";

// Mock window.matchMedia
Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation(query => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: vi.fn(), // deprecated
        removeListener: vi.fn(), // deprecated
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
    })),
});

// Mock document functions
document.documentElement.setAttribute = vi.fn();

document.documentElement.classList.add = vi.fn();

document.documentElement.classList.remove = vi.fn();

const SAMPLE_THEME_FILE: ThemeFile = {
    name: 'Integration Test Theme',
    type: 'dark',
    author: 'Test Bot',
    version: '1.0.0',
    colors: {
        editor: {
            background: '#123456',
            foreground: '#ffffff'
        },
        common: {
            primary: '#ff0000'
        }
    },
    tokenColors: [
        {
            scope: 'comment',
            settings: { foreground: '#888888' }
        }
    ]
};

describe('Theme System Integration', () => {
    beforeEach(async () => {
        // Reset store state
        useThemeStore.setState({
            themes: [],
            activeThemeId: 'dark',
            isLoading: false,
            error: null
        });

        // Reset mocks
        vi.clearAllMocks();

        // Initialize base themes in store (mocking database load)
        const { initializeFromDatabase } = useThemeStore.getState();
        await initializeFromDatabase();
    });

    it('should initialize with default themes', () => {
        const { themes, activeThemeId } = useThemeStore.getState();

        expect(themes.length).toBeGreaterThanOrEqual(1);
        expect(activeThemeId).toBe('dark');

        const darkTheme = themes.find(t => t.id === 'dark');
        expect(darkTheme).toBeDefined();
        expect(darkTheme?.isBuiltIn).toBe(true);
    });

    it('should apply the default theme on initialization', () => {
        const { activeThemeId } = useThemeStore.getState();
        expect(activeThemeId).toBe('dark');
    });

    it('should import a valid custom theme', async () => {
        const { importTheme } = useThemeStore.getState();

        await importTheme(SAMPLE_THEME_FILE);

        const { themes } = useThemeStore.getState();
        const imported = themes.find(t => t.name === 'Integration Test Theme');

        expect(imported).toBeDefined();
        expect(imported?.colors.editor.background).toBe('#123456');
        expect(imported?.isBuiltIn).toBe(false);
    });

    it('should switch to the imported theme', async () => {
        await useThemeStore.getState().importTheme(SAMPLE_THEME_FILE);

        // Get the ID of the new theme
        const state = useThemeStore.getState();
        const newThemeId = state.themes.find(t => t.name === 'Integration Test Theme')!.id;

        // Switch theme
        await state.setActiveTheme(newThemeId);

        expect(useThemeStore.getState().activeThemeId).toBe(newThemeId);

        // Verify CSS injection logic flows
        const activeTheme = useThemeStore.getState().themes.find(t => t.id === newThemeId)!;
        const monacoTheme = themeService.getMonacoTheme(activeTheme);

        expect(monacoTheme.base).toBe('vs-dark');
        expect(monacoTheme.colors['editor.background']).toBe('#123456');
    });

    it('should prevent deleting built-in themes', async () => {
        const darkId = 'dark';
        await useThemeStore.getState().deleteTheme(darkId);

        // Theme should still exist
        const store = useThemeStore.getState();
        expect(store.themes.find(t => t.id === darkId)).toBeDefined();
    });

    it('should delete custom themes and fall back to default', async () => {
        await useThemeStore.getState().importTheme(SAMPLE_THEME_FILE);

        const stateAfterImport = useThemeStore.getState();
        const newThemeId = stateAfterImport.themes.find(t => t.name === 'Integration Test Theme')!.id;

        await stateAfterImport.setActiveTheme(newThemeId);
        expect(useThemeStore.getState().activeThemeId).toBe(newThemeId);

        await useThemeStore.getState().deleteTheme(newThemeId);

        // Theme should be gone
        const finalState = useThemeStore.getState();
        expect(finalState.themes.find(t => t.id === newThemeId)).toBeUndefined();

        // Should fallback to default (likely 'dark')
        expect(finalState.activeThemeId).toBe('dark');
    });

    it('should generate valid Monaco theme data', () => {
        const store = useThemeStore.getState();
        const darkTheme = store.themes.find(t => t.id === 'dark');

        if (!darkTheme) throw new Error('Default theme not found');

        const monacoData = themeService.getMonacoTheme(darkTheme);

        expect(monacoData).toBeDefined();
        expect(monacoData.base).toBe('vs-dark');
        expect(monacoData.colors['editor.background']).toBeDefined();
        expect(Array.isArray(monacoData.rules)).toBe(true);
    });
});
