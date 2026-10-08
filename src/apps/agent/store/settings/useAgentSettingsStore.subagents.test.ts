import { beforeEach, describe, expect, it, vi } from "vitest";

const saveAppSettingsEntries = vi.fn<(entries: Record<string, unknown>) => Promise<void>>(
  async () => {},
);

vi.mock("@/kernel/services/database", () => ({
  databaseService: {
    saveAppSettingsEntries: (entries: Record<string, unknown>) =>
      saveAppSettingsEntries(entries),
    saveAllProviders: vi.fn(async () => {}),
    saveAllToolSettings: vi.fn(async () => {}),
  },
}));

import { useAgentSettingsStore } from "./useAgentSettingsStore";

describe("subagent settings", () => {
  beforeEach(() => {
    saveAppSettingsEntries.mockClear();
    useAgentSettingsStore.setState({ subagentsEnabled: false, subagentModel: null });
  });

  it("starts off, with no pinned model", () => {
    const state = useAgentSettingsStore.getState();
    expect(state.subagentsEnabled).toBe(false);
    expect(state.subagentModel).toBeNull();
  });

  it("setters update the store", () => {
    useAgentSettingsStore.getState().setSubagentsEnabled(true);
    useAgentSettingsStore.getState().setSubagentModel("openai:gpt-5.2");
    const state = useAgentSettingsStore.getState();
    expect(state.subagentsEnabled).toBe(true);
    expect(state.subagentModel).toBe("openai:gpt-5.2");
  });

  it("a blank pin means 'same as the conversation'", () => {
    useAgentSettingsStore.getState().setSubagentModel("openai:gpt-5.2");
    useAgentSettingsStore.getState().setSubagentModel("  ");
    expect(useAgentSettingsStore.getState().subagentModel).toBeNull();
  });

  it("both keys are part of the saved entries", async () => {
    useAgentSettingsStore.setState({
      subagentsEnabled: true,
      subagentModel: "openai:gpt-5.2",
    });
    await useAgentSettingsStore.getState().saveToDatabaseImmediate();
    expect(saveAppSettingsEntries).toHaveBeenCalledTimes(1);
    const entries = saveAppSettingsEntries.mock.calls[0][0];
    expect(entries.subagentsEnabled).toBe(true);
    expect(entries.subagentModel).toBe("openai:gpt-5.2");
  });
});
