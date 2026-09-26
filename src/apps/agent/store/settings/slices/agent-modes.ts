import {
  normalizeAgentExecutionMode,
  normalizeAuroraSurface,
  type AgentExecutionMode,
  type AuroraSurface,
} from "@/apps/agent/services/runtime/agent-execution-mode";
import type { SettingsGet, SettingsSet, SettingsState } from "../state";
import { CHAT_SHORTLIST_MAX } from "../values";

/** Execution mode, product side, image providers and the chat shortlist. */
export const createAgentModesSlice = (set: SettingsSet, get: SettingsGet) =>
  ({
  // ============================================
  // SETTINGS ACTIONS
  // ============================================

  setAutoApproveTools: (value: boolean) => {
    set({ autoApproveTools: value });
    get().saveToDatabase();
  },

  setAgentExecutionMode: (mode: AgentExecutionMode) => {
    const nextMode = normalizeAgentExecutionMode(mode);
    // `chat` is a SURFACE, not a Build mode. Routing it here would let the
    // composer's Agent↔Plan cycle move the window to another product, and
    // would overwrite the Build mode this field exists to remember.
    if (nextMode === "chat") {
      get().setAuroraSurface("chat");
      return;
    }
    set({ agentExecutionMode: nextMode });
    get().saveToDatabase();
  },

  setAuroraSurface: (surface: AuroraSurface) => {
    set({ auroraSurface: normalizeAuroraSurface(surface) });
    get().saveToDatabase();
  },

  setDeepResearchNext: (enabled: boolean) => {
    set({ deepResearchNext: enabled });
    get().saveToDatabase();
  },

  addImageProvider: (provider) => {
    const id = `img-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    set({ imageProviders: [...get().imageProviders, { ...provider, id, models: [] }] });
    get().saveToDatabase();
    return id;
  },

  updateImageProvider: (id, patch) => {
    set({
      imageProviders: get().imageProviders.map((provider) =>
        provider.id === id ? { ...provider, ...patch } : provider,
      ),
    });
    get().saveToDatabase();
  },

  deleteImageProvider: (id) => {
    // A shipped provider stays. Its card offers no delete control, so reaching
    // here means something other than the button asked — and the row would come
    // straight back on the next load anyway, which is worse than refusing.
    if (get().imageProviders.some((provider) => provider.id === id && provider.builtIn)) {
      return;
    }
    // The models go with it. They live inside the row, so there is nothing to
    // orphan — which is the reason they live inside the row.
    set({ imageProviders: get().imageProviders.filter((provider) => provider.id !== id) });
    get().saveToDatabase();
  },

  addImageModel: (providerId, model) => {
    // Keyed on provider AND model name, so the same model offered by two
    // providers is two rows rather than one that silently overwrites the other.
    const id = `${providerId}:${model.modelKey}`;
    set({
      imageProviders: get().imageProviders.map((provider) =>
        provider.id === providerId
          ? {
              ...provider,
              models: provider.models.some((existing) => existing.id === id)
                ? provider.models
                : [...provider.models, { ...model, id, providerId }],
            }
          : provider,
      ),
    });
    get().saveToDatabase();
    return id;
  },

  updateImageModel: (id, patch) => {
    set({
      imageProviders: get().imageProviders.map((provider) => ({
        ...provider,
        models: provider.models.map((model) =>
          model.id === id ? { ...model, ...patch } : model,
        ),
      })),
    });
    get().saveToDatabase();
  },

  deleteImageModel: (id) => {
    set({
      imageProviders: get().imageProviders.map((provider) => ({
        ...provider,
        models: provider.models.filter((model) => model.id !== id),
      })),
    });
    get().saveToDatabase();
  },

  toggleChatShortlistModel: (selection: string) => {
    const key = selection.trim();
    if (!key) return;
    const current = get().chatModelShortlist;
    if (current.includes(key)) {
      set({ chatModelShortlist: current.filter((entry) => entry !== key) });
    } else {
      // Silently at the cap rather than throwing: the control that calls this
      // is already disabled at ten and says why, so reaching here means two
      // rapid clicks, not a user who needs telling twice.
      if (current.length >= CHAT_SHORTLIST_MAX) return;
      set({ chatModelShortlist: [...current, key] });
    }
    get().saveToDatabase();
  },
  }) satisfies Partial<SettingsState>;
