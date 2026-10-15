import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DbThread, ThreadSummary } from "@/apps/agent/services/threads/thread-service";
import { useAgentChatStore } from "@/apps/agent/store/conversation/useAgentChatStore";
import { useAgentSettingsStore } from "@/apps/agent/store/settings/useAgentSettingsStore";
import { useAgentSubagentStore } from "@/apps/agent/store/subagents/useAgentSubagentStore";
import { useAgentWorkspaceStore } from "@/apps/agent/store/workspace/useAgentWorkspaceStore";

const { listThreadsMock, deleteThreadMock } = vi.hoisted(() => ({
  listThreadsMock: vi.fn<(_root: string | null, _surface: "chat" | "build") => Promise<ThreadSummary[]>>(async () => []),
  deleteThreadMock: vi.fn<(id: string) => Promise<void>>(async () => {}),
}));

vi.mock("@/kernel/lib/ipc/tauri", () => ({ isTauri: () => true }));

vi.mock("@/apps/agent/services/threads/thread-service", () => ({
  threadService: { listThreads: listThreadsMock, deleteThread: deleteThreadMock },
}));

const seed: DbThread = {
  id: "thread-a",
  title: "Original chat",
  summary: null,
  messages: [],
  created_at: "2026-07-10T00:00:00.000Z",
  updated_at: "2026-07-10T00:00:00.000Z",
};

describe("useAgentChatStore background turns", () => {
  beforeEach(() => {
    useAgentChatStore.setState({
      projectRoot: "C:/project-b",
      currentThreadId: "thread-b",
      currentThread: null,
      liveTurns: {},
      liveProjects: {},
      sending: false,
    });
  });

  it("keeps a seeded background turn bound to its originating project", () => {
    useAgentChatStore
      .getState()
      .beginTurn("thread-a", seed, "C:/project-a");

    const state = useAgentChatStore.getState();
    expect(state.liveTurns["thread-a"]).toBe(seed);
    expect(state.liveProjects["thread-a"]).toBe("C:/project-a");
    expect(state.currentThreadId).toBe("thread-b");
    expect(state.currentThread).toBeNull();
    expect(state.sending).toBe(true);
  });
});

describe("useAgentChatStore frame-queued turn patches", () => {
  const text = (id: string, content: string) => ({
    id,
    role: "assistant",
    content,
    timestamp: "2026-10-12T00:00:00.000Z",
  });
  const append = (suffix: string) => (m: { content: string }) => ({
    ...m,
    content: m.content + suffix,
  }) as never;

  beforeEach(() => {
    useAgentChatStore.getState().flushTurnPatches();
    useAgentChatStore.setState({
      currentThreadId: "a",
      currentThread: null,
      liveTurns: {},
      liveProjects: {},
      sending: false,
    });
    const s = useAgentChatStore.getState();
    s.beginTurn("a", { ...seed, id: "a", messages: [text("m", "")] }, null);
    s.beginTurn("b", { ...seed, id: "b", messages: [text("n", "")] }, null);
  });

  it("holds queued patches until the frame, then lands every chat's in ONE update", () => {
    const s = useAgentChatStore.getState();
    let updates = 0;
    const unsubscribe = useAgentChatStore.subscribe(() => {
      updates += 1;
    });
    s.queueTurnPatch("a", "m", append("1"));
    s.queueTurnPatch("b", "n", append("x"));
    s.queueTurnPatch("a", "m", append("2"));
    expect(useAgentChatStore.getState().liveTurns.a.messages[0].content).toBe("");

    useAgentChatStore.getState().flushTurnPatches();
    unsubscribe();

    const state = useAgentChatStore.getState();
    expect(updates).toBe(1);
    expect(state.liveTurns.a.messages[0].content).toBe("12");
    expect(state.liveTurns.b.messages[0].content).toBe("x");
    // The open chat's view follows its live turn, as a direct patch does.
    expect(state.currentThread).toBe(state.liveTurns.a);
  });

  it("applies the queue before a direct write so order never changes", () => {
    const s = useAgentChatStore.getState();
    s.queueTurnPatch("a", "m", append("queued "));
    s.patchTurnMessage("a", "m", append("direct"));
    expect(useAgentChatStore.getState().liveTurns.a.messages[0].content).toBe("queued direct");
  });

  it("applies the queue before a turn closes, so its last words are kept", () => {
    const s = useAgentChatStore.getState();
    s.queueTurnPatch("a", "m", append("tail"));
    const before = useAgentChatStore.getState().liveTurns.a;
    s.endTurn("a");
    expect(before.messages[0].content).toBe("");
    // Gone from the live turns, but its view kept the tail it was given.
    expect(useAgentChatStore.getState().liveTurns.a).toBeUndefined();
    expect(useAgentChatStore.getState().currentThread?.messages[0].content).toBe("tail");
  });
});

describe("useAgentChatStore boot", () => {
  beforeEach(() => {
    listThreadsMock.mockClear();
    // The window has mounted and the settings read is still in flight, which is
    // exactly the state a real launch is in: `isLoading` makes the store's own
    // `initializeFromDatabase` a no-op, the way a second caller finds it.
    useAgentSettingsStore.setState({
      isInitialized: false,
      isLoading: true,
      auroraSurface: "build",
    });
  });

  it("lists no conversations until the saved product has been read", async () => {
    const booting = useAgentChatStore.getState().init(null);

    // Asking now would ask the DEFAULT. A window reopening on Aurora Chat would
    // fill its rail with Build's conversations and keep them, because nothing
    // lists them again once the real answer lands.
    expect(listThreadsMock).not.toHaveBeenCalled();

    useAgentSettingsStore.setState({ auroraSurface: "chat", isInitialized: true, isLoading: false });
    await booting;

    expect(listThreadsMock).toHaveBeenCalledWith(null, "chat");
  });

  it("goes straight through when the settings are already read", async () => {
    useAgentSettingsStore.setState({
      isInitialized: true,
      isLoading: false,
      auroraSurface: "build",
    });

    await useAgentChatStore.getState().init("C:/project-a");

    expect(listThreadsMock).toHaveBeenCalledWith(null, "build");
  });
});

describe("surface switch requests", () => {
  const summary = (id: string): ThreadSummary => ({
    id, title: id, preview: "hello", messageCount: 1,
    workspaceRoot: null, createdAt: "2026-09-27T00:00:00Z", updatedAt: "2026-09-27T00:00:00Z",
  });

  it("ignores a late Chat list after switching back to Build", async () => {
    let resolveChat!: (threads: ThreadSummary[]) => void;
    const slowChat = new Promise<ThreadSummary[]>((resolve) => { resolveChat = resolve; });
    listThreadsMock.mockReset();
    listThreadsMock.mockImplementationOnce(() => slowChat).mockResolvedValueOnce([summary("build-thread")]);
    useAgentSettingsStore.setState({ auroraSurface: "build" });
    useAgentChatStore.setState({ currentThreadId: null, currentThread: null, projectRoot: null, error: null });

    const enteringChat = useAgentChatStore.getState().enterSurface("chat");
    await useAgentChatStore.getState().enterSurface("build");
    resolveChat([summary("chat-thread")]);
    await enteringChat;

    expect(useAgentChatStore.getState().allThreads.map((thread) => thread.id)).toEqual(["build-thread"]);
  });

  it("ignores a late failure from the surface that was left", async () => {
    let rejectChat!: (reason: Error) => void;
    const slowChat = new Promise<[]>((_, reject) => { rejectChat = reject; });
    listThreadsMock.mockReset();
    listThreadsMock.mockImplementationOnce(() => slowChat).mockResolvedValueOnce([]);
    useAgentSettingsStore.setState({ auroraSurface: "build" });
    useAgentChatStore.setState({ currentThreadId: null, currentThread: null, projectRoot: null, error: null });

    const enteringChat = useAgentChatStore.getState().enterSurface("chat");
    await useAgentChatStore.getState().enterSurface("build");
    rejectChat(new Error("stale Chat list failed"));
    await enteringChat;

    expect(useAgentSettingsStore.getState().auroraSurface).toBe("build");
    expect(useAgentChatStore.getState().error).toBeNull();
  });
});

describe("deleting a conversation with subagents", () => {
  beforeEach(() => {
    deleteThreadMock.mockReset();
    deleteThreadMock.mockResolvedValue(undefined);
    useAgentChatStore.setState({ currentThreadId: seed.id, currentThread: seed });
    useAgentSubagentStore.setState({ deletedParents: new Set() });
    useAgentWorkspaceStore.setState({ tabs: [], activeTabId: null });
  });

  it("clears subagent state only after backend deletion succeeds", async () => {
    useAgentWorkspaceStore.getState().openAgentTab(seed.id, "owned", "Owned agent");
    useAgentWorkspaceStore.getState().openAgentTab("other-parent", "other", "Other agent");
    await useAgentChatStore.getState().deleteThread(seed.id);
    expect(useAgentChatStore.getState().currentThreadId).toBeNull();
    expect(useAgentSubagentStore.getState().deletedParents.has(seed.id)).toBe(true);
    expect(useAgentWorkspaceStore.getState().tabs.map((tab) => tab.id)).toEqual(["agent:other"]);
  });

  it("keeps the conversation and its agents when deletion fails", async () => {
    deleteThreadMock.mockRejectedValueOnce(new Error("work did not stop"));
    await useAgentChatStore.getState().deleteThread(seed.id);
    expect(useAgentChatStore.getState().currentThreadId).toBe(seed.id);
    expect(useAgentSubagentStore.getState().deletedParents.has(seed.id)).toBe(false);
  });
});
