import { create } from "zustand";

import type { SettingsState } from "./state";
import { createAgentModesSlice } from "./slices/agent-modes";
import { createAgentPreferencesSlice } from "./slices/agent-preferences";
import { createGenerationSlice } from "./slices/generation";
import { initialSettingsState } from "./slices/initial-state";
import { createLlmConfigSlice } from "./slices/llm-config";
import { createModelsSlice } from "./slices/models";
import { agentSettingsSaveScheduler, createPersistenceSlice } from "./slices/persistence";
import { createProvidersSlice } from "./slices/providers";

/**
 * The Agent Window's settings: providers, models, execution mode and product
 * side, image providers, compaction, title maker, workspace access,
 * skills, speech, generation defaults and tool approval.
 *
 * The editor carries no agent, so none of this is in `kernel`. The editor's and
 * the app's own settings (fonts, wrap, autosave, theme, icon pack, onboarding)
 * are `kernel/store/useSettingsStore`. Both read the same `app_settings` table
 * and each writes only its own keys.
 */
export type { SettingsState as AgentSettingsState } from "./state";
export {
  CHAT_SHORTLIST_MAX,
  COMPACTION_SUMMARY_BUDGET_MAX,
  COMPACTION_SUMMARY_BUDGET_MIN,
  COMPACTION_THRESHOLD_MAX,
  COMPACTION_THRESHOLD_MIN,
  DEFAULT_COMPACTION_SUMMARY_BUDGET,
  DEFAULT_COMPACTION_THRESHOLD_PCT,
  DEFAULT_SPEECH_LIVE,
  GLOBAL_INSTRUCTION_NAME_MAX,
  GLOBAL_INSTRUCTION_PROFILE_LIMIT,
  LEGACY_GLOBAL_INSTRUCTION_PROFILE_ID,
  PROVIDER_DESCRIPTION_MAX,
  normalizeProviderDescription,
  normalizeSpeechLive,
  normalizeWorkspaceAccess,
  resolveGlobalInstructionState,
  selectActiveGlobalInstructions,
  type GlobalInstructionProfile,
  type SpeechLiveSettings,
  type SpeechMode,
  type TitleMakerMode,
  type WorkspaceAccess,
} from "./values";
export {
  reasoningIsOn,
  resolveProviderType,
  type LLMModel,
  type LLMProvider,
  type ResolvedLLMModel,
} from "./provider-model";

export const useAgentSettingsStore = create<SettingsState>()((set, get) => ({
  ...initialSettingsState,
  ...createPersistenceSlice(set, get),
  ...createProvidersSlice(set, get),
  ...createModelsSlice(set, get),
  ...createAgentModesSlice(set, get),
  ...createAgentPreferencesSlice(set, get),
  ...createGenerationSlice(set, get),
  ...createLlmConfigSlice(get),
}));

/**
 * Resolves once the saved agent settings have been read out of the database.
 *
 * Anything that has to know a **persisted** setting before it acts has to wait
 * for this, and `auroraSurface` is the one that bites. The agent window's chat
 * store asks which product the window is on the moment it mounts — and React
 * runs a child's effect before its parent's, so the mount that fills the rail
 * happens before the mount that starts this load. Asking early gets the
 * default, not the answer, and nothing asks again when the real one lands.
 *
 * Starts the load if nothing has started it, so a caller cannot wait on
 * something that was never going to happen. It always resolves: a load that
 * fails still marks the store initialized, on defaults, because a window that
 * waits forever is worse than one showing the wrong default.
 */
export const whenAgentSettingsReady = (): Promise<void> => {
  if (useAgentSettingsStore.getState().isInitialized) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const unsubscribe = useAgentSettingsStore.subscribe((state) => {
      if (!state.isInitialized) return;
      unsubscribe();
      resolve();
    });
    // No-op when a load is already running or finished.
    void useAgentSettingsStore.getState().initializeFromDatabase();
  });
};

/**
 * Force any debounced agent-settings write to flush immediately. Safe to call
 * when nothing is pending (no-op).
 */
export const flushAgentSettingsSave = (): void => {
  agentSettingsSaveScheduler.flush(() =>
    useAgentSettingsStore.getState().saveToDatabaseImmediate(),
  );
};

// Load from the database when the module loads (for Tauri).
if (typeof window !== 'undefined') {
  // Wait for Tauri to be ready
  setTimeout(() => {
    void useAgentSettingsStore.getState().initializeFromDatabase();
  }, 100);

  // Flush any pending debounced save on unload so the last change inside the
  // debounce window isn't lost when the window closes.
  window.addEventListener('beforeunload', () => {
    flushAgentSettingsSave();
  });
}
