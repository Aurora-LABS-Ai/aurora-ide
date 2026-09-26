import { databaseService } from "@/kernel/services/database";
import {
  buildAvailableModelOptions,
  modelToDb,
  resolveModel,
  resolveSelectedModel,
  syncThinkingForSelectedModel,
  synthesizeLegacyProviderFields,
  type LLMModel,
  type LLMProvider,
} from "../provider-model";
import type { SettingsGet, SettingsSet, SettingsState } from "../state";

/** The selected model, per-model rows, and model lookups. */
export const createModelsSlice = (set: SettingsSet, get: SettingsGet) =>
  ({
  setSelectedModel: (model: string) => {
    set((state) => {
      const synthesized = synthesizeLegacyProviderFields(
        state.providers,
        state.models,
        model,
      );
      return {
        selectedModel: model,
        providers: synthesized,
        thinkingEnabled: syncThinkingForSelectedModel(
          model,
          synthesized,
          state.models,
          state.thinkingEnabled,
        ),
      };
    });
    get().saveToDatabase();
  },

  // ============================================
  // MODELS SLICE ACTIONS (v15+)
  // ============================================

  modelsForProvider: (providerId: string) => {
    return get()
      .models
      .filter((m) => m.providerId === providerId)
      .sort((a, b) => a.sortOrder - b.sortOrder);
  },

  getActiveModel: () => {
    const state = get();
    const [providerId, modelKey] = state.selectedModel.split(":");
    if (!providerId || !modelKey) return undefined;
    return state.models.find(
      (m) => m.providerId === providerId && m.modelKey === modelKey,
    );
  },

  getModelFor: (selection) => {
    if (!selection) return get().getActiveModel();
    const state = get();
    const separator = selection.indexOf(":");
    const providerId = separator < 0 ? selection : selection.slice(0, separator);
    const modelKey = separator < 0 ? "" : selection.slice(separator + 1);
    if (!providerId || !modelKey) return state.getActiveModel();
    return (
      state.models.find(
        (m) => m.providerId === providerId && m.modelKey === modelKey,
      ) ?? undefined
    );
  },

  getResolvedActiveModel: () => {
    const state = get();
    const [providerId] = state.selectedModel.split(":");
    const provider = state.providers.find((p) => p.id === providerId);
    const model = state.getActiveModel();
    if (!provider || !model) return undefined;
    return resolveModel(model, provider);
  },

  addModel: (providerId, init) => {
    const id = `${providerId}::${init.modelKey}`;
    const sortOrder =
      init.sortOrder ?? get().models.filter((m) => m.providerId === providerId).length;
    const newModel: LLMModel = {
      id,
      providerId,
      sortOrder,
      ...init,
    };
    set((state) => {
      const nextModels = [...state.models.filter((m) => m.id !== id), newModel];
      const synthesized = synthesizeLegacyProviderFields(
        state.providers,
        nextModels,
        state.selectedModel,
      );
      return {
        models: nextModels,
        providers: synthesized,
        // Re-adding a model the user once deleted is a change of mind —
        // lift its tombstone so the roster and the record agree.
        removedPresetModelIds: state.removedPresetModelIds.includes(id)
          ? state.removedPresetModelIds.filter((r) => r !== id)
          : state.removedPresetModelIds,
      };
    });
    databaseService.upsertProviderModel(modelToDb(newModel)).catch(console.error);
    return id;
  },

  updateModel: (id, updates) => {
    set((state) => {
      let updatedRow: LLMModel | undefined;
      const nextModels = state.models.map((m) => {
        if (m.id !== id) return m;
        const next: LLMModel = { ...m, ...updates };
        updatedRow = next;
        return next;
      });
      if (updatedRow) {
        databaseService
          .upsertProviderModel(modelToDb(updatedRow))
          .catch(console.error);
      }
      const synthesized = synthesizeLegacyProviderFields(
        state.providers,
        nextModels,
        state.selectedModel,
      );
      return { models: nextModels, providers: synthesized };
    });
  },

  deleteModel: (id) => {
    const state = get();
    const target = state.models.find((m) => m.id === id);
    if (!target) return;
    const nextModels = state.models.filter((m) => m.id !== id);
    databaseService
      .deleteProviderModel(target.providerId, target.modelKey)
      .catch(console.error);
    // If the deleted model was selected, fall back to first available.
    let nextSelected = state.selectedModel;
    const [activeProviderId, activeModelKey] = state.selectedModel.split(":");
    if (activeProviderId === target.providerId && activeModelKey === target.modelKey) {
      const fallback = nextModels
        .filter((m) => m.providerId === activeProviderId && m.enabled)
        .sort((a, b) => a.sortOrder - b.sortOrder)[0];
      if (fallback) {
        nextSelected = `${fallback.providerId}:${fallback.modelKey}`;
      } else {
        // No models left under this provider — fall back across all.
        const cross = nextModels
          .filter((m) => m.enabled)
          .sort((a, b) => a.sortOrder - b.sortOrder)[0];
        if (cross) nextSelected = `${cross.providerId}:${cross.modelKey}`;
      }
    }
    const synthesized = synthesizeLegacyProviderFields(
      state.providers,
      nextModels,
      nextSelected,
    );
    // A model deleted from a BUILT-IN provider must not resurrect: the
    // preset roster re-adds any missing key on launch, so record the id.
    // Custom providers' models are truly deleted — nothing re-seeds them.
    const owner = state.providers.find((p) => p.id === target.providerId);
    const removedPresetModelIds =
      owner && !owner.isCustom && !state.removedPresetModelIds.includes(id)
        ? [...state.removedPresetModelIds, id]
        : state.removedPresetModelIds;
    set({
      models: nextModels,
      selectedModel: nextSelected,
      providers: synthesized,
      removedPresetModelIds,
    });
    get().saveToDatabase();
  },

  replaceModelsForProvider: (providerId, init, renamedKeys) => {
    const reconciled: LLMModel[] = init.map((m, idx) => ({
      ...m,
      id: `${providerId}::${m.modelKey}`,
      providerId,
      sortOrder: idx,
    }));
    databaseService
      .replaceProviderModels(providerId, reconciled.map(modelToDb))
      .catch(console.error);
    set((state) => {
      const others = state.models.filter((m) => m.providerId !== providerId);
      const nextModels = [...others, ...reconciled];

      // Follow a rename before reconciling. Without this the old key is simply
      // gone, `resolveSelectedModel` bounces the selection to whichever model
      // happens to sort first — often another provider entirely — and the
      // person's chosen model changes because they changed a gateway region.
      let selectedModel = state.selectedModel;
      const separator = selectedModel.indexOf(":");
      if (renamedKeys && separator > 0 && selectedModel.slice(0, separator) === providerId) {
        const renamed = renamedKeys[selectedModel.slice(separator + 1)];
        if (renamed) selectedModel = `${providerId}:${renamed}`;
      }
      selectedModel = resolveSelectedModel(
        selectedModel,
        synthesizeLegacyProviderFields(state.providers, nextModels, selectedModel),
      );

      const synthesized = synthesizeLegacyProviderFields(
        state.providers,
        nextModels,
        selectedModel,
      );
      return { models: nextModels, providers: synthesized, selectedModel };
    });
    // The models themselves went to the database above; `selectedModel` lives
    // in app settings and has to be written too, or a restart reads the old
    // key back and reconciles it away.
    get().saveToDatabase();
  },

  getAvailableModels: () => {
    return buildAvailableModelOptions(get().providers);
  },

  getSelectedProvider: () => {
    const state = get();
    const [providerId] = state.selectedModel.split(":");
    return state.providers.find((p: LLMProvider) => p.id === providerId);
  },
  }) satisfies Partial<SettingsState>;
