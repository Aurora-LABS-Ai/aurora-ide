import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/kernel/lib/ipc/runtime", () => ({
  auroraListen: vi.fn(() => Promise.resolve(() => {})),
  // Stores imported along the way load their settings on start.
  auroraInvoke: vi.fn(() => Promise.resolve(null)),
}));

import { routeSubagentEvent, startSubagentLiveStream } from "./live-stream";
import { useAgentSubagentStore } from "@/apps/agent/store/subagents/useAgentSubagentStore";
import {
  resetSubagentLive,
  selectLiveFor,
  useSubagentLiveStore,
} from "@/apps/agent/store/subagents/useSubagentLiveStore";
import { mergeLive } from "@/apps/agent/lib/subagents/live-transcript";
import type { AgentEventEnvelope } from "@/apps/agent/services/runtime/agent-runtime-client";

type Event = AgentEventEnvelope["event"];
const envelope = (turnId: string, event: Event) =>
  ({ turnId, event }) as unknown as AgentEventEnvelope;
const thinking = (text: string) => ({ type: "thinking", text }) as unknown as Event;
const attempt = { type: "stream_attempt_started" } as unknown as Event;

describe("routeSubagentEvent", () => {
  beforeEach(() => {
    resetSubagentLive();
    useAgentSubagentStore.setState({
      liveTurnByAgent: { agent_inv: "sub_turn_1" },
      pendingByAgent: {},
    });
  });
  afterEach(() => vi.useRealTimers());

  it("keeps a thought whole with its real start time, whoever is looking", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    routeSubagentEvent(envelope("sub_turn_1", attempt));
    routeSubagentEvent(envelope("sub_turn_1", thinking("Summing the ")));
    vi.setSystemTime(6_000);
    // No view was mounted for any of this. One mounting now (a tab switched
    // back to) reads the reply as it stands.
    routeSubagentEvent(envelope("sub_turn_1", thinking("garden prices.")));
    const live = selectLiveFor("agent_inv")(useSubagentLiveStore.getState());
    const merged = mergeLive([], live);
    expect(merged).toHaveLength(1);
    const timeline = merged[0].timeline as Array<{ kind: string; text?: string }>;
    const thought = timeline.find((e) => e.kind === "thinking");
    expect(thought).toMatchObject({ text: "Summing the garden prices." });
    expect(new Date(merged[0].timestamp).getTime()).toBe(1_000);
  });

  it("ignores the parent's own turns and agents that are not running", () => {
    routeSubagentEvent(envelope("parent_turn", thinking("parent thinking")));
    routeSubagentEvent(envelope("sub_other", thinking("someone else")));
    expect(useSubagentLiveStore.getState().byAgent).toEqual({});
  });

  it("asks the views to re-read when a model call starts, and a moment after a message lands", () => {
    const scheduled: Array<() => void> = [];
    routeSubagentEvent(envelope("sub_turn_1", attempt), (run) => scheduled.push(run));
    expect(useSubagentLiveStore.getState().rereadTick.agent_inv).toBe(1);

    useAgentSubagentStore.setState({
      pendingByAgent: { agent_inv: [{ id: "p1", text: "and the docs", queuedAtMs: 0 }] },
    });
    routeSubagentEvent(
      envelope("sub_turn_1", {
        type: "queued_message_injected",
        text: "and the docs",
      } as unknown as Event),
      (run) => scheduled.push(run),
    );
    expect(useAgentSubagentStore.getState().pendingByAgent.agent_inv).toBeUndefined();
    expect(useSubagentLiveStore.getState().rereadTick.agent_inv).toBe(1);
    scheduled.forEach((run) => run());
    expect(useSubagentLiveStore.getState().rereadTick.agent_inv).toBe(2);
  });
});

describe("startSubagentLiveStream", () => {
  it("drops an agent's live reply when its run ends", () => {
    resetSubagentLive();
    useAgentSubagentStore.setState({ liveTurnByAgent: { agent_inv: "sub_turn_1" } });
    const stop = startSubagentLiveStream();
    routeSubagentEvent(envelope("sub_turn_1", thinking("working")));
    expect(useSubagentLiveStore.getState().byAgent.agent_inv).toBeDefined();
    useAgentSubagentStore.setState({ liveTurnByAgent: {} });
    expect(useSubagentLiveStore.getState().byAgent.agent_inv).toBeUndefined();
    stop();
  });
});
