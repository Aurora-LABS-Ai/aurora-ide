import { v4 as uuidv4 } from "uuid";

import { databaseService } from "@/kernel/services/database";
import {
  addCategory,
  assignProviderToCategory,
  deleteCategory,
  moveCategory,
  recolorCategory,
  renameCategory,
  type CategoryColor,
} from "@/apps/agent/services/providers/provider-categories";
import {
  DEFAULT_SELECTED_MODEL,
  modelToDb,
  resolveSelectedModel,
  syncThinkingForSelectedModel,
  synthesizeLegacyProviderFields,
  type LLMModel,
  type LLMProvider,
} from "../provider-model";
import type { SettingsGet, SettingsSet, SettingsState } from "../state";
import { normalizeProviderDescription } from "../values";

/** Provider rows and provider categories: edit, add, delete, remove. */
export const createProvidersSlice = (set: SettingsSet, get: SettingsGet) =>
  ({
  // ============================================
  // PROVIDER ACTIONS
  // ============================================

  updateProvider: (id: string, updates: Partial<LLMProvider>) => {
    // Translate writes to legacy fields back into models-slice ops.
    // This keeps existing UI (Fireworks tab, LocalProviderPanel) and
    // their `updateProvider({ customModels, modelAliases, supportsThinking,
    // supportsVision })` calls working without per-call rewrites.
    const {
      customModels: nextCustomModels,
      modelAliases: nextModelAliases,
      supportsThinking: nextSupportsThinking,
      supportsVision: nextSupportsVision,
      ...providerUpdates
    } = updates;

    set((state: SettingsState) => {
      const providers = state.providers.map((provider: LLMProvider) => {
        if (provider.id !== id) return provider;

        const nextProvider = {
          ...provider,
          ...providerUpdates,
        };

        return {
          ...nextProvider,
          nickname: nextProvider.nickname?.trim() || undefined,
          description: normalizeProviderDescription(nextProvider.description),
        };
      });

      // ── Reconcile legacy field writes against the models slice ──
      let nextModels = state.models;
      if (nextCustomModels !== undefined) {
        const targetKeys = Array.from(
          new Set((nextCustomModels || []).filter(Boolean)),
        );
        const existing = state.models.filter((m) => m.providerId === id);
        const others = state.models.filter((m) => m.providerId !== id);
        const reconciled = targetKeys.map((modelKey, idx) => {
          const prior = existing.find((m) => m.modelKey === modelKey);
          if (prior) return { ...prior, sortOrder: idx };
          return {
            id: `${id}::${modelKey}`,
            providerId: id,
            modelKey,
            label: nextModelAliases?.[modelKey] || undefined,
            contextWindow: undefined,
            maxOutputTokens: undefined,
            supportsVision: false,
            supportsThinking: nextSupportsThinking ?? false,
            supportsToolStream: false,
            enabled: true,
            sortOrder: idx,
          } satisfies LLMModel;
        });
        nextModels = [...others, ...reconciled];
        // Persist the new roster (fire-and-forget; UI doesn't block).
        databaseService
          .replaceProviderModels(id, reconciled.map(modelToDb))
          .catch(console.error);
      }

      if (nextModelAliases !== undefined) {
        nextModels = nextModels.map((m) => {
          if (m.providerId !== id) return m;
          const nextLabel = nextModelAliases[m.modelKey];
          if (nextLabel === undefined && !m.label) return m;
          if (nextLabel === m.label) return m;
          const updated = { ...m, label: nextLabel?.trim() || undefined };
          databaseService.upsertProviderModel(modelToDb(updated)).catch(console.error);
          return updated;
        });
      }

      // Provider-level capability writes propagate to the active
      // model row (this is the closest match to the v14 semantics).
      const [activeProviderId, activeModelKey] = state.selectedModel.split(":");
      if (
        (nextSupportsVision !== undefined || nextSupportsThinking !== undefined) &&
        activeProviderId === id
      ) {
        nextModels = nextModels.map((m) => {
          if (m.providerId !== id || m.modelKey !== activeModelKey) return m;
          const updated: LLMModel = {
            ...m,
            supportsVision:
              nextSupportsVision !== undefined ? nextSupportsVision : m.supportsVision,
            supportsThinking:
              nextSupportsThinking !== undefined ? nextSupportsThinking : m.supportsThinking,
          };
          databaseService.upsertProviderModel(modelToDb(updated)).catch(console.error);
          return updated;
        });
      }

      const selectedModel = resolveSelectedModel(state.selectedModel, providers);
      const synthesized = synthesizeLegacyProviderFields(
        providers,
        nextModels,
        selectedModel,
      );

      return {
        providers: synthesized,
        models: nextModels,
        selectedModel,
        thinkingEnabled: syncThinkingForSelectedModel(
          selectedModel,
          synthesized,
          nextModels,
          state.thinkingEnabled,
        ),
      };
    });
    // Persist (debouncing now lives inside saveToDatabase).
    get().saveToDatabase();
  },

  // ── Provider categories ────────────────────────────────────────────────
  //
  // Every one of these is a pure transform in
  // `services/providers/provider-categories.ts` plus a save. The rules — one
  // category per provider, seeds cannot be edited, a deleted category frees
  // its rows rather than taking them with it — live there and are tested
  // there, so nothing about them is decided in this store.

  createProviderCategory: (name: string, color?: CategoryColor) => {
    const made = addCategory(get().providerCategories, name, color);
    // Refused: empty, or a name already in the rail. The caller keeps the
    // draft open and says so, rather than this inventing "Coding plans (2)".
    if (!made) return null;
    set({ providerCategories: made.state });
    get().saveToDatabase();
    return made.id;
  },

  renameProviderCategory: (id: string, name: string) => {
    const next = renameCategory(get().providerCategories, id, name);
    if (!next) return false;
    set({ providerCategories: next });
    get().saveToDatabase();
    return true;
  },

  setProviderCategoryColor: (id: string, color: CategoryColor) => {
    set({ providerCategories: recolorCategory(get().providerCategories, id, color) });
    get().saveToDatabase();
  },

  deleteProviderCategory: (id: string) => {
    set({ providerCategories: deleteCategory(get().providerCategories, id) });
    get().saveToDatabase();
  },

  moveProviderCategory: (id: string, direction: -1 | 1) => {
    set({ providerCategories: moveCategory(get().providerCategories, id, direction) });
    get().saveToDatabase();
  },

  setProviderCategory: (providerId: string, categoryId: string | null) => {
    const state = get();
    // The provider's own origin decides which system category counts as its
    // home, and the transform stores "moved to my own home" as unfiled.
    const isCustom = !!state.providers.find((p) => p.id === providerId)?.isCustom;
    set({
      providerCategories: assignProviderToCategory(
        state.providerCategories,
        providerId,
        categoryId,
        isCustom,
      ),
    });
    get().saveToDatabase();
  },

  addCustomProvider: (provider: Omit<LLMProvider, "id" | "isCustom">) => {
    const id = uuidv4();
    const newProvider: LLMProvider = {
      ...provider,
      id,
      isCustom: true,
      nickname: provider.nickname?.trim() || undefined,
      description: normalizeProviderDescription(provider.description),
    };

    // Seed the models slice from the legacy fields the caller passed.
    // Old AddProviderForm hands us `{ model, customModels: [model],
    // supportsThinking, supportsVision }`; the new ProvidersHubTab
    // calls `addModel` separately. Both paths land in the same place.
    const seedKeys = Array.from(
      new Set(
        [provider.model, ...(provider.customModels || [])].filter(
          (k): k is string => !!k && !!k.trim(),
        ),
      ),
    );
    const seededModels: LLMModel[] = seedKeys.map((modelKey, idx) => ({
      id: `${id}::${modelKey}`,
      providerId: id,
      modelKey,
      label: provider.modelAliases?.[modelKey] || undefined,
      contextWindow: undefined,
      maxOutputTokens: undefined,
      supportsVision: !!provider.supportsVision,
      supportsThinking: !!provider.supportsThinking,
      supportsToolStream: !!provider.supportsToolStream,
      enabled: true,
      sortOrder: idx,
    }));

    set((state: SettingsState) => {
      const nextProviders = [...state.providers, newProvider];
      const nextModels = [...state.models, ...seededModels];
      const synthesized = synthesizeLegacyProviderFields(
        nextProviders,
        nextModels,
        state.selectedModel,
      );
      return { providers: synthesized, models: nextModels };
    });

    // Persist provider + models.
    get().saveToDatabase();
    for (const m of seededModels) {
      databaseService.upsertProviderModel(modelToDb(m)).catch(console.error);
    }
    return id;
  },

  deleteProvider: (id: string) => {
    const state = get();
    const provider = state.providers.find((p: LLMProvider) => p.id === id);
    // Only allow deleting custom providers
    if (provider?.isCustom) {
      set((state: SettingsState) => {
        const nextProviders = state.providers.filter((p: LLMProvider) => p.id !== id);
        const nextModels = state.models.filter((m) => m.providerId !== id);
        const nextSelected = state.selectedModel.startsWith(id + ":")
          ? DEFAULT_SELECTED_MODEL
          : state.selectedModel;
        const synthesized = synthesizeLegacyProviderFields(
          nextProviders,
          nextModels,
          nextSelected,
        );
        return {
          providers: synthesized,
          models: nextModels,
          selectedModel: nextSelected,
        };
      });
      // Delete from database. Models cascade via FK, but we also call
      // the explicit delete to keep things tidy on platforms where
      // foreign_keys is off.
      databaseService.deleteProvider(id).catch(console.error);
      get().saveToDatabase();
    }
  },

  removeProvider: (id: string) => {
    const state = get();
    const provider = state.providers.find((p: LLMProvider) => p.id === id);
    if (!provider) return;

    // Custom providers are truly deleted — nothing re-seeds them.
    if (provider.isCustom) {
      get().deleteProvider(id);
      return;
    }

    // Built-in preset: it would re-seed on the next launch, so record its id
    // in `removedProviderIds` (persisted) AND drop it (+ its models) from the
    // live state now. Also delete its DB row. This is permanent — the recorded
    // id is the only thing keeping the preset from silently re-seeding.
    set((s: SettingsState) => {
      const removedProviderIds = s.removedProviderIds.includes(id)
        ? s.removedProviderIds
        : [...s.removedProviderIds, id];
      const nextProviders = s.providers.filter((p: LLMProvider) => p.id !== id);
      const nextModels = s.models.filter((m) => m.providerId !== id);
      const nextSelected = s.selectedModel.startsWith(id + ":")
        ? DEFAULT_SELECTED_MODEL
        : s.selectedModel;
      const synthesized = synthesizeLegacyProviderFields(
        nextProviders,
        nextModels,
        nextSelected,
      );
      return {
        removedProviderIds,
        providers: synthesized,
        models: nextModels,
        selectedModel: nextSelected,
      };
    });
    databaseService.deleteProvider(id).catch(console.error);
    get().saveToDatabase();
  },
  }) satisfies Partial<SettingsState>;
