import { beforeEach, describe, expect, it } from "vitest";

import type { DbThread } from "../../services/thread-service";
import { useAgentChatStore } from "./useAgentChatStore";

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
