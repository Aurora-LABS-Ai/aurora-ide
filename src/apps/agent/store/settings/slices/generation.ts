import { databaseService } from "@/kernel/services/database";
import type { SettingsGet, SettingsSet, SettingsState } from "../state";

/**
 * Generation defaults and tool approval: thinking, max tokens, temperature,
 * tool-call cap, per-tool approval, and the Fireworks account fields.
 */
export const createGenerationSlice = (set: SettingsSet, get: SettingsGet) =>
  ({
  setFireworksTabEnabled: (enabled: boolean) => {
    set({ fireworksTabEnabled: enabled });
    get().saveToDatabase();
  },

  setFireworksAccountId: (accountId: string) => {
    set({ fireworksAccountId: accountId });
    get().saveToDatabase();
  },

  setThinkingEnabled: (enabled: boolean) => {
    set({ thinkingEnabled: enabled });
    get().saveToDatabase();
  },

  setMaxTokens: (tokens: number) => {
    set({ maxTokens: tokens });
    get().saveToDatabase();
  },

  setTemperature: (temp: number) => {
    set({ temperature: temp });
    get().saveToDatabase();
  },

  setMaxToolCallsPerRequest: (max: number) => {
    set({ maxToolCallsPerRequest: max });
    get().saveToDatabase();
  },

  setToolApproval: (toolName: string, setting: 'auto' | 'always_ask' | 'deny') => {
    set((state) => ({
      toolApprovalSettings: {
        ...state.toolApprovalSettings,
        [toolName]: setting,
      },
    }));
    // Save individual tool setting
    databaseService.setToolApproval(toolName, setting).catch(console.error);
  },

  getToolApproval: (toolName: string) => {
    const state = get();
    return state.toolApprovalSettings[toolName] || 'always_ask';
  },
  }) satisfies Partial<SettingsState>;
