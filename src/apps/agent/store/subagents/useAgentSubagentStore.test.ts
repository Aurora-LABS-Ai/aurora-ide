import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/kernel/lib/ipc/runtime", () => ({
  auroraListen: vi.fn(() => Promise.resolve(() => {})),
  auroraInvoke: vi.fn(() => Promise.resolve(null)),
}));

import { useAgentSubagentStore } from "./useAgentSubagentStore";

const message = (text: string, delivered: boolean) => ({
  type: "message" as const,
  agentId: "agent_p",
  parentThreadId: "thread-1",
  text,
  delivered,
});

describe("messages the parent sends a running agent", () => {
  beforeEach(() => {
    useAgentSubagentStore.setState({ pendingByAgent: {} });
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
