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
    useAgentWorkspaceStore.getState().openChatTab("t-1", "Architecture tour", "E:/proj/a");
    const state = useAgentWorkspaceStore.getState();
    expect(state).toMatchObject({ dockOpen: true, activeTabId: "chat:t-1" });
    expect(state.tabs[0]).toMatchObject({
      kind: "chat",
      threadId: "t-1",
      title: "Architecture tour",
      // Carried on the tab, not read from the window's scope: the chat keeps
      // running against its own project even after the window is re-scoped.
      threadProjectRoot: "E:/proj/a",
    });
  });

  it("docks two conversations side by side without either replacing the other", () => {
    useAgentWorkspaceStore.getState().openChatTab("t-1", "On model A", "E:/proj/a");
    useAgentWorkspaceStore.getState().openChatTab("t-2", "On model B", "E:/proj/a");
    const state = useAgentWorkspaceStore.getState();
    expect(state.tabs).toHaveLength(2);
    expect(state.activeTabId).toBe("chat:t-2");
  });

  it("refocuses and re-titles an already-docked conversation instead of duplicating it", () => {
    useAgentWorkspaceStore.getState().openChatTab("t-1", "New Chat", "E:/proj/a");
    useAgentWorkspaceStore.getState().openTab("files");
    // Re-opening after the chat was auto-titled should adopt the new label.
    useAgentWorkspaceStore.getState().openChatTab("t-1", "Quantum key handling", "E:/proj/a");
    const state = useAgentWorkspaceStore.getState();
    expect(state.tabs).toHaveLength(2);
    expect(state.activeTabId).toBe("chat:t-1");
    expect(state.tabs[0]).toMatchObject({ title: "Quantum key handling" });
  });
});
