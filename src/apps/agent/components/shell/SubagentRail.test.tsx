import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SubagentSnapshot } from "@/apps/agent/services/subagents/commands";

const state = vi.hoisted(() => ({ currentThreadId: "chat" as string | null }));
vi.mock("@/apps/agent/store/conversation/useAgentChatStore", () => ({
  useAgentChatStore: (select: (value: unknown) => unknown) => select(state),
}));
vi.mock("@/apps/agent/store/workspace/useAgentWorkspaceStore", () => ({
  useAgentWorkspaceStore: (select: (value: unknown) => unknown) =>
    select({ openAgentTab: vi.fn() }),
}));
vi.mock("@/apps/agent/store/ui/useAgentToastStore", () => ({ toast: vi.fn() }));
vi.mock("@/apps/agent/hooks/subagents/useSubagentTranscript", () => ({
  prefetchSubagentTranscript: vi.fn(),
}));
vi.mock("@/apps/agent/services/subagents/commands", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getSubagentRail: vi.fn(async () => ({ pinned: [], expanded: [] })),
  setSubagentRail: vi.fn(async (_id: string, s: unknown) => s),
}));
// The card has its own pieces (the live tail); here only that it is out.
vi.mock("./SubagentRailCard", () => ({
  SubagentRailCard: ({ agent, pinned }: { agent: SubagentSnapshot; pinned: boolean }) => (
    <div className="agw-railcard" data-agent={agent.agentId} data-pinned={pinned ? "" : undefined} />
  ),
}));

import { SubagentRail } from "./SubagentRail";
import { useAgentSubagentStore } from "@/apps/agent/store/subagents/useAgentSubagentStore";
import { useSubagentRailStore } from "@/apps/agent/store/subagents/useSubagentRailStore";

const agent = (agentId: string, status: SubagentSnapshot["status"], startedAtMs = 1) =>
  ({
    agentId,
    parentThreadId: "chat",
    agentType: "general",
    name: agentId,
    description: "",
    status,
    background: true,
    startedAtMs,
    usage: { inputTokens: 0, outputTokens: 0, toolCalls: 0, iterations: 0, durationMs: 0 },
    notified: false,
    runs: 1,
  }) satisfies SubagentSnapshot;

let root: Root;
let host: HTMLDivElement;
const render = () =>
  act(async () =>
    root.render(
      <div className="agw-root">
        <nav className="agw-iconrail">
          <SubagentRail />
        </nav>
      </div>,
    ),
  );
const cell = (id: string) => host.querySelector<HTMLButtonElement>(`[data-subagent="${id}"]`)!;
const cards = () => [...document.querySelectorAll<HTMLElement>(".agw-railcard")];

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.currentThreadId = "chat";
  useAgentSubagentStore.setState({ byParent: {} });
  useSubagentRailStore.setState({ open: null, pinnedByParent: {}, expandedByParent: {}, hydrated: {} });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe("SubagentRail", () => {
  it("renders nothing for a conversation without agents", async () => {
    await render();
    expect(host.querySelector(".agw-iconrail-agents")).toBeNull();
  });

  it("gives each agent a cell: moving matrix while it runs, still after, initial under it", async () => {
    useAgentSubagentStore.setState({
      byParent: { chat: [agent("shell", "running"), agent("overview", "completed")] },
    });
    await render();
    expect(cell("shell").querySelector(".agw-railmx")?.hasAttribute("data-running")).toBe(true);
    expect(cell("overview").querySelector(".agw-railmx")?.hasAttribute("data-running")).toBe(false);
    expect(cell("overview").textContent).toBe("O");
    expect(cell("shell").getAttribute("aria-label")).toBe("shell, running");
  });

  it("opens a card on click and pins it on double-click", async () => {
    useAgentSubagentStore.setState({ byParent: { chat: [agent("shell", "running")] } });
    await render();
    await act(async () => cell("shell").dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 })));
    expect(cards().map((c) => c.dataset.agent)).toEqual(["shell"]);
    expect(cards()[0].hasAttribute("data-pinned")).toBe(false);

    await act(async () => cell("shell").dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
    expect(useSubagentRailStore.getState().pinnedByParent.chat).toEqual(["shell"]);
    expect(cards()[0].hasAttribute("data-pinned")).toBe(true);
    expect(cell("shell").hasAttribute("data-pinned")).toBe(true);
  });

  it("past five agents shows four cells and a +N cell, running ones kept out", async () => {
    useAgentSubagentStore.setState({
      byParent: {
        chat: [
          agent("a", "completed", 1),
          agent("b", "completed", 2),
          agent("c", "running", 3),
          agent("d", "completed", 4),
          agent("e", "completed", 5),
          agent("f", "completed", 6),
        ],
      },
    });
    await render();
    const ids = [...host.querySelectorAll<HTMLElement>("[data-subagent]")].map((el) => el.dataset.subagent);
    expect(ids).toEqual(["c", "d", "e", "f"]);
    expect(host.querySelector("[data-subagent-more]")?.textContent).toBe("+2");
  });

  it("brings back pins saved with the conversation", async () => {
    const { getSubagentRail } = await import("@/apps/agent/services/subagents/commands");
    vi.mocked(getSubagentRail).mockResolvedValueOnce({ pinned: ["overview"], expanded: [] });
    useAgentSubagentStore.setState({ byParent: { chat: [agent("overview", "completed")] } });
    await render();
    await act(async () => {});
    expect(cards().map((c) => c.dataset.agent)).toEqual(["overview"]);
    expect(cards()[0].hasAttribute("data-pinned")).toBe(true);
  });
});
