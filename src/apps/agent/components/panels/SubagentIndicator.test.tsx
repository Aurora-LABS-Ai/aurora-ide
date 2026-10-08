import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useAgentChatStore } from "@/apps/agent/store/conversation/useAgentChatStore";
import { useAgentSubagentStore } from "@/apps/agent/store/subagents/useAgentSubagentStore";
import { useAgentWorkspaceStore } from "@/apps/agent/store/workspace/useAgentWorkspaceStore";
import type { SubagentSnapshot } from "@/apps/agent/services/subagents/commands";
import { SubagentIndicator } from "@/apps/agent/components/panels/SubagentIndicator";

const THREAD = "thread-1";

const agent = (
  agentId: string,
  status: SubagentSnapshot["status"],
  name?: string,
): SubagentSnapshot => ({
  agentId,
  parentThreadId: THREAD,
  agentType: "explore",
  name,
  description: "Find things",
  status,
  background: true,
  startedAtMs: Date.now() - 5_000,
  endedAtMs: status === "running" ? undefined : Date.now(),
  usage: { inputTokens: 0, outputTokens: 0, toolCalls: 0, iterations: 0, durationMs: 3_000 },
  notified: false,
  runs: 1,
});

describe("SubagentIndicator", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  const render = () => {
    act(() => {
      root = createRoot(container);
      root.render(<SubagentIndicator />);
    });
  };
  const trigger = () => container.querySelector<HTMLButtonElement>(".agw-agentind");

  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    container.className = "agw-root";
    document.body.appendChild(container);
    useAgentChatStore.setState({ currentThreadId: THREAD });
    useAgentSubagentStore.setState({ byParent: {}, loaded: {}, liveTurnByAgent: {} });
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container.remove();
  });

  it("stays out of the header when the conversation has no agents", () => {
    render();
    expect(trigger()).toBeNull();
  });

  it("shows for an old conversation's finished agents, with the count", () => {
    // Reopened days later, nothing running: the agents are still there, so
    // the indicator is too.
    useAgentSubagentStore.setState({
      byParent: { [THREAD]: [agent("a", "completed", "scout"), agent("b", "failed")] },
    });
    render();
    expect(trigger()?.textContent).toBe("2");
    expect(trigger()?.getAttribute("data-state")).toBe("idle");
    expect(trigger()?.getAttribute("aria-label")).toContain("2 agents in this conversation");
  });

  it("counts the working agents while any runs", () => {
    useAgentSubagentStore.setState({
      byParent: { [THREAD]: [agent("a", "running", "scout"), agent("b", "completed")] },
    });
    render();
    expect(trigger()?.textContent).toBe("1/2");
    expect(trigger()?.getAttribute("data-state")).toBe("running");
    expect(trigger()?.getAttribute("aria-label")).toContain("1 of 2 agents working");
  });

  it("lists the agents on hover and a row opens that agent's tab", () => {
    useAgentSubagentStore.setState({
      byParent: { [THREAD]: [agent("a", "running", "scout"), agent("b", "completed", "tests")] },
    });
    const openAgentTab = vi.fn();
    useAgentWorkspaceStore.setState({ openAgentTab } as never);
    render();
    const wrap = container.querySelector(".agw-taskind-wrap")!;
    act(() => {
      wrap.dispatchEvent(
        new MouseEvent("mouseover", { bubbles: true, relatedTarget: document.body }),
      );
    });
    const rows = document.querySelectorAll<HTMLButtonElement>(".agw-agentpop-row");
    expect(rows.length).toBe(2);
    // Running first, by name, with its state.
    expect(rows[0].textContent).toContain("scout");
    expect(rows[0].textContent).toContain("Working");
    expect(rows[1].textContent).toContain("tests");
    expect(rows[1].textContent).toContain("Finished");
    act(() => rows[1].click());
    expect(openAgentTab).toHaveBeenCalledWith(THREAD, "b", "tests");
    // Opening a tab closes the card; the dock is where the agent now is. The
    // element itself lingers for its exit animation, so the trigger's state is
    // the truthful check.
    expect(trigger()?.getAttribute("aria-expanded")).toBe("false");
  });
});
