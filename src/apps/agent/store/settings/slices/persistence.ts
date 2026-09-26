import {
  normalizeAgentExecutionMode,
  normalizeAuroraSurface,
  type AgentExecutionMode,
  type AuroraSurface,
} from "@/apps/agent/services/runtime/agent-execution-mode";
import { databaseService } from "@/kernel/services/database";
import { createSettingsSaveScheduler } from "@/kernel/store/settings/save-scheduler";
import {
  normalizeImageProviders,
  withSeededImageProviders,
} from "@/apps/agent/services/providers/image-providers";
import { normalizeProviderCategories } from "@/apps/agent/services/providers/provider-categories";
import { providerCatalogService } from "@/apps/agent/services/providers/provider-catalog";
import { AGENT_ROUTER_PRESET, isAgentRouterWireChoice } from "@/apps/agent/services/providers/presets/agentrouter";
import { isArkWireChoice } from "@/apps/agent/services/providers/presets/ark";
import { ATLAS_CLOUD_PRESET } from "@/apps/agent/services/providers/presets/atlascloud";
import { CLAUDE_CODE_PRESET } from "@/apps/agent/services/providers/presets/claude-code";
import { CODEX_PRESET } from "@/apps/agent/services/providers/presets/codex";
import { COMMANDCODE_PRESET } from "@/apps/agent/services/providers/presets/commandcode";
import { CURSOR_PRESET } from "@/apps/agent/services/providers/presets/cursor";
import { OPENCODE_PRESET } from "@/apps/agent/services/providers/presets/opencode";
import type { AppSettings as DbAppSettings } from "@/kernel/types/database";
import {
  DEFAULT_SELECTED_MODEL,
  createDefaultProviders,
  dbToModel,
  dbToProvider,
  modelToDb,
  modelsFromPreset,
  presetToProvider,
  providerToDb,
  resolveProviderType,
  resolveSelectedModel,
  syncThinkingForSelectedModel,
  synthesizeLegacyProviderFields,
  type LLMModel,
} from "../provider-model";
import type { SettingsGet, SettingsSet, SettingsState } from "../state";
import {
  DEFAULT_COMPACTION_SUMMARY_BUDGET,
  DEFAULT_COMPACTION_THRESHOLD_PCT,
  DEFAULT_TOOL_APPROVAL_SETTINGS,
  TEAM_SIZE_RECOMMENDED,
  clampCompactionBudget,
  clampCompactionThreshold,
  clampTeamSize,
  normalizeChatShortlist,
  normalizeSpeechLive,
  normalizeSpeechRuntimePath,
  normalizeWorkspaceAccess,
  resolveGlobalInstructionState,
  selectActiveGlobalInstructions,
  type TitleMakerMode,
} from "../values";

/** This store's own debounce; the editor's settings store has another. */
export const agentSettingsSaveScheduler = createSettingsSaveScheduler();

/** Loading the agent's settings from the database and saving them back. */
export const createPersistenceSlice = (set: SettingsSet, get: SettingsGet) =>
  ({
  // ============================================
  // DATABASE OPERATIONS
  // ============================================

  initializeFromDatabase: async () => {
    const state = get();
    if (state.isLoading || state.isInitialized) return;

    set({ isLoading: true });

    try {
      const loadedPresets = await providerCatalogService.getPresets();
      const presetProviders = Array.isArray(loadedPresets) ? loadedPresets : [];

      // Atlas Cloud ships as a frontend preset (not the Rust catalog) so its
      // coding-plan usage card + seeded models land without a backend rebuild.
      // Injected here so BOTH the fresh-install and merge paths pick it up.
      if (!presetProviders.some((p) => p.id === ATLAS_CLOUD_PRESET.id)) {
        presetProviders.push(ATLAS_CLOUD_PRESET);
      }

      // Codex (ChatGPT subscription) ships the same way: a frontend preset
      // with an OAuth-backed card instead of an API key. The Rust side owns
      // auth + routing (`api::codex`); this just seeds the provider row.
      if (!presetProviders.some((p) => p.id === CODEX_PRESET.id)) {
        presetProviders.push(CODEX_PRESET);
      }

      // Claude Code (claude.ai subscription): the same shape as Codex — an
      // OAuth-backed card instead of an API key, auth + routing owned by
      // Rust (`api::claude_code`), Aurora's own credential file and never
      // the user's `~/.claude`.
      if (!presetProviders.some((p) => p.id === CLAUDE_CODE_PRESET.id)) {
        presetProviders.push(CLAUDE_CODE_PRESET);
      }

      // Cursor (subscription) — same shape again: no API key, the Rust side
      // reads the Cursor app's own session (`api::cursor`) and owns the wire.
      // Its model list is NOT seeded here: the account decides what exists and
      // the catalogue is pulled on connect, so a guess would put models in the
      // picker that the first refresh contradicts.
      if (!presetProviders.some((p) => p.id === CURSOR_PRESET.id)) {
        presetProviders.push(CURSOR_PRESET);
      }

      // OpenCode Go (subscription). An ordinary OpenAI-compatible endpoint
      // with an ordinary key, so it needs no adapter of its own — only the
      // right base URL. `/zen/v1`, the credit-billed API, is deliberately NOT
      // offered: it gives a subscriber nothing a custom provider row would
      // not, and bills separately from the plan they already pay for.
      // Its models are pulled from the account, not seeded, for the same
      // reason as Cursor's.
      if (!presetProviders.some((p) => p.id === OPENCODE_PRESET.id)) {
        presetProviders.push(OPENCODE_PRESET);
      }

      // Command Code (subscription). Frontend preset, but unlike OpenCode Go
      // it is backed by a real Rust adapter: the body nests its model
      // parameters under `params` beside a mandatory `config` block, and the
      // response is newline-delimited JSON rather than SSE, so no existing
      // wire could carry it. Models are pulled from the account rather than
      // seeded, for the same reason as Cursor's.
      if (!presetProviders.some((p) => p.id === COMMANDCODE_PRESET.id)) {
        presetProviders.push(COMMANDCODE_PRESET);
      }

      // AgentRouter (OpenAI-compatible proxy). Frontend preset — seeds the
      // provider row + its required client-fingerprint headers so it works
      // the moment the user pastes a key (or a key pool).
      if (!presetProviders.some((p) => p.id === AGENT_ROUTER_PRESET.id)) {
        presetProviders.push(AGENT_ROUTER_PRESET);
      }

      // Drop any preset the user REMOVED from the Providers page. Presets are
      // re-injected every launch, so a plain delete can't stick — removal is
      // recorded in `removedProviderIds` (app_settings) and filtered here,
      // BEFORE the merge/seed below, so a removed built-in never re-seeds.
      // Fetched up-front (the full app-settings load happens later); failure
      // defaults to "nothing removed".
      let removedProviderIds: string[] = [];
      let removedPresetModelIds: string[] = [];
      try {
        const earlySettings = await databaseService.getAppSettings();
        if (Array.isArray(earlySettings?.removedProviderIds)) {
          removedProviderIds = earlySettings.removedProviderIds;
        }
        if (Array.isArray(earlySettings?.removedPresetModelIds)) {
          removedPresetModelIds = earlySettings.removedPresetModelIds;
        }
      } catch {
        // ignore — treat as nothing removed
      }
      if (removedProviderIds.length > 0) {
        const removedSet = new Set(removedProviderIds);
        for (let i = presetProviders.length - 1; i >= 0; i--) {
          if (removedSet.has(presetProviders[i].id)) presetProviders.splice(i, 1);
        }
      }

      // Check if we have providers in the database
      const hasProviders = await databaseService.hasProviders();

      if (hasProviders) {
        // Load providers from database
        const dbProviders = await databaseService.getAllProviders();
        const providers = dbProviders.map(dbToProvider);

        // Merge with preset providers (in case new presets were added)
        const mergedProviders = presetProviders.map((preset) => {
          const presetProvider = presetToProvider(preset);
          const dbProvider = providers.find(p => p.id === preset.id);
          if (dbProvider) {
            // Keep the stored API key and settings, but update with any new preset fields
            return {
              ...presetProvider,
              ...dbProvider,
              isCustom: false,
              // AgentRouter's wire (Chat vs Messages) is the user's choice —
              // restoring the preset's `openai` here would silently undo it
              // on every launch.
              // Ark is the third: its preset type IS a variant
              // (`ark-messages`), so `resolveProviderType` cannot see `ark` or
              // `ark-responses` as siblings of it and would reset the picker
              // on every launch.
              providerType:
                isAgentRouterWireChoice(dbProvider) || isArkWireChoice(dbProvider)
                  ? dbProvider.providerType
                  : resolveProviderType(
                      presetProvider.providerType,
                      dbProvider.providerType,
                    ),
              // The catalogue owns a built-in's display name — it cannot be
              // edited in the UI, so a stored one is only ever a stale copy,
              // and letting it win would freeze a name we later corrected.
              name: presetProvider.name,
              supportsToolStream: presetProvider.supportsToolStream ?? dbProvider.supportsToolStream,
              nickname: dbProvider.nickname || presetProvider.nickname,
              // The description is the user's alone — a preset never carries one.
              description: dbProvider.description,
            };
          }
          return presetProvider;
        });

        // Add any custom providers (ensure isCustom is set)
        const customProviders = providers
          .filter(p => p.isCustom)
          .map(p => ({ ...p, isCustom: true as const }));
        mergedProviders.push(...customProviders);

        // Persist preset providers that are NEW to this database before
        // seeding their model rows below — `provider_models` has a
        // FOREIGN KEY to `llm_providers`, so the parent row must land
        // first (otherwise the model upsert fails with "FOREIGN KEY
        // constraint failed" and only persists on a later save).
        for (let i = 0; i < mergedProviders.length; i++) {
          const p = mergedProviders[i];
          if (p.isCustom) continue;
          if (providers.some((db) => db.id === p.id)) continue;
          try {
            await databaseService.saveProvider(providerToDb(p, i));
          } catch (error) {
            console.error("Failed to persist new preset provider:", error);
          }
        }

        // ── Models slice (v15+) ────────────────────────────────────
        // Load model rows for each provider, then merge with preset
        // models (so newly-added presets get their model roster
        // populated even if the user already has a v14-migrated DB).
        const dbModels = await databaseService.listProviderModels();
        const modelsFromDb = dbModels.map(dbToModel);
        const mergedModels: LLMModel[] = [];
        const seenIds = new Set<string>();
        for (const m of modelsFromDb) {
          if (!seenIds.has(m.id)) {
            mergedModels.push(m);
            seenIds.add(m.id);
          }
        }
        // For each preset, ensure every model_key appears at least once.
        // Preset-supplied capabilities only seed; user edits stick — and so
        // do DELETES: a missing row the user removed on purpose is recorded
        // in `removedPresetModelIds` and must not resurrect here. Without
        // that record, "delete gpt-5.5" worked for a session and the model
        // was back every morning.
        const removedModelSet = new Set(removedPresetModelIds);
        for (const preset of presetProviders) {
          const presetModels = modelsFromPreset(preset);
          for (const pm of presetModels) {
            if (!seenIds.has(pm.id) && !removedModelSet.has(pm.id)) {
              mergedModels.push(pm);
              seenIds.add(pm.id);
              // Persist the seeded preset model row.
              databaseService.upsertProviderModel(modelToDb(pm)).catch(console.error);
            }
          }
        }
        // Custom providers may not have any model rows yet (e.g. a
        // user upgraded from v14 with `model = 'foo'` and nothing in
        // customModels[]). Seed one default row per custom provider
        // that currently has zero models.
        for (const provider of mergedProviders) {
          if (!provider.isCustom) continue;
          const hasAny = mergedModels.some((m) => m.providerId === provider.id);
          if (!hasAny && provider.model.trim()) {
            const seeded: LLMModel = {
              id: `${provider.id}::${provider.model}`,
              providerId: provider.id,
              modelKey: provider.model,
              supportsVision: false,
              supportsThinking: provider.supportsThinking ?? false,
              supportsToolStream: provider.supportsToolStream ?? false,
              enabled: true,
              sortOrder: 0,
            };
            mergedModels.push(seeded);
            databaseService.upsertProviderModel(modelToDb(seeded)).catch(console.error);
          }
        }

        // selectedModel hasn't been loaded from app_settings yet —
        // synthesize against DEFAULT_SELECTED_MODEL for now; we'll
        // re-synthesize once selectedModel resolves below.
        const providersWithLegacy = synthesizeLegacyProviderFields(
          mergedProviders,
          mergedModels,
          DEFAULT_SELECTED_MODEL,
        );
        set({ providers: providersWithLegacy, models: mergedModels });
      } else {
        // First time: save default providers AND seed the models
        // slice from preset.customModels[].
        const defaultProviders = createDefaultProviders(presetProviders);
        const dbProviders = defaultProviders.map((p, i) => providerToDb(p, i));
        await databaseService.saveAllProviders(dbProviders);

        const seededModels: LLMModel[] = presetProviders.flatMap(modelsFromPreset);
        for (const m of seededModels) {
          await databaseService.upsertProviderModel(modelToDb(m));
        }
        const providersWithLegacy = synthesizeLegacyProviderFields(
          defaultProviders,
          seededModels,
          DEFAULT_SELECTED_MODEL,
        );
        set({ providers: providersWithLegacy, models: seededModels });
      }

      // Load app settings
      const appSettings = await databaseService.getAppSettings();
      if (appSettings) {
        const selectedModel = resolveSelectedModel(
          appSettings.selectedModel || DEFAULT_SELECTED_MODEL,
          get().providers,
        );
        // A row written before the surface existed can hold `"chat"` here.
        // Read it as the surface it now is, and leave the Build mode at its
        // default rather than persisting a value this field can no longer mean.
        const storedMode = normalizeAgentExecutionMode(appSettings.agentExecutionMode);
        const persistedExecutionMode: AgentExecutionMode =
          storedMode === "chat" ? "agent" : storedMode;
        const persistedSurface: AuroraSurface =
          storedMode === "chat"
            ? "chat"
            : normalizeAuroraSurface(appSettings.auroraSurface);
        const persistedThinkingEnabled = appSettings.thinkingEnabled ?? true;
        const syncedThinkingEnabled = syncThinkingForSelectedModel(
          selectedModel,
          get().providers,
          get().models,
          persistedThinkingEnabled
        );
        const globalInstructionState = resolveGlobalInstructionState(
          appSettings.globalInstructionProfiles,
          appSettings.activeGlobalInstructionProfileId ?? '',
          appSettings.globalInstructions ?? '',
        );

        set({
          selectedModel,
          autoApproveTools: appSettings.autoApproveTools ?? false,
          agentExecutionMode: persistedExecutionMode,
          auroraSurface: persistedSurface,
          deepResearchNext: appSettings.deepResearchNext ?? false,
          chatModelShortlist: normalizeChatShortlist(appSettings.chatModelShortlist),
          // Defensive on load, not on save: this is a JSON blob, so a
          // hand-edited database or an older build has to degrade to a working
          // rail rather than throw here and take the whole settings load down.
          providerCategories: normalizeProviderCategories(appSettings.providerCategories),
          ...(() => {
            // Seeded rows are offered once and then remembered, so a deleted
            // one stays deleted. Applied here, on the load, because it is the
            // only place that both knows what was stored and can write back.
            const seeding = withSeededImageProviders(
              normalizeImageProviders(appSettings.imageProviders),
              Array.isArray(appSettings.seededImageProviderIds)
                ? appSettings.seededImageProviderIds
                : [],
            );
            return {
              imageProviders: seeding.providers,
              seededImageProviderIds: seeding.seededIds,
            };
          })(),
          teamEnabled: appSettings.teamEnabled ?? false,
          maxTeamSize: clampTeamSize(appSettings.maxTeamSize ?? TEAM_SIZE_RECOMMENDED),
          teamLeadModel: appSettings.teamLeadModel ?? '',
          teamMemberModel: appSettings.teamMemberModel ?? '',
          globalInstructionProfiles: globalInstructionState.profiles,
          activeGlobalInstructionProfileId: globalInstructionState.activeId,
          compactionThresholdPct: clampCompactionThreshold(
            appSettings.compactionThresholdPct ?? DEFAULT_COMPACTION_THRESHOLD_PCT,
          ),
          compactionSummaryBudget: clampCompactionBudget(
            appSettings.compactionSummaryBudget ?? DEFAULT_COMPACTION_SUMMARY_BUDGET,
          ),
          compactionModel: appSettings.compactionModel ?? '',
          titleMakerEnabled: appSettings.titleMakerEnabled ?? false,
          // Legacy rows have no mode — a previously enabled title maker was
          // always the cloud endpoint.
          titleMakerMode: (['off', 'local', 'cloud'].includes(appSettings.titleMakerMode ?? '')
            ? appSettings.titleMakerMode
            : appSettings.titleMakerEnabled
              ? 'cloud'
              : 'off') as TitleMakerMode,
          titleMakerBaseUrl: appSettings.titleMakerBaseUrl ?? '',
          titleMakerApiKey: appSettings.titleMakerApiKey ?? '',
          titleMakerModel: appSettings.titleMakerModel ?? '',
          titleMakerLocalModel: appSettings.titleMakerLocalModel ?? '',
          // Empty on every row written before the setting existed; "auto" is
          // what those installs were already doing.
          titleMakerLocalChatFormat: appSettings.titleMakerLocalChatFormat || 'auto',
          // An install that upgrades without opening Settings has only the old
          // boolean on disk. `true` becomes `read` — never `full`, which
          // nobody has consented to.
          workspaceAccess: normalizeWorkspaceAccess(
            appSettings.workspaceAccess,
            appSettings.allowOutsideWorkspace,
          ),
          allowOutsideWorkspace: appSettings.allowOutsideWorkspace ?? false,
          notifyOnTurnComplete: appSettings.notifyOnTurnComplete ?? true,
          showActivityInTitle: appSettings.showActivityInTitle ?? true,
          transcriptChapters: appSettings.transcriptChapters ?? false,
          browserTools: appSettings.browserTools ?? true,
          deferTools: appSettings.deferTools ?? false,
          mcpBridgeEnabled: appSettings.mcpBridgeEnabled ?? false,
          autoAcceptChanges: appSettings.autoAcceptChanges ?? false,
          syntaxValidationEnabled: appSettings.syntaxValidationEnabled ?? true,
          projectLayoutEnabled: appSettings.projectLayoutEnabled ?? true,
          skillsEnabled: appSettings.skillsEnabled ?? true,
          skillToggles: appSettings.skillToggles ?? {},
          speechEnabled: appSettings.speechEnabled ?? false,
          speechEngine: appSettings.speechEngine ?? "crispasr-gguf",
          speechRuntimePath: normalizeSpeechRuntimePath(appSettings.speechRuntimePath),
          speechModelPath: appSettings.speechModelPath ?? "",
          speechBackend: appSettings.speechBackend ?? "auto",
          speechDevicePreference: appSettings.speechDevicePreference ?? "auto",
          speechThreads: appSettings.speechThreads ?? 4,
          speechLanguage: appSettings.speechLanguage ?? "auto",
          speechMode: appSettings.speechMode === "live" ? "live" : "batch",
          speechLive: normalizeSpeechLive(appSettings.speechLive),
          fireworksTabEnabled: appSettings.fireworksTabEnabled ?? false,
          fireworksAccountId: appSettings.fireworksAccountId ?? "",
          removedProviderIds: appSettings.removedProviderIds ?? [],
          removedPresetModelIds: appSettings.removedPresetModelIds ?? [],
          thinkingEnabled: syncedThinkingEnabled,
          maxTokens: appSettings.maxTokens ?? 8192,
          temperature: appSettings.temperature ?? 1.0,
          maxToolCallsPerRequest: appSettings.maxToolCallsPerRequest ?? 25,
        });

        // Re-sync the legacy capability fields against the now-known
        // selected model so legacy reads see the active model's
        // vision/thinking flags rather than the OR-aggregate seeded
        // above.
        const reSynced = synthesizeLegacyProviderFields(
          get().providers,
          get().models,
          selectedModel,
        );
        set({ providers: reSynced });
      }


      // Load tool settings
      const loadedToolSettings = await databaseService.getAllToolSettings();
      const toolSettings = Array.isArray(loadedToolSettings) ? loadedToolSettings : [];
      if (toolSettings.length > 0) {
        const settings = { ...DEFAULT_TOOL_APPROVAL_SETTINGS };
        for (const ts of toolSettings) {
          settings[ts.toolName] = ts.approvalMode;
        }
        set({ toolApprovalSettings: settings });
      }

      set({ isInitialized: true, isLoading: false });
    } catch (error) {
      console.error('Failed to initialize agent settings from database:', error);
      set({ isInitialized: true, isLoading: false });
    }
  },

  saveToDatabase: () =>
    agentSettingsSaveScheduler.schedule(() => get().saveToDatabaseImmediate()),

  saveToDatabaseImmediate: async () => {
    const state = get();

    try {
      // Only the agent's own keys. The editor's (fonts, wrap, autosave, icon
      // pack, theme) are written by `kernel/store/useSettingsStore`; writing
      // them here too would put this window's stale copy back over them.
      const appSettings: Partial<DbAppSettings> = {
        selectedModel: state.selectedModel,
        agentExecutionMode: state.agentExecutionMode,
        auroraSurface: state.auroraSurface,
        deepResearchNext: state.deepResearchNext,
        chatModelShortlist: state.chatModelShortlist,
        providerCategories: state.providerCategories,
        imageProviders: state.imageProviders,
        seededImageProviderIds: state.seededImageProviderIds,
        teamEnabled: state.teamEnabled,
        maxTeamSize: state.maxTeamSize,
        teamLeadModel: state.teamLeadModel,
        teamMemberModel: state.teamMemberModel,
        // Legacy mirror: older builds read the single string, so it carries
        // the active set's text (empty when none is active).
        globalInstructions: selectActiveGlobalInstructions(state),
        globalInstructionProfiles: state.globalInstructionProfiles,
        activeGlobalInstructionProfileId: state.activeGlobalInstructionProfileId,
        compactionThresholdPct: state.compactionThresholdPct,
        compactionSummaryBudget: state.compactionSummaryBudget,
        compactionModel: state.compactionModel,
        titleMakerEnabled: state.titleMakerEnabled,
        titleMakerMode: state.titleMakerMode,
        titleMakerBaseUrl: state.titleMakerBaseUrl,
        titleMakerApiKey: state.titleMakerApiKey,
        titleMakerModel: state.titleMakerModel,
        titleMakerLocalModel: state.titleMakerLocalModel,
        titleMakerLocalChatFormat: state.titleMakerLocalChatFormat,
        workspaceAccess: state.workspaceAccess,
        allowOutsideWorkspace: state.allowOutsideWorkspace,
        notifyOnTurnComplete: state.notifyOnTurnComplete,
        showActivityInTitle: state.showActivityInTitle,
        transcriptChapters: state.transcriptChapters,
        browserTools: state.browserTools,
        deferTools: state.deferTools,
        mcpBridgeEnabled: state.mcpBridgeEnabled,
        autoApproveTools: state.autoApproveTools,
        autoAcceptChanges: state.autoAcceptChanges,
        syntaxValidationEnabled: state.syntaxValidationEnabled,
        projectLayoutEnabled: state.projectLayoutEnabled,
        skillsEnabled: state.skillsEnabled,
        skillToggles: state.skillToggles,
        speechEnabled: state.speechEnabled,
        speechEngine: state.speechEngine,
        speechRuntimePath: state.speechRuntimePath,
        speechModelPath: state.speechModelPath,
        speechBackend: state.speechBackend,
        speechDevicePreference: state.speechDevicePreference,
        speechThreads: state.speechThreads,
        speechLanguage: state.speechLanguage,
        speechMode: state.speechMode,
        speechLive: state.speechLive,
        fireworksTabEnabled: state.fireworksTabEnabled,
        fireworksAccountId: state.fireworksAccountId,
        removedProviderIds: state.removedProviderIds,
        removedPresetModelIds: state.removedPresetModelIds,
        thinkingEnabled: state.thinkingEnabled,
        maxTokens: state.maxTokens,
        temperature: state.temperature,
        maxToolCallsPerRequest: state.maxToolCallsPerRequest,
      };

      await databaseService.saveAppSettingsEntries(appSettings);

      // Save providers
      const dbProviders = state.providers.map((p, i) => providerToDb(p, i));
      await databaseService.saveAllProviders(dbProviders);

      // Save tool settings
      const toolSettingsArray: [string, string][] = Object.entries(state.toolApprovalSettings);
      await databaseService.saveAllToolSettings(toolSettingsArray);
    } catch (error) {
      console.error('Failed to save agent settings to database:', error);
    }
  },
  }) satisfies Partial<SettingsState>;
