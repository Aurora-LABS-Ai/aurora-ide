import { create } from "zustand";

import {
  createExplorerIconPackFromAuroraBundle,
  parseAuroraIconPackBundle,
  type AuroraIconPackBundle,
} from "../lib/aurora-icon-pack";
import {
  DEFAULT_EXPLORER_ICON_PACK_ID,
  registerCustomExplorerIconPacks,
} from "../lib/icon-packs";
import { databaseService } from "../services/database";

const STORAGE_KEY = "customIconPacks";
const FALLBACK_STORAGE_KEY = "aurora_custom_icon_packs";

interface IconPackState {
  customPacks: AuroraIconPackBundle[];
  deleteCustomPack: (packId: string) => Promise<void>;
  error: string | null;
  importAuroraIconPack: (content: string) => Promise<AuroraIconPackBundle>;
  initializeFromDatabase: () => Promise<void>;
  isInitialized: boolean;
  isLoading: boolean;
}

const canUseTauriSettings = (): boolean => {
  return typeof window !== "undefined" && "__TAURI__" in window;
};

const persistCustomPacks = async (
  packs: AuroraIconPackBundle[],
): Promise<void> => {
  const serialized = JSON.stringify(packs);

  if (canUseTauriSettings()) {
    await databaseService.setSetting(STORAGE_KEY, serialized);
  }

  if (typeof window !== "undefined") {
    localStorage.setItem(FALLBACK_STORAGE_KEY, serialized);
  }
};

const loadSerializedCustomPacks = async (): Promise<string | null> => {
  if (canUseTauriSettings()) {
    const persisted = await databaseService.getSetting(STORAGE_KEY);
    if (persisted) return persisted;
  }

  if (typeof window !== "undefined") {
    return localStorage.getItem(FALLBACK_STORAGE_KEY);
  }

  return null;
};

const applyCustomPackRegistry = (packs: AuroraIconPackBundle[]) => {
  registerCustomExplorerIconPacks(
    packs.map((bundle) => createExplorerIconPackFromAuroraBundle(bundle)),
  );
};

export const useIconPackStore = create<IconPackState>()((set, get) => ({
  customPacks: [],
  error: null,
  isInitialized: false,
  isLoading: false,

  initializeFromDatabase: async () => {
    if (get().isLoading || get().isInitialized) return;

    set({ isLoading: true, error: null });

    try {
      const serialized = await loadSerializedCustomPacks();
      if (!serialized) {
        applyCustomPackRegistry([]);
        set({ customPacks: [], isInitialized: true, isLoading: false });
        return;
      }

      const rawPacks: unknown = JSON.parse(serialized);
      if (!Array.isArray(rawPacks)) {
        throw new Error("Stored Aurora icon packs are not a valid array.");
      }

      const bundles = rawPacks.map((bundle) =>
        parseAuroraIconPackBundle(JSON.stringify(bundle)),
      );

      applyCustomPackRegistry(bundles);
      set({
        customPacks: bundles,
        isInitialized: true,
        isLoading: false,
      });
    } catch (error) {
      console.error("Failed to initialize Aurora icon packs:", error);
      applyCustomPackRegistry([]);
      set({
        customPacks: [],
        error: (error as Error).message,
        isInitialized: true,
        isLoading: false,
      });
    }
  },

  importAuroraIconPack: async (content: string) => {
    set({ isLoading: true, error: null });

    try {
      const bundle = parseAuroraIconPackBundle(content);
      if (bundle.manifest.id === DEFAULT_EXPLORER_ICON_PACK_ID) {
        throw new Error(
          `Pack id "${bundle.manifest.id}" is reserved for a built-in Aurora icon pack.`,
        );
      }

      const nextPacks = [
        ...get().customPacks.filter(
          (pack) => pack.manifest.id !== bundle.manifest.id,
        ),
        bundle,
      ].sort((a, b) => a.manifest.name.localeCompare(b.manifest.name));

      applyCustomPackRegistry(nextPacks);
      await persistCustomPacks(nextPacks);

      set({
        customPacks: nextPacks,
        isLoading: false,
      });

      return bundle;
    } catch (error) {
      set({
        error: (error as Error).message,
        isLoading: false,
      });
      throw error;
    }
  },

  deleteCustomPack: async (packId: string) => {
    set({ isLoading: true, error: null });

    try {
      const nextPacks = get().customPacks.filter(
        (pack) => pack.manifest.id !== packId,
      );
      applyCustomPackRegistry(nextPacks);
      await persistCustomPacks(nextPacks);
      set({
        customPacks: nextPacks,
        isLoading: false,
      });
    } catch (error) {
      set({
        error: (error as Error).message,
        isLoading: false,
      });
      throw error;
    }
  },
}));
