import { v4 as uuidv4 } from "uuid";

import { MAX_ENABLED_SKILLS } from "@/apps/agent/services/skills/skills";
import type { SettingsGet, SettingsSet, SettingsState } from "../state";
import {
  GLOBAL_INSTRUCTION_PROFILE_LIMIT,
  clampCompactionBudget,
  clampCompactionThreshold,
  clampProfileName,
  clampTeamSize,
  countEnabledSkillToggles,
  normalizeSpeechLive,
  normalizeSpeechRuntimePath,
  type SpeechLiveSettings,
  type SpeechMode,
  type WorkspaceAccess,
} from "../values";

/**
 * Agent preferences: team, title maker, workspace access, transcript and tool
 * toggles, global instructions, compaction, skills and speech.
 */
export const createAgentPreferencesSlice = (set: SettingsSet, get: SettingsGet) =>
  ({
  setTeamEnabled: (enabled: boolean) => {
    // Disabling the feature must not leave the input box stuck in Team mode —
    // fall back to Agent so the team tools/prompt are no longer in play.
    const patch: Partial<SettingsState> = { teamEnabled: enabled };
    if (!enabled && get().agentExecutionMode === "team") {
      patch.agentExecutionMode = "agent";
    }
    set(patch);
    get().saveToDatabase();
  },

  setMaxTeamSize: (size: number) => {
    set({ maxTeamSize: clampTeamSize(size) });
    get().saveToDatabase();
  },

  setTeamLeadModel: (selection: string) => {
    set({ teamLeadModel: selection });
    get().saveToDatabase();
  },

  setTitleMaker: (value) => {
    const patch: Partial<SettingsState> = {};
    if (value.mode !== undefined) {
      patch.titleMakerMode = value.mode;
      // Keep the legacy boolean in lockstep for anything still reading it.
      patch.titleMakerEnabled = value.mode === 'cloud';
    }
    if (value.enabled !== undefined) patch.titleMakerEnabled = value.enabled;
    if (value.baseUrl !== undefined) patch.titleMakerBaseUrl = value.baseUrl;
    if (value.apiKey !== undefined) patch.titleMakerApiKey = value.apiKey;
    if (value.model !== undefined) patch.titleMakerModel = value.model;
    if (value.localModel !== undefined) patch.titleMakerLocalModel = value.localModel;
    if (value.localChatFormat !== undefined)
      patch.titleMakerLocalChatFormat = value.localChatFormat;
    set(patch);
    get().saveToDatabase();
  },

  setWorkspaceAccess: (value: WorkspaceAccess) => {
    // The legacy boolean is derived, never set by hand: the two can then only
    // disagree if someone edits the database, and a reader that predates the
    // mode still sees the nearest true answer.
    set({ workspaceAccess: value, allowOutsideWorkspace: value !== 'workspace' });
    get().saveToDatabase();
  },

  setNotifyOnTurnComplete: (value: boolean) => {
    set({ notifyOnTurnComplete: value });
    get().saveToDatabase();
  },

  setShowActivityInTitle: (value: boolean) => {
    set({ showActivityInTitle: value });
    get().saveToDatabase();
  },

  setTranscriptChapters: (value: boolean) => {
    set({ transcriptChapters: value });
    get().saveToDatabase();
  },

  setBrowserTools: (value: boolean) => {
    set({ browserTools: value });
    get().saveToDatabase();
  },

  setDeferTools: (value: boolean) => {
    set({ deferTools: value });
    get().saveToDatabase();
  },

  setMcpBridgeEnabled: (value: boolean) => {
    set({ mcpBridgeEnabled: value });
    get().saveToDatabase();
  },

  setTeamMemberModel: (selection: string) => {
    set({ teamMemberModel: selection });
    get().saveToDatabase();
  },

  addGlobalInstructionProfile: () => {
    const profiles = get().globalInstructionProfiles;
    if (profiles.length >= GLOBAL_INSTRUCTION_PROFILE_LIMIT) return null;
    const id = uuidv4();
    set({
      globalInstructionProfiles: [
        ...profiles,
        { id, name: `Persona ${profiles.length + 1}`, text: '' },
      ],
    });
    get().saveToDatabase();
    return id;
  },

  renameGlobalInstructionProfile: (id: string, name: string) => {
    const trimmed = clampProfileName(name);
    if (!trimmed) return; // an empty commit keeps the old name
    set({
      globalInstructionProfiles: get().globalInstructionProfiles.map((p) =>
        p.id === id ? { ...p, name: trimmed } : p,
      ),
    });
    get().saveToDatabase();
  },

  setGlobalInstructionProfileText: (id: string, text: string) => {
    set({
      globalInstructionProfiles: get().globalInstructionProfiles.map((p) =>
        p.id === id ? { ...p, text } : p,
      ),
    });
    get().saveToDatabase();
  },

  setActiveGlobalInstructionProfile: (id: string | null) => {
    // Activation is exclusive by construction — one id field, not per-set
    // flags — so switching a set on switches every other set off.
    const next =
      id && get().globalInstructionProfiles.some((p) => p.id === id) ? id : '';
    set({ activeGlobalInstructionProfileId: next });
    get().saveToDatabase();
  },

  removeGlobalInstructionProfile: (id: string) => {
    const profiles = get().globalInstructionProfiles;
    if (profiles.length <= 1) return; // the editor always keeps one set
    const remaining = profiles.filter((p) => p.id !== id);
    if (remaining.length === profiles.length) return;
    set({
      globalInstructionProfiles: remaining,
      // Deleting the live set deactivates rather than silently promoting
      // another persona into every future chat.
      ...(get().activeGlobalInstructionProfileId === id
        ? { activeGlobalInstructionProfileId: '' }
        : null),
    });
    get().saveToDatabase();
  },

  setCompactionThresholdPct: (value: number) => {
    set({ compactionThresholdPct: clampCompactionThreshold(value) });
    get().saveToDatabase();
  },

  setCompactionModel: (selection: string) => {
    set({ compactionModel: selection });
    get().saveToDatabase();
  },

  setCompactionSummaryBudget: (value: number) => {
    set({ compactionSummaryBudget: clampCompactionBudget(value) });
    get().saveToDatabase();
  },

  setAutoAcceptChanges: (value: boolean) => {
    set({ autoAcceptChanges: value });
    get().saveToDatabase();
  },

  setSyntaxValidationEnabled: (value: boolean) => {
    set({ syntaxValidationEnabled: value });
    get().saveToDatabase();
  },

  setProjectLayoutEnabled: (value: boolean) => {
    set({ projectLayoutEnabled: value });
    get().saveToDatabase();
  },

  setSkillsEnabled: (enabled: boolean) => {
    set({ skillsEnabled: enabled });
    get().saveToDatabase();
  },

  setSkillEnabled: (scopeKey: string, storageKey: string, enabled: boolean) => {
    const state = get();
    const scopeToggles = state.skillToggles[scopeKey] ?? {};
    const isCurrentlyEnabled = scopeToggles[storageKey] === true;

    // No-op: nothing to change.
    if (isCurrentlyEnabled === enabled) {
      return true;
    }

    // Enforce hard cap when turning ON, scoped to THIS workspace. Turning OFF
    // is always allowed. Counting per scope is what keeps one project's
    // selection from blocking another's.
    if (enabled) {
      const enabledCount = countEnabledSkillToggles(scopeToggles);
      if (enabledCount >= MAX_ENABLED_SKILLS) {
        console.warn(
          `[Skills] Cannot enable more than ${MAX_ENABLED_SKILLS} skills in this workspace. ` +
            `Disable an existing skill before enabling \`${storageKey}\`.`
        );
        return false;
      }
    }

    set((current) => {
      const currentScope = current.skillToggles[scopeKey] ?? {};
      const nextScope = { ...currentScope, [storageKey]: enabled };
      return {
        skillToggles: {
          ...current.skillToggles,
          [scopeKey]: nextScope,
        },
      };
    });
    get().saveToDatabase();
    return true;
  },

  setSpeechEnabled: (enabled: boolean) => {
    set({ speechEnabled: enabled });
    get().saveToDatabase();
  },

  setSpeechEngine: (engine: string) => {
    set({ speechEngine: engine || "crispasr-gguf" });
    get().saveToDatabase();
  },

  setSpeechRuntimePath: (path: string) => {
    set({ speechRuntimePath: normalizeSpeechRuntimePath(path) });
    get().saveToDatabase();
  },

  setSpeechModelPath: (path: string) => {
    set({ speechModelPath: path });
    get().saveToDatabase();
  },

  setSpeechBackend: (backend: string) => {
    set({ speechBackend: backend || "auto" });
    get().saveToDatabase();
  },

  setSpeechDevicePreference: (preference: 'auto' | 'cpu' | 'gpu') => {
    set({ speechDevicePreference: preference });
    get().saveToDatabase();
  },

  setSpeechThreads: (threads: number) => {
    set({ speechThreads: Math.min(32, Math.max(1, Math.round(threads) || 4)) });
    get().saveToDatabase();
  },

  setSpeechLanguage: (language: string) => {
    set({ speechLanguage: language || "auto" });
    get().saveToDatabase();
  },

  setSpeechMode: (mode: SpeechMode) => {
    set({ speechMode: mode === "live" ? "live" : "batch" });
    get().saveToDatabase();
  },

  setSpeechLive: (patch: Partial<SpeechLiveSettings>) => {
    set({ speechLive: normalizeSpeechLive({ ...get().speechLive, ...patch }) });
    get().saveToDatabase();
  },

  removeSkillToggle: (storageKey: string) => {
    const state = get();
    let changed = false;
    const nextToggles: Record<string, Record<string, boolean>> = {};

    for (const [scopeKey, scopeToggles] of Object.entries(state.skillToggles ?? {})) {
      if (!(storageKey in scopeToggles)) {
        nextToggles[scopeKey] = scopeToggles;
        continue;
      }
      const rest = { ...scopeToggles };
      delete rest[storageKey];
      nextToggles[scopeKey] = rest;
      changed = true;
    }

    if (!changed) return;
    set({ skillToggles: nextToggles });
    get().saveToDatabase();
  },
  }) satisfies Partial<SettingsState>;
