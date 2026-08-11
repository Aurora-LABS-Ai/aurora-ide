import { beforeEach, describe, expect, it, vi } from "vitest";

describe("useAgentUiStore settings section persistence", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.resetModules();
  });

  it("restores the last section without reopening the settings surface", async () => {
    const first = (await import("@/apps/agent/store/ui/useAgentUiStore")).useAgentUiStore;
    expect(first.getState().settingsSection).toBe("preferences");

    first.getState().openSettings("appearance");
    expect(first.getState().view).toBe("settings");

    vi.resetModules();
    const restored = (await import("@/apps/agent/store/ui/useAgentUiStore")).useAgentUiStore;
    expect(restored.getState().settingsSection).toBe("appearance");
    expect(restored.getState().view).toBe("chat");
  });
});

describe("useAgentUiStore settings search hand-off", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.resetModules();
  });

  it("opens a section with a search already applied", async () => {
    // How the command center answers "chapters": land on the control, not on
    // the page that contains it.
    const store = (await import("@/apps/agent/store/ui/useAgentUiStore")).useAgentUiStore;
    store.getState().openSettings("preferences", "chapters");
    expect(store.getState().settingsQuery).toBe("chapters");
  });

  it("ends the search when a section is chosen from the nav", async () => {
    // Otherwise the nav looks dead mid-search: the click lands and the content
    // area still shows the old results.
    const store = (await import("@/apps/agent/store/ui/useAgentUiStore")).useAgentUiStore;
    store.getState().openSettings("preferences", "chapters");
    store.getState().setSection("appearance");
    expect(store.getState().settingsQuery).toBe("");
  });

  it("does not carry a search back into the next visit", async () => {
    const store = (await import("@/apps/agent/store/ui/useAgentUiStore")).useAgentUiStore;
    store.getState().openSettings("preferences", "chapters");
    store.getState().closeSettings();
    expect(store.getState().settingsQuery).toBe("");

    store.getState().openSettings();
    expect(store.getState().settingsQuery).toBe("");
  });
});
