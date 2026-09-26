import { create } from "zustand";

import {
  DEFAULT_EXPLORER_ICON_PACK_ID,
  isExplorerIconPackAvailable,
  setActiveExplorerIconPackId,
} from "@/kernel/lib/icons/icon-packs";
import type { ExplorerIconPackId } from "@/kernel/lib/icons/icon-types";
import { databaseService } from "@/kernel/services/database";
import type { AppSettings as DbAppSettings } from "@/kernel/types/database";
import { createSettingsSaveScheduler } from "./settings/save-scheduler";
import { applyUiPreferences, clampTextScale } from "./settings/ui-preferences";
import { useIconPackStore } from "./useIconPackStore";

/**
 * The editor's and the app's own settings — the ones both windows share:
 * editor font size, word wrap, autosave, theme, UI font and text size, the
 * file-icon pack, and whether first-run onboarding was seen.
 *
 * Everything about the agent (providers, models, modes, agent preferences)
 * lives in the Agent Window's `useAgentSettingsStore`. The editor carries no
 * agent, so nothing here may depend on it.
 *
 * Both stores read the same `app_settings` table and each WRITES ONLY ITS OWN
 * KEYS (`saveAppSettingsEntries`), so saving here can never put a stale copy of
 * the agent's settings back, and the other way round.
 */

export type AutoSaveMode = 'off' | 'afterDelay' | 'onFocusChange' | 'onWindowChange';

const AUTO_SAVE_MODES: readonly AutoSaveMode[] = ['off', 'afterDelay', 'onFocusChange', 'onWindowChange'];
const ONBOARDING_SEEN_KEY = 'aurora_has_seen_onboarding';

interface SettingsState {
  isInitialized: boolean;
  isLoading: boolean;

  fontSize: number;
  wrapMode: boolean;
  theme: "dark" | "light";
  autoSave: AutoSaveMode;
  autoSaveDelay: number; // in milliseconds
  uiFontFamily: string;
  uiTextScale: number;
  explorerIconPack: ExplorerIconPackId;
  hasSeenOnboarding: boolean;

  initializeFromDatabase: () => Promise<void>;
  saveToDatabase: () => Promise<void>;
  saveToDatabaseImmediate: () => Promise<void>;

  setFontSize: (size: number) => void;
  setWrapMode: (enabled: boolean) => void;
  setTheme: (theme: "dark" | "light") => void;
  setAutoSave: (mode: AutoSaveMode) => void;
  setAutoSaveDelay: (delay: number) => void;
  setUiFontFamily: (family: string) => void;
  setUiTextScale: (scale: number) => void;
  setExplorerIconPack: (packId: ExplorerIconPackId) => void;
  setHasSeenOnboarding: (seen: boolean) => void;
}

const saveScheduler = createSettingsSaveScheduler();

const iconPackOrDefault = (packId: string | undefined): ExplorerIconPackId => {
  const candidate = packId || DEFAULT_EXPLORER_ICON_PACK_ID;
  return (isExplorerIconPackAvailable(candidate)
    ? candidate
    : DEFAULT_EXPLORER_ICON_PACK_ID) as ExplorerIconPackId;
};

const readOnboardingSeen = (): boolean => {
  try {
    return localStorage.getItem(ONBOARDING_SEEN_KEY) === 'true';
  } catch {
    return false;
  }
};

export const useSettingsStore = create<SettingsState>()((set, get) => ({
  isInitialized: false,
  isLoading: false,

  fontSize: 14,
  wrapMode: true,
  theme: "dark",
  autoSave: 'off',
  autoSaveDelay: 1000,
  uiFontFamily: "system",
  uiTextScale: 1,
  explorerIconPack: DEFAULT_EXPLORER_ICON_PACK_ID,
  hasSeenOnboarding: false,

  initializeFromDatabase: async () => {
    const state = get();
    if (state.isLoading || state.isInitialized) return;
    set({ isLoading: true });

    try {
      await useIconPackStore.getState().initializeFromDatabase();
      const appSettings = await databaseService.getAppSettings();
      if (appSettings) {
        set({
          fontSize: appSettings.fontSize ?? 14,
          wrapMode: appSettings.wrapMode ?? true,
          theme: appSettings.theme === 'light' ? 'light' : 'dark',
          autoSave: AUTO_SAVE_MODES.includes(appSettings.autoSave as AutoSaveMode)
            ? (appSettings.autoSave as AutoSaveMode)
            : 'off',
          autoSaveDelay: appSettings.autoSaveDelay ?? 1000,
          uiFontFamily: appSettings.uiFontFamily ?? "system",
          uiTextScale: appSettings.uiTextScale ?? 1,
          explorerIconPack: iconPackOrDefault(appSettings.explorerIconPack),
        });
      }
    } catch (error) {
      console.error('Failed to initialize settings from database:', error);
    }

    const { explorerIconPack, uiFontFamily, uiTextScale } = get();
    setActiveExplorerIconPackId(explorerIconPack);
    applyUiPreferences(uiFontFamily, uiTextScale);
    set({ hasSeenOnboarding: readOnboardingSeen(), isInitialized: true, isLoading: false });
  },

  saveToDatabase: () => saveScheduler.schedule(() => get().saveToDatabaseImmediate()),

  saveToDatabaseImmediate: async () => {
    const state = get();
    const entries: Partial<DbAppSettings> = {
      fontSize: state.fontSize,
      wrapMode: state.wrapMode,
      theme: state.theme,
      autoSave: state.autoSave,
      autoSaveDelay: state.autoSaveDelay,
      uiFontFamily: state.uiFontFamily,
      // UI scaling is intentionally disabled; the key is still written so an
      // older build reading it sees 1.
      uiScale: 1,
      uiTextScale: state.uiTextScale,
      explorerIconPack: state.explorerIconPack,
    };
    try {
      await databaseService.saveAppSettingsEntries(entries);
    } catch (error) {
      console.error('Failed to save settings to database:', error);
    }
  },

  setFontSize: (size) => {
    set({ fontSize: size });
    get().saveToDatabase();
  },

  setWrapMode: (enabled) => {
    set({ wrapMode: enabled });
    get().saveToDatabase();
  },

  setTheme: (theme) => {
    set({ theme });
    get().saveToDatabase();
  },

  setAutoSave: (mode) => {
    set({ autoSave: mode });
    get().saveToDatabase();
  },

  setAutoSaveDelay: (delay) => {
    set({ autoSaveDelay: delay });
    get().saveToDatabase();
  },

  setUiFontFamily: (family) => {
    set({ uiFontFamily: family });
    applyUiPreferences(family, get().uiTextScale);
    get().saveToDatabase();
  },

  setUiTextScale: (scale) => {
    const clamped = clampTextScale(scale);
    set({ uiTextScale: clamped });
    applyUiPreferences(get().uiFontFamily, clamped);
    get().saveToDatabase();
  },

  setExplorerIconPack: (packId) => {
    const nextPackId = iconPackOrDefault(packId);
    set({ explorerIconPack: nextPackId });
    setActiveExplorerIconPackId(nextPackId);
    get().saveToDatabase();
  },

  setHasSeenOnboarding: (seen) => {
    set({ hasSeenOnboarding: seen });
    try {
      localStorage.setItem(ONBOARDING_SEEN_KEY, String(seen));
    } catch (error) {
      console.error('Failed to remember onboarding state:', error);
    }
  },
}));

/**
 * Force any debounced settings write to flush immediately. Safe to call when
 * nothing is pending (no-op).
 */
export const flushSettingsSave = (): void => {
  saveScheduler.flush(() => useSettingsStore.getState().saveToDatabaseImmediate());
};

// Load from the database when the module loads (for Tauri).
if (typeof window !== 'undefined') {
  // Wait for Tauri to be ready
  setTimeout(() => {
    void useSettingsStore.getState().initializeFromDatabase();
  }, 100);

  // Flush any pending debounced save on unload so the last change inside the
  // debounce window isn't lost when the window closes.
  window.addEventListener('beforeunload', () => {
    flushSettingsSave();
  });
}
