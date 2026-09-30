import { beforeEach, describe, expect, it } from "vitest";

import { useAgentWorkspaceStore } from "@/apps/agent/store/workspace/useAgentWorkspaceStore";

describe("Agent workspace right panel state", () => {
  beforeEach(() => {
    useAgentWorkspaceStore.setState({
      dockOpen: false,
      expanded: false,
      tabs: [],
      activeTabId: null,
    });
  });

  it("opens Canvas compactly and clears expansion when the panel closes", () => {
    const workspace = useAgentWorkspaceStore.getState();
    workspace.openTab("canvas");
    expect(useAgentWorkspaceStore.getState()).toMatchObject({
      dockOpen: true,
      expanded: false,
      activeTabId: "canvas",
    });

    useAgentWorkspaceStore.getState().setExpanded(true);
    useAgentWorkspaceStore.getState().closeDock();
    expect(useAgentWorkspaceStore.getState()).toMatchObject({
      dockOpen: false,
      expanded: false,
      activeTabId: "canvas",
    });
  });

  it("opens a team member as its own tab and refocuses (not duplicates) it", () => {
    useAgentWorkspaceStore.getState().openTab("team");
    useAgentWorkspaceStore.getState().openMemberTab("ui-owner-9fba12", "UI");
    expect(useAgentWorkspaceStore.getState()).toMatchObject({
      dockOpen: true,
      activeTabId: "member:ui-owner-9fba12",
    });
    expect(useAgentWorkspaceStore.getState().tabs).toHaveLength(2);

    // Re-picking the same member refocuses the existing tab.
    useAgentWorkspaceStore.getState().setActiveTab("team");
    useAgentWorkspaceStore.getState().openMemberTab("ui-owner-9fba12", "UI");
    const state = useAgentWorkspaceStore.getState();
    expect(state.tabs).toHaveLength(2);
    expect(state.activeTabId).toBe("member:ui-owner-9fba12");
    expect(state.tabs[1]).toMatchObject({ kind: "member", memberId: "ui-owner-9fba12" });
  });

  it("docks a conversation as its own tab, carrying the project it belongs to", () => {
    useAgentWorkspaceStore.getState().openChatTab("t-1", "Architecture tour", "E:/proj/a", "build");
    const state = useAgentWorkspaceStore.getState();
    expect(state).toMatchObject({ dockOpen: true, activeTabId: "chat:t-1" });
    expect(state.tabs[0]).toMatchObject({
      kind: "chat",
      threadId: "t-1",
      title: "Architecture tour",
      // Carried on the tab, not read from the window's scope: the chat keeps
      // running against its own project even after the window is re-scoped.
      threadProjectRoot: "E:/proj/a",
      threadSurface: "build",
    });
  });

  it("docks two conversations side by side without either replacing the other", () => {
    useAgentWorkspaceStore.getState().openChatTab("t-1", "On model A", "E:/proj/a", "build");
    useAgentWorkspaceStore.getState().openChatTab("t-2", "On model B", "E:/proj/a", "build");
    const state = useAgentWorkspaceStore.getState();
    expect(state.tabs).toHaveLength(2);
    expect(state.activeTabId).toBe("chat:t-2");
  });

  it("refocuses and re-titles an already-docked conversation instead of duplicating it", () => {
    useAgentWorkspaceStore.getState().openChatTab("t-1", "New Chat", "E:/proj/a", "build");
    useAgentWorkspaceStore.getState().openTab("files");
    // Re-opening after the chat was auto-titled should adopt the new label.
    useAgentWorkspaceStore.getState().openChatTab("t-1", "Quantum key handling", "E:/proj/a", "build");
    const state = useAgentWorkspaceStore.getState();
    expect(state.tabs).toHaveLength(2);
    expect(state.activeTabId).toBe("chat:t-1");
    expect(state.tabs[0]).toMatchObject({ title: "Quantum key handling" });
  });
});

describe("New tab page", () => {
  const ws = () => useAgentWorkspaceStore.getState();
  const newTabId = () => {
    ws().openNewTab();
    return ws().activeTabId as string;
  };

  beforeEach(() => {
    useAgentWorkspaceStore.setState({ dockOpen: false, tabs: [], activeTabId: null });
  });

  it("an empty panel opens on a New tab, never on nothing", () => {
    ws().toggleDock();
    expect(ws().dockOpen).toBe(true);
    expect(ws().tabs.map((t) => t.kind)).toEqual(["newtab"]);
    expect(ws().activeTabId).toBe(ws().tabs[0].id);
  });

  it("the never-empty rule opens ONE tab even when it runs twice", () => {
    // React runs effects twice in development; this is that, reduced.
    ws().ensureVisibleTab(false);
    ws().ensureVisibleTab(false);
    expect(ws().tabs.map((t) => t.kind)).toEqual(["newtab"]);
  });

  it("the never-empty rule counts only the tabs the current surface shows", () => {
    ws().openTab("files");
    ws().ensureVisibleTab(false);
    expect(ws().tabs.map((t) => t.kind)).toEqual(["files"]);
    // Files is not on Aurora Chat, so that surface still gets a New tab.
    ws().ensureVisibleTab(true);
    expect(ws().tabs.map((t) => t.kind)).toEqual(["files", "newtab"]);
  });

  it("opens as its own tab every time, and shows the dock", () => {
    const a = newTabId();
    const b = newTabId();
    expect(a).not.toBe(b);
    expect(ws().tabs.map((t) => t.kind)).toEqual(["newtab", "newtab"]);
    expect(ws()).toMatchObject({ dockOpen: true, activeTabId: b });
  });

  it("becomes the picked panel in the same place in the strip", () => {
    ws().openTab("canvas");
    const id = newTabId();
    ws().openTab("terminal");
    ws().resolveNewTab(id, { panel: "files" });
    expect(ws().tabs.map((t) => t.id)).toEqual(["canvas", "files", "terminal"]);
    expect(ws().activeTabId).toBe("files");
  });

  it("closes and focuses the panel when that panel is already open", () => {
    ws().openTab("files");
    const id = newTabId();
    ws().resolveNewTab(id, { panel: "files" });
    expect(ws().tabs.map((t) => t.id)).toEqual(["files"]);
    expect(ws().activeTabId).toBe("files");
  });

  it("the first address becomes the agent's browser tab, so the agent sees that page", () => {
    const id = newTabId();
    ws().resolveNewTab(id, { url: "http://localhost:5173" });
    expect(ws().tabs).toEqual([
      {
        id: "browser",
        kind: "browser",
        title: "localhost:5173",
        url: "http://localhost:5173",
        pendingUrl: "http://localhost:5173",
      },
    ]);
  });

  it("with the agent's tab open, an address gets a page of its own", () => {
    ws().openTab("browser");
    const id = newTabId();
    ws().resolveNewTab(id, { url: "https://docs.stripe.com/webhooks" });
    const tab = ws().tabs[1];
    expect(tab.kind).toBe("browser");
    expect(tab.browserLabel).toMatch(/^browser-tab-/);
    expect(tab.id).toBe(`browser:${tab.browserLabel}`);
    expect(tab).toMatchObject({ title: "docs.stripe.com", pendingUrl: "https://docs.stripe.com/webhooks" });
    expect(ws().activeTabId).toBe(tab.id);
  });

  it("does nothing for a tab that is not a New tab", () => {
    ws().openTab("files");
    ws().resolveNewTab("files", { url: "https://kick.com" });
    expect(ws().tabs.map((t) => t.id)).toEqual(["files"]);
  });

  it("keeps a tab's device and zoom on the tab, and removes them cleanly", () => {
    ws().openTab("browser");
    ws().updateBrowserTab("browser", { device: "iphone", zoom: 1.25, toolsOpen: true });
    expect(ws().tabs[0]).toMatchObject({ device: "iphone", zoom: 1.25, toolsOpen: true });
    ws().updateBrowserTab("browser", { device: undefined, zoom: undefined });
    // Back to Default leaves no stale key on the saved tab.
    expect("device" in ws().tabs[0]).toBe(false);
    expect("zoom" in ws().tabs[0]).toBe(false);
    expect(ws().tabs[0].toolsOpen).toBe(true);
  });

  it("does not rewrite the tab list when nothing changed", () => {
    ws().openTab("browser");
    ws().updateBrowserTab("browser", { device: "android" });
    const before = ws().tabs;
    ws().updateBrowserTab("browser", { device: "android" });
    expect(ws().tabs).toBe(before);
  });

  it("records a page's address and title, and clears the pending load", () => {
    const id = newTabId();
    ws().resolveNewTab(id, { url: "https://kick.com" });
    ws().updateBrowserTab("browser", { pendingUrl: undefined });
    ws().updateBrowserTab("browser", { url: "https://kick.com/following", title: "Kick" });
    expect(ws().tabs[0]).toEqual({
      id: "browser",
      kind: "browser",
      title: "Kick",
      url: "https://kick.com/following",
    });
  });
});
