import { beforeEach, describe, expect, it, vi } from "vitest";

describe("useAgentUiStore settings section persistence", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.resetModules();
  });

  it("restores the last section without reopening the settings surface", async () => {
    const first = (await import("./useAgentUiStore")).useAgentUiStore;
    expect(first.getState().settingsSection).toBe("preferences");

    first.getState().openSettings("appearance");
    expect(first.getState().view).toBe("settings");

    vi.resetModules();
    const restored = (await import("./useAgentUiStore")).useAgentUiStore;
    expect(restored.getState().settingsSection).toBe("appearance");
    expect(restored.getState().view).toBe("chat");
  });
});
