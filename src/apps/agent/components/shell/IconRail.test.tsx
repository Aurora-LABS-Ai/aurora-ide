import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  settings: { auroraSurface: "build" as "build" | "chat", teamEnabled: true },
  workspace: {
    railOpen: true,
    dockOpen: false,
    tabs: [] as { id: string; kind: string }[],
    activeTabId: null as string | null,
    toggleRail: vi.fn(),
    openTab: vi.fn(),
  },
  team: { snapshot: null as unknown },
}));
vi.mock("@/apps/agent/store/settings/useAgentSettingsStore", () => ({
  useAgentSettingsStore: (select: (value: unknown) => unknown) => select(state.settings),
}));
vi.mock("@/apps/agent/store/workspace/useAgentWorkspaceStore", () => {
  const useAgentWorkspaceStore = (select: (value: unknown) => unknown) => select(state.workspace);
  useAgentWorkspaceStore.getState = () => state.workspace;
  return { useAgentWorkspaceStore };
});
vi.mock("@/apps/agent/store/team/useTeamStore", () => ({
  useTeamStore: (select: (value: unknown) => unknown) => select(state.team),
}));

import { IconRail } from "./IconRail";
import { useAgentUiStore } from "@/apps/agent/store/ui/useAgentUiStore";

let root: Root;
let host: HTMLDivElement;

const labels = () =>
  [...host.querySelectorAll<HTMLButtonElement>(".agw-iconrail-btn")].map((button) =>
    button.getAttribute("aria-label"),
  );
const cell = (label: string) =>
  host.querySelector<HTMLButtonElement>(`.agw-iconrail-btn[aria-label="${label}"]`)!;
const render = () => act(async () => root.render(<IconRail />));

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  state.settings = { auroraSurface: "build", teamEnabled: true };
  state.workspace.railOpen = true;
  state.workspace.dockOpen = false;
  state.workspace.tabs = [];
  state.workspace.activeTabId = null;
  useAgentUiStore.setState({ view: "chat", settingsSection: "preferences", settingsQuery: "" });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe("IconRail", () => {
  it("lists the destinations, Team on Build, then Settings and Account", async () => {
    await render();
    expect(labels()).toEqual([
      "Home",
      "Images",
      "Library",
      "Plugins",
      "Team",
      "Providers",
      "Settings",
      "Account",
    ]);
  });

  it("shows Memory instead of Team on Aurora Chat, and no Team while the feature is off", async () => {
    state.settings = { auroraSurface: "chat", teamEnabled: true };
    await render();
    expect(labels()).toContain("Memory");
    expect(labels()).not.toContain("Team");

    state.settings = { auroraSurface: "build", teamEnabled: false };
    await render();
    expect(labels()).not.toContain("Team");
    expect(labels()).not.toContain("Memory");
  });

  it("marks the current view and moves the mark when a destination is pressed", async () => {
    await render();
    expect(cell("Home").getAttribute("aria-current")).toBe("page");
    await act(async () => cell("Images").click());
    expect(useAgentUiStore.getState().view).toBe("images");
    expect(cell("Images").getAttribute("aria-current")).toBe("page");
    expect(cell("Home").getAttribute("aria-current")).toBeNull();
  });

  it("Home folds the chat list when already home, and returns home from a page", async () => {
    await render();
    await act(async () => cell("Home").click());
    expect(state.workspace.toggleRail).toHaveBeenCalledTimes(1);
    expect(useAgentUiStore.getState().view).toBe("chat");

    await act(async () => cell("Library").click());
    await act(async () => cell("Home").click());
    expect(useAgentUiStore.getState().view).toBe("chat");
    expect(state.workspace.toggleRail).toHaveBeenCalledTimes(1);
  });

  it("Team walks home first from a page, then opens the dock tab, and reads pressed while it shows", async () => {
    await render();
    await act(async () => cell("Images").click());
    await act(async () => cell("Team").click());
    expect(useAgentUiStore.getState().view).toBe("chat");
    expect(state.workspace.openTab).toHaveBeenCalledWith("team");

    state.workspace.dockOpen = true;
    state.workspace.tabs = [{ id: "team", kind: "team" }];
    state.workspace.activeTabId = "team";
    await render();
    expect(cell("Team").getAttribute("aria-pressed")).toBe("true");
  });

  it("lights Plugins on its page and Account on the profile page, never both with Settings", async () => {
    await render();
    await act(async () => cell("Plugins").click());
    expect(useAgentUiStore.getState().view).toBe("plugins");
    expect(cell("Plugins").getAttribute("aria-current")).toBe("page");
    expect(cell("Settings").getAttribute("aria-current")).toBeNull();

    await act(async () => cell("Account").click());
    expect(useAgentUiStore.getState().settingsSection).toBe("profile");
    expect(cell("Account").getAttribute("aria-current")).toBe("page");
    expect(cell("Settings").getAttribute("aria-current")).toBeNull();

    await act(async () => cell("Settings").click());
    expect(cell("Settings").getAttribute("aria-current")).toBe("page");

    await act(async () => cell("Providers").click());
    expect(useAgentUiStore.getState().view).toBe("providers");
    expect(cell("Providers").getAttribute("aria-current")).toBe("page");
    expect(cell("Settings").getAttribute("aria-current")).toBeNull();
  });
});
