/**
 * The Agents tab: what it says with nothing to show, which rows lead, and that
 * Stop stops without also opening the agent's tab.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AgentsPanel } from "@/apps/agent/components/panels/AgentsPanel";
import { clearSubagentMemory } from "@/apps/agent/components/panels/subagent-memory";
import type { SubagentSnapshot } from "@/apps/agent/services/subagents/commands";
import { useAgentChatStore } from "@/apps/agent/store/conversation/useAgentChatStore";
import { useAgentSubagentStore } from "@/apps/agent/store/subagents/useAgentSubagentStore";
import { useAgentWorkspaceStore } from "@/apps/agent/store/workspace/useAgentWorkspaceStore";

vi.mock("@/kernel/lib/ipc/runtime", () => ({
  auroraInvoke: vi.fn(() => Promise.reject(new Error("no runtime in tests"))),
  auroraListen: vi.fn(() => Promise.resolve(() => {})),
}));

vi.mock("@/apps/agent/shared/AgentIcon", () => ({
  AgentIcon: () => null,
}));

const PARENT = "parent-1";

const agent = (over: Partial<SubagentSnapshot>): SubagentSnapshot => ({
  agentId: "a1",
  parentThreadId: PARENT,
  agentType: "explore",
  description: "look around",
  status: "completed",
  background: false,
  startedAtMs: 1_000,
  endedAtMs: 2_000,
  usage: { inputTokens: 0, outputTokens: 0, toolCalls: 0, iterations: 0, durationMs: 91_000 },
  notified: true,
  runs: 1,
  ...over,
});

describe("AgentsPanel", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;
  const kill = vi.fn(() => Promise.resolve(true));
  const openAgentTab = vi.fn();

  const mount = async () => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
      .IS_REACT_ACT_ENVIRONMENT = true;
    await act(async () => {
      root = createRoot(container);
      root.render(<AgentsPanel />);
    });
  };

  const seed = (rows: SubagentSnapshot[]) =>
    useAgentSubagentStore.setState({
      byParent: { [PARENT]: rows },
      loaded: { [PARENT]: true },
      liveTurnByAgent: {},
      kill,
    });

  beforeEach(() => {
    clearSubagentMemory();
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
    container = document.createElement("div");
    document.body.appendChild(container);
    kill.mockClear();
    openAgentTab.mockClear();
    useAgentChatStore.setState({ currentThreadId: PARENT });
    useAgentWorkspaceStore.setState({ openAgentTab });
    seed([]);
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container.remove();
  });

  it("explains itself when the conversation has no agents", async () => {
    await mount();
    expect(container.textContent).toContain("No sub-agents in this conversation yet.");
    expect(container.textContent).toContain("each appears here under the name it gives it.");
    expect(container.querySelector(".agw-agents-row")).toBeNull();
  });

  it("asks for a conversation when none is open", async () => {
    useAgentChatStore.setState({ currentThreadId: null });
    await mount();
    expect(container.textContent).toContain("Open a conversation to see its agents.");
  });

  it("lists running agents before finished ones, under their own headings", async () => {
    seed([
      agent({ agentId: "done", name: "scout", startedAtMs: 9_000 }),
      agent({
        agentId: "live",
        name: "test-runner",
        status: "running",
        endedAtMs: undefined,
        startedAtMs: Date.now() - 134_000,
      }),
    ]);
    await mount();

    const names = [...container.querySelectorAll(".agw-agents-row-open")].map(
      (el) => el.textContent,
    );
    expect(names).toEqual(["test-runner", "scout"]);
    const labels = [...container.querySelectorAll(".agw-agents-group-label")].map(
      (el) => el.textContent,
    );
    expect(labels).toEqual(["Running", "Finished"]);
    expect(container.textContent).toContain("2 in this conversation");
    // Only the running row can be stopped.
    expect(container.querySelectorAll(".agw-agents-stop")).toHaveLength(1);
  });

  it("omits a group with nothing in it", async () => {
    seed([agent({ agentId: "done", name: "scout" })]);
    await mount();
    const labels = [...container.querySelectorAll(".agw-agents-group-label")].map(
      (el) => el.textContent,
    );
    expect(labels).toEqual(["Finished"]);
  });

  it("opens the agent's tab from its row's tab button", async () => {
    seed([agent({ agentId: "done", name: "scout" })]);
    await mount();
    await act(async () => {
      container.querySelector<HTMLButtonElement>(".agw-agents-tab")!.click();
    });
    expect(openAgentTab).toHaveBeenCalledWith(PARENT, "done", "scout");
  });

  it("the name opens a live preview under the row instead of a tab, several at once", async () => {
    seed([
      agent({ agentId: "a", name: "scout" }),
      agent({ agentId: "b", name: "builder", startedAtMs: 1_500 }),
    ]);
    await mount();
    const names = () => [...container.querySelectorAll<HTMLButtonElement>(".agw-agents-row-open")];
    await act(async () => {
      names()[0].click();
    });
    await act(async () => {
      names()[1].click();
    });
    expect(names().map((b) => b.getAttribute("aria-expanded"))).toEqual(["true", "true"]);
    expect(container.querySelectorAll(".agw-agents-preview")).toHaveLength(2);
    expect(openAgentTab).not.toHaveBeenCalled();
    await act(async () => {
      names()[0].click();
    });
    // The closing preview animates out (framer keeps it mounted until the
    // motion ends, which jsdom never runs); the toggle is what changed.
    expect(names().map((b) => b.getAttribute("aria-expanded"))).toEqual(["false", "true"]);
  });

  it("names the model and how full the agent's context is", async () => {
    seed([
      agent({
        agentId: "m",
        name: "scout",
        model: "deepseek:deepseek-v4-flash",
        contextTokens: 41_200,
      }),
    ]);
    await mount();
    expect(container.querySelector(".agw-agents-row-sub")?.textContent).toContain(
      "Deepseek V4 Flash",
    );
    expect(container.textContent).toContain("41.2K ctx");
    expect(container.querySelector(".agw-agents-avatar")?.textContent).toBe("S");
  });

  it("Stop stops the agent and does not open its tab", async () => {
    seed([
      agent({
        agentId: "live",
        name: "test-runner",
        status: "running",
        endedAtMs: undefined,
        startedAtMs: Date.now(),
      }),
    ]);
    await mount();
    await act(async () => {
      container.querySelector<HTMLButtonElement>(".agw-agents-stop")!.click();
    });
    expect(kill).toHaveBeenCalledWith("live");
    expect(openAgentTab).not.toHaveBeenCalled();
  });

  it("says how a stopped or failed agent ended", async () => {
    seed([
      agent({ agentId: "k", name: "docs-pass", status: "killed" }),
      agent({ agentId: "f", name: "migrations", status: "failed", error: "Provider returned 529" }),
    ]);
    await mount();
    // Not "by you": the parent agent can stop one too.
    expect(container.textContent).toContain("Stopped");
    expect(container.textContent).toContain("Provider returned 529");
  });
});
