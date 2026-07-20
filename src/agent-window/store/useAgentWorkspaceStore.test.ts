import { beforeEach, describe, expect, it } from "vitest";

import { useAgentWorkspaceStore } from "./useAgentWorkspaceStore";

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
});
