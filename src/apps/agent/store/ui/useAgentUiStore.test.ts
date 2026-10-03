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

  it("opens Settings from Providers even when the saved section moved out", async () => {
    // Saved before Providers left Settings. Reopening "where I was" used to
    // redirect straight back to the Providers page, so the Settings rail cell
    // did nothing while Providers was open.
    localStorage.setItem(
      "aurora-agent-window-ui",
      JSON.stringify({ state: { settingsSection: "providers" }, version: 0 }),
    );
    const store = (await import("@/apps/agent/store/ui/useAgentUiStore")).useAgentUiStore;
    store.getState().openView("providers");
    store.getState().openSettings();
    expect(store.getState().view).toBe("settings");
    expect(store.getState().settingsSection).toBe("preferences");
  });
});

describe("useAgentUiStore sections that moved to the Plugins page", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.resetModules();
  });

  it("opens the Plugins page on the matching pane instead of settings", async () => {
    // Every door into MCP or Skills — nav, search result, palette, an old
    // persisted section — goes through openSettings, so one redirect covers all.
    const store = (await import("@/apps/agent/store/ui/useAgentUiStore")).useAgentUiStore;
    store.getState().openSettings("skills", "equip");
    expect(store.getState().view).toBe("plugins");
    expect(store.getState().pluginsTab).toBe("skills");
    expect(store.getState().settingsQuery).toBe("");

    store.getState().openSettings("mcp");
    expect(store.getState().pluginsTab).toBe("mcp");
    // The settings section itself is left alone: coming back to Settings lands
    // where the user last was in Settings, not on a page that is no longer there.
    expect(store.getState().settingsSection).toBe("preferences");
  });

  it("opens Providers as its own page, so its list is the only sidebar", async () => {
    const store = (await import("@/apps/agent/store/ui/useAgentUiStore")).useAgentUiStore;
    store.getState().openSettings("providers", "api key");
    expect(store.getState().view).toBe("providers");
    expect(store.getState().settingsQuery).toBe("");
  });

  it("names the pages and panes that left settings, and nothing else", async () => {
    const { sectionHome, sectionPluginsTab } = await import(
      "@/apps/agent/store/ui/useAgentUiStore"
    );
    expect(sectionHome("mcp")).toBe("plugins");
    expect(sectionHome("skills")).toBe("plugins");
    expect(sectionHome("providers")).toBe("providers");
    expect(sectionHome("appearance")).toBeNull();
    expect(sectionPluginsTab("mcp")).toBe("mcp");
    expect(sectionPluginsTab("skills")).toBe("skills");
    expect(sectionPluginsTab("providers")).toBeNull();
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
