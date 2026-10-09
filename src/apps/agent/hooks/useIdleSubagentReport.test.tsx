/**
 * How a sub-agent's report wakes an idle conversation, and how it never wakes
 * it twice or not at all.
 *
 * Written against the 2026-10-08 run: four reports emitted together, two
 * drains racing for one idle moment, one report never reaching the model.
 * The first test fails on that code.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SendOutcome } from "@/apps/agent/hooks/conversation/send-outcome";
import {
  clearSubagentReportFlights,
  useIdleSubagentReport,
} from "@/apps/agent/hooks/useIdleSubagentReport";
import { useSubagentWatch } from "@/apps/agent/hooks/useSubagentWatch";
import type { PendingWake } from "@/apps/agent/services/subagents/commands";
import type { AgentReportMeta } from "@/apps/agent/services/subagents/events";
import { useAgentChatStore } from "@/apps/agent/store/conversation/useAgentChatStore";
import { useAgentDraftStore } from "@/apps/agent/store/conversation/useAgentDraftStore";
import { useAgentSubagentStore } from "@/apps/agent/store/subagents/useAgentSubagentStore";

const listeners = new Set<(event: { payload: unknown }) => void>();
/** What Rust's outbox holds, as `agent_subagent_pending` would answer. */
let outbox: PendingWake[] = [];
const invoked: Array<{ cmd: string; args: Record<string, unknown> | undefined }> = [];

vi.mock("@/kernel/lib/ipc/runtime", () => ({
  auroraInvoke: vi.fn((cmd: string, args?: Record<string, unknown>) => {
    invoked.push({ cmd, args });
    switch (cmd) {
      case "agent_subagent_list":
        return Promise.resolve([]);
      case "agent_subagent_pending":
        return Promise.resolve(outbox.filter((w) => w.parentThreadId === args?.parentThreadId));
      case "agent_subagent_claim": {
        const before = outbox.length;
        outbox = outbox.filter((w) => w.id !== args?.wakeId);
        return Promise.resolve(outbox.length < before);
      }
      default:
        return Promise.resolve(undefined);
    }
  }),
  auroraListen: vi.fn((_name: string, handler: (event: { payload: unknown }) => void) => {
    listeners.add(handler);
    return Promise.resolve(() => listeners.delete(handler));
  }),
}));

const THREAD = "thread-1";
type Send = (detail: string, summary: string, agent: AgentReportMeta) => Promise<SendOutcome>;
const send = vi.fn<Send>(() => Promise.resolve("started"));

const Harness = () => {
  useSubagentWatch(THREAD);
  useIdleSubagentReport(THREAD, send);
  return null;
};

const wake = (id: number, name: string): PendingWake => ({
  id,
  parentThreadId: THREAD,
  agent: { agentId: `agent_${name}`, name, status: "completed" },
  summary: `Finished "${name}" · completed`,
  detail: `<subagent_report agent="${name}">done</subagent_report>`,
  queuedAtMs: 1_000 + id,
});

/** Rust emitting the `report` event for a wake it just recorded. */
const announce = async (w: PendingWake) => {
  outbox.push(w);
  await act(async () => {
    listeners.forEach((handler) =>
      handler({
        payload: {
          type: "report",
          agentId: w.agent.agentId,
          parentThreadId: w.parentThreadId,
          agent: w.agent,
          summary: w.summary,
          detail: w.detail,
          wakeId: w.id,
          emittedAtMs: Date.now(),
        },
      }),
    );
    await Promise.resolve();
  });
};

const settle = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
};

const openTurn = () =>
  useAgentChatStore.setState({ liveTurns: { [THREAD]: { id: THREAD } as never } });
const closeTurn = () => useAgentChatStore.setState({ liveTurns: {} });

const claims = () =>
  invoked.filter((c) => c.cmd === "agent_subagent_claim").map((c) => c.args?.wakeId);

describe("waking an idle conversation with a sub-agent's report", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  const mount = async () => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
      .IS_REACT_ACT_ENVIRONMENT = true;
    await act(async () => {
      root = createRoot(container);
      root.render(<Harness />);
    });
    await settle();
  };

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    listeners.clear();
    outbox = [];
    invoked.length = 0;
    clearSubagentReportFlights();
    send.mockClear();
    send.mockImplementation(() => Promise.resolve("started"));
    useAgentSubagentStore.setState({
      byParent: {},
      loaded: {},
      wakesByParent: {},
      liveTurnByAgent: {},
      pendingByAgent: {},
    });
    useAgentChatStore.setState({
      currentThreadId: THREAD,
      liveTurns: {},
      queuedByThread: {},
    });
    useAgentDraftStore.setState({ drafts: {} });
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container.remove();
  });

  it("carries every report once, in order, one turn at a time", async () => {
    // Each send resolves only when the test says so, like the real pipeline
    // awaiting before it marks the turn live.
    const resolvers: Array<(o: SendOutcome) => void> = [];
    send.mockImplementation(
      () =>
        new Promise<SendOutcome>((resolve) => {
          resolvers.push(resolve);
        }),
    );
    await mount();

    // Four reports land within a tenth of a second, as on 2026-10-08.
    await announce(wake(1, "backend"));
    await announce(wake(2, "portal"));
    await announce(wake(3, "client"));
    await announce(wake(4, "mail-admin"));
    // The store churns while the first send is still in flight.
    await act(async () => {
      useAgentChatStore.setState({ sending: true } as never);
      await Promise.resolve();
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][2].name).toBe("backend");

    // The turn opens and the send settles: the wake is claimed, the next one
    // waits for the turn to end.
    for (const [index, name] of ["backend", "portal", "client", "mail-admin"].entries()) {
      expect(send.mock.calls[index][2].name).toBe(name);
      await act(async () => {
        openTurn();
        resolvers[index]("started");
      });
      await settle();
      expect(claims()).toContain(index + 1);
      expect(send).toHaveBeenCalledTimes(index + 1);
      await act(async () => {
        closeTurn();
      });
      await settle();
    }
    expect(send).toHaveBeenCalledTimes(4);
    expect(claims()).toEqual([1, 2, 3, 4]);
    expect(outbox).toEqual([]);
  });

  it("keeps a report whose send did not open a turn, for the next idle moment", async () => {
    send.mockImplementationOnce(() => Promise.resolve("skipped"));
    await mount();
    await announce(wake(1, "backend"));
    await settle();
    expect(send).toHaveBeenCalledTimes(1);
    expect(claims()).toEqual([]);
    expect(useAgentSubagentStore.getState().wakesByParent[THREAD]).toHaveLength(1);

    // The turn that got there first runs and ends.
    await act(async () => {
      openTurn();
    });
    await act(async () => {
      closeTurn();
    });
    await settle();
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1][2].name).toBe("backend");
    expect(claims()).toEqual([1]);
  });

  it("finds a report through the poll when its event never arrives", async () => {
    // Rust recorded the wake; the event is stuck behind streamed tokens.
    outbox.push(wake(1, "backend"));
    await mount();
    await settle();
    // Opening the conversation reads the outbox with the list.
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][1]).toBe('Finished "backend" · completed');
    expect(claims()).toEqual([1]);
  });

  it("stays quiet while a turn is running and sends when it ends", async () => {
    openTurn();
    await mount();
    await announce(wake(1, "backend"));
    await settle();
    expect(send).not.toHaveBeenCalled();

    await act(async () => {
      closeTurn();
    });
    await settle();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("waits while the person is typing", async () => {
    useAgentDraftStore.setState({ drafts: { [THREAD]: "what about " } });
    await mount();
    await announce(wake(1, "backend"));
    await settle();
    expect(send).not.toHaveBeenCalled();

    await act(async () => {
      useAgentDraftStore.setState({ drafts: {} });
      useAgentChatStore.setState({ liveTurns: {} });
    });
    await settle();
    expect(send).toHaveBeenCalledTimes(1);
  });
});
