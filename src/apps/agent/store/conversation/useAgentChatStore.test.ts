import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DbThread } from "@/apps/agent/services/threads/thread-service";
import { useAgentChatStore } from "@/apps/agent/store/conversation/useAgentChatStore";
import { useSettingsStore } from "@/kernel/store/useSettingsStore";

const { listThreadsMock } = vi.hoisted(() => ({
  listThreadsMock: vi.fn(async () => []),
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
    useSettingsStore.setState({
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

    useSettingsStore.setState({ auroraSurface: "chat", isInitialized: true, isLoading: false });
    await booting;

    expect(listThreadsMock).toHaveBeenCalledWith(null, "chat");
  });

  it("goes straight through when the settings are already read", async () => {
    useSettingsStore.setState({
      isInitialized: true,
      isLoading: false,
      auroraSurface: "build",
    });

    await useAgentChatStore.getState().init("C:/project-a");

    expect(listThreadsMock).toHaveBeenCalledWith(null, "build");
  });
});
