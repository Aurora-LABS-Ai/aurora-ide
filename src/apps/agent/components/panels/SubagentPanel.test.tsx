/**
 * An agent's own tab: a message from the parent is a labelled card, never the
 * user's bubble, and the footer says who is in control.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SubagentPanel } from "@/apps/agent/components/panels/SubagentPanel";
import { clearSubagentMemory } from "@/apps/agent/components/panels/subagent-memory";
import type { SubagentSnapshot } from "@/apps/agent/services/subagents/commands";
import type { DbThread } from "@/apps/agent/services/threads/thread-service";
import { useAgentChatStore } from "@/apps/agent/store/conversation/useAgentChatStore";
import { useAgentSubagentStore } from "@/apps/agent/store/subagents/useAgentSubagentStore";
import { auroraInvoke } from "@/kernel/lib/ipc/runtime";

vi.mock("@/kernel/lib/ipc/runtime", () => ({
  auroraInvoke: vi.fn(),
  auroraListen: vi.fn(() => Promise.resolve(() => {})),
}));

vi.mock("@/apps/agent/shared/AgentIcon", () => ({
  AgentIcon: () => null,
}));

vi.mock("framer-motion", () => ({
  AnimatePresence: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  motion: new Proxy({}, { get: () => "div" }),
}));

const PARENT = "parent-1";
const AGENT = "agent-1";

const thread: DbThread = {
  id: AGENT,
  title: "test-runner",
  created_at: "2026-10-08T10:00:00Z",
  updated_at: "2026-10-08T10:02:00Z",
  messages: [
    {
      id: "m1",
      role: "user",
      content: "Run the test suite for src/auth and report which suites fail.",
      timestamp: "2026-10-08T10:00:00Z",
    },
    {
      id: "m2",
      role: "assistant",
      content: "Reading the test layout first.",
      timestamp: "2026-10-08T10:00:05Z",
    },
  ],
};

const snapshot = (over: Partial<SubagentSnapshot>): SubagentSnapshot => ({
  agentId: AGENT,
  parentThreadId: PARENT,
  agentType: "general-purpose",
  name: "test-runner",
  description: "run tests",
  status: "running",
  background: true,
  startedAtMs: Date.now() - 134_000,
  usage: { inputTokens: 0, outputTokens: 0, toolCalls: 0, iterations: 0, durationMs: 0 },
  notified: false,
  runs: 1,
  ...over,
});

describe("SubagentPanel", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  const mount = async () => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
      .IS_REACT_ACT_ENVIRONMENT = true;
    await act(async () => {
      root = createRoot(container);
      root.render(<SubagentPanel parentThreadId={PARENT} agentId={AGENT} title="test-runner" />);
    });
    await act(async () => {
      await Promise.resolve();
    });
  };

  const seed = (row: SubagentSnapshot) =>
    useAgentSubagentStore.setState({
      byParent: { [PARENT]: [row] },
      loaded: { [PARENT]: true },
      liveTurnByAgent: {},
    });

  beforeEach(() => {
    // jsdom has no ResizeObserver; the scroll hook binds one as soon as the
    // transcript renders (which a remembered transcript makes immediate).
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
    // Each test is a first open, not a return to a tab shown earlier.
    clearSubagentMemory();
    container = document.createElement("div");
    document.body.appendChild(container);
    vi.mocked(auroraInvoke).mockReset();
    vi.mocked(auroraInvoke).mockResolvedValue(thread);
    useAgentChatStore.setState({ currentThreadId: PARENT, currentThread: null });
    seed(snapshot({}));
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container.remove();
  });

  it("draws the parent's message as a labelled card, never the user's bubble", async () => {
    await mount();

    expect(container.textContent).toContain("from the parent");
    expect(container.textContent).toContain("Run the test suite for src/auth");
    expect(container.querySelector(".agw-agent-card[data-from='parent']")).not.toBeNull();
    expect(container.querySelector(".agw-bubble-user")).toBeNull();
    expect(container.textContent).toContain("Reading the test layout first.");
  });

  it("names the parent conversation on the card when it is the open one", async () => {
    useAgentChatStore.setState({
      currentThreadId: PARENT,
      currentThread: { ...thread, id: PARENT, title: "Fix the login bug" },
    });
    await mount();
    expect(container.querySelector(".agw-agent-name")?.textContent).toBe("Fix the login bug");
  });

  it("reads 'Controlled by the parent' with a Stop button while running", async () => {
    await mount();
    const foot = container.querySelector(".agw-subagent-foot");
    expect(foot?.textContent).toContain("Controlled by the parent");
    expect(foot?.textContent).toContain("general-purpose");
    expect(foot?.querySelector(".agw-agents-stop")).not.toBeNull();
    expect(container.querySelector(".agw-subagent-foot-note")).toBeNull();
  });

  it("reads the outcome and offers no Stop once finished", async () => {
    seed(
      snapshot({
        status: "completed",
        usage: {
          inputTokens: 6000,
          outputTokens: 2400,
          toolCalls: 12,
          iterations: 4,
          durationMs: 91_000,
        },
      }),
    );
    await mount();
    const foot = container.querySelector(".agw-subagent-foot");
    expect(foot?.textContent).toContain("Finished · general-purpose · 12 tool calls · 8.4K tokens · 1m 31s");
    expect(foot?.querySelector(".agw-agents-stop")).toBeNull();
    expect(foot?.textContent).toContain("The parent can send it more work");
  });

  it("shows the parent's message the moment it is sent, until the transcript holds it", async () => {
    await mount();
    await act(async () => {
      useAgentSubagentStore.getState().applyEvent({
        type: "message",
        agentId: AGENT,
        parentThreadId: PARENT,
        text: "Also check the docs folder.",
        delivered: false,
      });
    });
    const waiting = container.querySelector(".agw-agent-card[data-waiting]");
    expect(waiting?.textContent).toContain("Also check the docs folder.");
    expect(waiting?.textContent).toContain("waiting for its next step");

    // The agent takes it in: the next read of its file holds the message.
    vi.mocked(auroraInvoke).mockResolvedValue({
      ...thread,
      messages: [
        ...thread.messages,
        {
          id: "m3",
          role: "user",
          content: "Also check the docs folder.",
          timestamp: "2026-10-08T10:01:00Z",
        },
      ],
    });
    useAgentSubagentStore.setState({ liveTurnByAgent: {} });
    seed(snapshot({ status: "completed" }));
    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(container.querySelector(".agw-agent-card[data-waiting]")).toBeNull();
  });

  it("says so when the transcript cannot be found", async () => {
    vi.mocked(auroraInvoke).mockResolvedValue(null);
    await mount();
    expect(container.querySelector(".agw-cp-empty")?.textContent).toContain(
      "This agent's transcript could not be found.",
    );
  });

  it("coming back to the tab shows the transcript at once and where the reader left it", async () => {
    // jsdom lays nothing out and drops writes to scrollTop. Give every element
    // a tall scroller and a remembered scrollTop for the length of this test.
    const proto = HTMLElement.prototype;
    const saved = ["scrollTop", "scrollHeight", "clientHeight"].map(
      (name) => [name, Object.getOwnPropertyDescriptor(proto, name)] as const,
    );
    const tops = new WeakMap<object, number>();
    Object.defineProperty(proto, "scrollTop", {
      configurable: true,
      get() {
        return tops.get(this) ?? 0;
      },
      set(value: number) {
        tops.set(this, value);
      },
    });
    Object.defineProperty(proto, "scrollHeight", { configurable: true, get: () => 2_000 });
    Object.defineProperty(proto, "clientHeight", { configurable: true, get: () => 500 });
    try {
      // The dock remounts a tab on every switch. First visit: the reader
      // scrolls up from the bottom, then switches away.
      await mount();
      const first = container.querySelector<HTMLDivElement>(".agw-cp-body")!;
      first.scrollTop = 300;
      act(() => root?.unmount());
      root = null;

      // Second visit: no "Loading…" (the transcript is remembered), and the
      // remembered position — not the top, not the end.
      vi.mocked(auroraInvoke).mockReset();
      vi.mocked(auroraInvoke).mockImplementation(() => new Promise(() => {}));
      await mount();
      expect(container.querySelector(".agw-cp-empty")).toBeNull();
      expect(container.querySelector(".agw-agent-card")).not.toBeNull();
      const second = container.querySelector<HTMLDivElement>(".agw-cp-body")!;
      expect(second.scrollTop).toBe(300);
    } finally {
      for (const [name, descriptor] of saved) {
        if (descriptor) Object.defineProperty(proto, name, descriptor);
        else delete (proto as unknown as Record<string, unknown>)[name];
      }
    }
  });
});
