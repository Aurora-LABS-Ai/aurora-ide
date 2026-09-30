import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DbThread, ThreadSummary } from "@/apps/agent/services/threads/thread-service";
import { useAgentChatStore } from "@/apps/agent/store/conversation/useAgentChatStore";
import { useAgentSettingsStore } from "@/apps/agent/store/settings/useAgentSettingsStore";

const { listThreadsMock } = vi.hoisted(() => ({
  listThreadsMock: vi.fn<(_root: string | null, _surface: "chat" | "build") => Promise<ThreadSummary[]>>(async () => []),
}));

vi.mock("@/kernel/lib/ipc/tauri", () => ({ isTauri: () => true }));

vi.mock("@/apps/agent/services/threads/thread-service", () => ({
  threadService: { listThreads: listThreadsMock },
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
