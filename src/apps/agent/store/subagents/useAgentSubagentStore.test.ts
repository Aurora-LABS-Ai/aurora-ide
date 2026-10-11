import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/kernel/lib/ipc/runtime", () => ({
  auroraListen: vi.fn(() => Promise.resolve(() => {})),
  auroraInvoke: vi.fn(() => Promise.resolve(null)),
}));

import { useAgentSubagentStore } from "./useAgentSubagentStore";
import { auroraInvoke } from "@/kernel/lib/ipc/runtime";
import type { PendingWake } from "@/apps/agent/services/subagents/commands";

const message = (text: string, delivered: boolean) => ({
  type: "message" as const,
  agentId: "agent_p",
  parentThreadId: "thread-1",
  text,
  delivered,
});

describe("wakes already carried by this window", () => {
  const wake: PendingWake = {
    id: 77,
    parentThreadId: "thread-1",
    agent: { agentId: "agent_p", name: "worker", status: "completed" },
    summary: "Finished worker",
    detail: "report",
    queuedAtMs: 1000,
  };

  beforeEach(() => {
    vi.mocked(auroraInvoke).mockReset();
    vi.mocked(auroraInvoke).mockResolvedValue(true);
    useAgentSubagentStore.setState({ wakesByParent: {}, carriedWakeIds: new Set(), deletedParents: new Set() });
  });

  it("filters an older poll snapshot after the wake was carried", async () => {
    await useAgentSubagentStore.getState().claimWake("thread-1", wake.id);
    vi.mocked(auroraInvoke).mockResolvedValueOnce([]).mockResolvedValueOnce([wake]);
    await useAgentSubagentStore.getState().load("thread-1");
    expect(useAgentSubagentStore.getState().wakesByParent["thread-1"]).toBeUndefined();
  });

  it("does not carry a report again when acknowledging it fails", async () => {
    vi.mocked(auroraInvoke).mockRejectedValueOnce(new Error("IPC unavailable"));
    expect(await useAgentSubagentStore.getState().claimWake("thread-1", wake.id)).toBe(false);
    useAgentSubagentStore.getState().applyEvent({
      type: "report", agentId: wake.agent.agentId, parentThreadId: wake.parentThreadId,
      agent: wake.agent, summary: wake.summary, detail: wake.detail, wakeId: wake.id,
    });
    expect(useAgentSubagentStore.getState().wakesByParent["thread-1"]).toBeUndefined();
  });

  it("ignores report events and poll reads for a deleted parent", async () => {
    useAgentSubagentStore.getState().forget(wake.parentThreadId);
    useAgentSubagentStore.getState().applyEvent({
      type: "report", agentId: wake.agent.agentId, parentThreadId: wake.parentThreadId,
      agent: wake.agent, summary: wake.summary, detail: wake.detail, wakeId: wake.id,
    });
    await useAgentSubagentStore.getState().load(wake.parentThreadId);
    expect(auroraInvoke).not.toHaveBeenCalled();
    expect(useAgentSubagentStore.getState().wakesByParent[wake.parentThreadId]).toBeUndefined();
  });
});

describe("messages the parent sends a running agent", () => {
  beforeEach(() => {
    useAgentSubagentStore.setState({ pendingByAgent: {}, deletedParents: new Set() });
  });

  it("shows a queued message as pending, and settles it when a waiting question takes it", () => {
    const store = useAgentSubagentStore.getState();
    store.applyEvent(message("Yes, skip them.", false));
    store.applyEvent(message("And submit partial.", false));
    expect(useAgentSubagentStore.getState().pendingByAgent.agent_p).toHaveLength(2);

    // A question waiting in message_parent took both at once, joined. They
    // never reach the transcript as messages of their own, so this is what
    // clears them.
    store.applyEvent(message("Yes, skip them.\n\nAnd submit partial.", true));
    expect(useAgentSubagentStore.getState().pendingByAgent.agent_p).toBeUndefined();
  });

  it("leaves pending messages the answer did not include", () => {
    const store = useAgentSubagentStore.getState();
    store.applyEvent(message("first", false));
    store.applyEvent(message("second", false));
    store.applyEvent(message("first", true));
    const left = useAgentSubagentStore.getState().pendingByAgent.agent_p ?? [];
    expect(left.map((m) => m.text)).toEqual(["second"]);
  });
});
