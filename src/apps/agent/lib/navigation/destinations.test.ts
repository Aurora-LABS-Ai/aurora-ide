import { beforeEach, describe, expect, it, vi } from "vitest";

const workspace = vi.hoisted(() => ({
  toggleRail: vi.fn(),
  openTab: vi.fn(),
}));
vi.mock("@/apps/agent/store/workspace/useAgentWorkspaceStore", () => ({
  useAgentWorkspaceStore: { getState: () => workspace },
}));

import { DESTINATIONS, litRailCell, openDestination, openDockSurface } from "./destinations";
import { useAgentUiStore } from "@/apps/agent/store/ui/useAgentUiStore";

beforeEach(() => {
  vi.clearAllMocks();
  useAgentUiStore.setState({ view: "chat", settingsSection: "preferences", settingsQuery: "" });
});

describe("litRailCell — which rail cell the current view belongs to", () => {
  it("lights Home on the conversation and each page on its own cell", () => {
    expect(litRailCell("chat", "preferences")).toBe("home");
    expect(litRailCell("images", "preferences")).toBe("images");
    expect(litRailCell("library", "preferences")).toBe("library");
  });

  it("lights Plugins on its own page, and Settings on the MCP and Skills settings sections", () => {
    // Settings keeps its MCP and Skills entries; being in settings is being in
    // settings, whatever the section, and only the Plugins page lights Plugins.
    expect(litRailCell("plugins", "preferences")).toBe("plugins");
    expect(litRailCell("settings", "mcp")).toBe("settings");
    expect(litRailCell("settings", "skills")).toBe("settings");
  });

  it("lights Providers on its own page", () => {
    expect(litRailCell("providers", "preferences")).toBe("providers");
  });

  it("lights Account on the profile page and Settings everywhere else in settings", () => {
    expect(litRailCell("settings", "profile")).toBe("account");
    expect(litRailCell("settings", "appearance")).toBe("settings");
    expect(litRailCell("settings", "providers")).toBe("settings");
  });
});

describe("openDestination — the one implementation the rail and the palette share", () => {
  it("opens a page and ends any settings search on the way", () => {
    useAgentUiStore.getState().openSettings("providers", "image");
    openDestination("images");
    expect(useAgentUiStore.getState().view).toBe("images");
    expect(useAgentUiStore.getState().settingsQuery).toBe("");
    openDestination("library");
    expect(useAgentUiStore.getState().view).toBe("library");
  });

  it("opens the Plugins page", () => {
    openDestination("plugins");
    expect(useAgentUiStore.getState().view).toBe("plugins");
  });

  it("goes home from a page without touching the chat list", () => {
    useAgentUiStore.getState().openView("images");
    openDestination("home", { toggleChatList: true });
    expect(useAgentUiStore.getState().view).toBe("chat");
    expect(workspace.toggleRail).not.toHaveBeenCalled();
  });

  it("folds or unfolds the chat list only when Home is pressed while already home, from the rail", () => {
    openDestination("home", { toggleChatList: true });
    expect(workspace.toggleRail).toHaveBeenCalledTimes(1);
    expect(useAgentUiStore.getState().view).toBe("chat");
    // The palette's "Go home" passes nothing and must never flip the list.
    openDestination("home");
    expect(workspace.toggleRail).toHaveBeenCalledTimes(1);
  });

  it("lists every destination once with a glyph, a label and a hint", () => {
    const ids = DESTINATIONS.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const destination of DESTINATIONS) {
      expect(destination.label).toBeTruthy();
      expect(destination.icon).toBeTruthy();
      expect(destination.hint).toBeTruthy();
    }
  });
});

describe("openDockSurface — dock tabs only exist on Home", () => {
  it("walks home first when a page is showing, then opens the tab", () => {
    useAgentUiStore.getState().openView("images");
    openDockSurface("team");
    expect(useAgentUiStore.getState().view).toBe("chat");
    expect(workspace.openTab).toHaveBeenCalledWith("team");
  });

  it("opens the tab directly when already home", () => {
    openDockSurface("memory");
    expect(useAgentUiStore.getState().view).toBe("chat");
    expect(workspace.openTab).toHaveBeenCalledWith("memory");
  });
});
