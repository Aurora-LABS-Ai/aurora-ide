import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DbThread } from "@/apps/agent/services/threads/thread-service";

type ListenHandler = (event: { event: string; payload: unknown }) => void;
const { handlers, invokeMock, loadThreadMock, active } = vi.hoisted(() => ({
  handlers: new Map<string, Set<ListenHandler>>(),
  invokeMock: vi.fn<(command: string, args?: unknown) => Promise<unknown>>(),
  loadThreadMock: vi.fn<(id: string) => Promise<DbThread | null>>(),
  active: { turns: [] as { threadId: string; turnId: string; workspaceRoot: string | null }[] },
}));

vi.mock("@/kernel/lib/ipc/tauri", () => ({ isTauri: () => true }));
vi.mock("@/kernel/lib/ipc/runtime", () => ({
  auroraInvoke: invokeMock,
  auroraListen: vi.fn(async (name: string, handler: ListenHandler) => {
    const set = handlers.get(name) ?? new Set<ListenHandler>();
    set.add(handler);
    handlers.set(name, set);
    return () => set.delete(handler);
  }),
  isAuroraRuntimeAvailable: () => true,
}));
vi.mock("@/apps/agent/services/threads/thread-service", () => ({
  threadService: {
    loadThread: loadThreadMock,
    listThreads: vi.fn(async () => []),
  },
}));

import { followTurn, isFollowingTurn, stopFollowedTurn } from "./followed-turns";
import { useAgentChatStore } from "@/apps/agent/store/conversation/useAgentChatStore";

const emit = (name: string, payload: unknown) => {
  for (const handler of handlers.get(name) ?? []) handler({ event: name, payload });
};

const history: DbThread = {
  id: "thread-web",
  title: "Infra audit",
  summary: null,
  messages: [{ id: "old-1", role: "user", content: "earlier", timestamp: "2026-10-27T00:00:00Z" }],
  created_at: "2026-10-27T00:00:00Z",
  updated_at: "2026-10-27T00:00:00Z",
};

const until = async (check: () => boolean) => {
  for (let i = 0; i < 50 && !check(); i++) await new Promise((r) => setTimeout(r, 0));
  expect(check()).toBe(true);
};

describe("following a turn another client sent", () => {
  beforeEach(() => {
    handlers.clear();
    active.turns = [{ threadId: "thread-web", turnId: "turn-web", workspaceRoot: "E:/proj" }];
    invokeMock.mockReset().mockImplementation(async (command) =>
      command === "agent_active_turns" ? active.turns : command === "agent_cancel" ? true : [],
    );
    loadThreadMock.mockReset().mockResolvedValue(history);
    useAgentChatStore.setState({
      projectRoot: "E:/other",
      currentThreadId: null,
      currentThread: null,
      liveTurns: {},
      liveProjects: {},
      sending: false,
    });
  });

  it("shows the turn running under its project, streams it, and clears it at the end", async () => {
    const following = followTurn({
      threadId: "thread-web",
      turnId: "turn-web",
      workspaceRoot: "E:/proj",
      userMessage: "check the routes",
    });
    await until(() => isFollowingTurn("thread-web") && handlers.has("agent_turn_complete"));

    const running = useAgentChatStore.getState();
    // The rail's spinner reads these two.
    expect(running.liveTurns["thread-web"]).toBeDefined();
    expect(running.liveProjects["thread-web"]).toBe("E:/proj");
    const roles = running.liveTurns["thread-web"].messages.map((m) => [m.role, m.content]);
    expect(roles.slice(0, 2)).toEqual([
      ["user", "earlier"],
      ["user", "check the routes"],
    ]);

    // Another turn's events are not this one's.
    emit("agent_event", { turnId: "other", event: { type: "text_delta", delta: "nope" } });
    emit("agent_event", { turnId: "turn-web", event: { type: "text_delta", delta: "Routes look fine." } });
    emit("agent_turn_complete", { turnId: "turn-web", stopReason: "end_turn" });
    await following;

    const done = useAgentChatStore.getState();
    expect(done.liveTurns["thread-web"]).toBeUndefined();
    expect(isFollowingTurn("thread-web")).toBe(false);
  });

  it("writes the streamed text into the open chat while it runs", async () => {
    useAgentChatStore.setState({ currentThreadId: "thread-web", currentThread: history });
    const following = followTurn({ threadId: "thread-web", turnId: "turn-web", userMessage: "go" });
    await until(() => handlers.has("agent_turn_complete") && isFollowingTurn("thread-web"));

    emit("agent_event", { turnId: "turn-web", event: { type: "text_delta", delta: "Working on it" } });
    useAgentChatStore.getState().flushTurnPatches();
    const open = useAgentChatStore.getState().currentThread;
    expect(open?.messages.at(-1)?.content).toBe("Working on it");
    // The open view seeded the turn; the disk was not read for it.
    expect(loadThreadMock).not.toHaveBeenCalled();

    emit("agent_turn_error", { turnId: "turn-web", error: "cancelled" });
    await following;
    expect(useAgentChatStore.getState().liveTurns["thread-web"]).toBeUndefined();
  });

  it("stops the turn in the runtime", async () => {
    const following = followTurn({ threadId: "thread-web", turnId: "turn-web" });
    await until(() => handlers.has("agent_turn_error") && isFollowingTurn("thread-web"));
    await until(() => stopFollowedTurn("thread-web"));
    expect(invokeMock).toHaveBeenCalledWith("agent_cancel", { turnId: "turn-web" });
    emit("agent_turn_error", { turnId: "turn-web", error: "cancelled" });
    await following;
  });

  it("leaves a turn this client is running alone", async () => {
    useAgentChatStore.getState().beginTurn("thread-web", history, "E:/proj");
    await followTurn({ threadId: "thread-web", turnId: "turn-web" });
    expect(handlers.has("agent_event")).toBe(false);
    expect(isFollowingTurn("thread-web")).toBe(false);
  });

  it("does not hang on a turn that ended before it was followed", async () => {
    active.turns = [];
    await followTurn({ threadId: "thread-web", turnId: "turn-web" });
    expect(useAgentChatStore.getState().liveTurns["thread-web"]).toBeUndefined();
  });
});
