import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();

vi.mock("@/kernel/lib/ipc/runtime", () => ({
  auroraInvoke: (...args: unknown[]) => invoke(...args),
}));
vi.mock("@/kernel/lib/ipc/tauri", () => ({ isTauri: () => true }));

const { useAgentMemoryStore } = await import(
  "@/apps/agent/store/conversation/useAgentMemoryStore"
);

const fact = (id: string, text: string, pinned = false, createdAt = "2026-09-01") => ({
  id,
  text,
  pinned,
  sourceChatId: null,
  createdAt,
  updatedAt: createdAt,
});

const reset = () =>
  useAgentMemoryStore.setState({
    facts: [],
    stats: null,
    loading: false,
    error: null,
    editingId: null,
    rebuilding: false,
  });

beforeEach(() => {
  invoke.mockReset();
  reset();
});

describe("loading", () => {
  it("reads the facts and the counts together", async () => {
    invoke.mockImplementation((command: string) => {
      if (command === "chat_memory_list_facts") return Promise.resolve([fact("f1", "a")]);
      if (command === "chat_memory_stats")
        return Promise.resolve({ indexedChats: 3, facts: 1 });
      throw new Error(`unexpected ${command}`);
    });

    await useAgentMemoryStore.getState().load();

    const state = useAgentMemoryStore.getState();
    expect(state.facts).toHaveLength(1);
    expect(state.stats).toEqual({ indexedChats: 3, facts: 1 });
    expect(state.loading).toBe(false);
  });

  /** An unreadable index is a real state. It must say so rather than look empty. */
  it("surfaces a failure instead of showing an empty list", async () => {
    invoke.mockRejectedValue(new Error("index could not be opened"));
    await useAgentMemoryStore.getState().load();

    const state = useAgentMemoryStore.getState();
    expect(state.loading).toBe(false);
    expect(state.error).toContain("index could not be opened");
  });
});

describe("adding", () => {
  it("reloads rather than appending, because a duplicate updates in place", async () => {
    // The Rust side treats a repeated fact as an UPDATE. Appending the returned
    // row locally would show a second copy that does not exist on disk.
    invoke.mockImplementation((command: string) => {
      if (command === "chat_memory_add_fact") return Promise.resolve(fact("f1", "a"));
      if (command === "chat_memory_list_facts") return Promise.resolve([fact("f1", "a")]);
      if (command === "chat_memory_stats")
        return Promise.resolve({ indexedChats: 0, facts: 1 });
      throw new Error(`unexpected ${command}`);
    });

    await useAgentMemoryStore.getState().add("a");

    expect(invoke).toHaveBeenCalledWith("chat_memory_add_fact", { text: "a" });
    expect(invoke).toHaveBeenCalledWith("chat_memory_list_facts");
    expect(useAgentMemoryStore.getState().facts).toHaveLength(1);
  });

  it("does not send an empty fact", async () => {
    await useAgentMemoryStore.getState().add("   ");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("trims before sending", async () => {
    invoke.mockResolvedValue([]);
    await useAgentMemoryStore.getState().add("  spaced out  ");
    expect(invoke).toHaveBeenCalledWith("chat_memory_add_fact", { text: "spaced out" });
  });
});

describe("editing", () => {
  it("updates in place without reloading the whole list", async () => {
    useAgentMemoryStore.setState({ facts: [fact("f1", "old"), fact("f2", "other")] });
    invoke.mockResolvedValue(true);

    await useAgentMemoryStore.getState().update("f1", "new");

    expect(useAgentMemoryStore.getState().facts[0].text).toBe("new");
    expect(useAgentMemoryStore.getState().editingId).toBeNull();
    // A reload here would flash the whole list on every save.
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("puts the old text back when the write fails", async () => {
    useAgentMemoryStore.setState({ facts: [fact("f1", "old")] });
    invoke.mockRejectedValue(new Error("disk full"));

    await useAgentMemoryStore.getState().update("f1", "new");

    const state = useAgentMemoryStore.getState();
    expect(state.facts[0].text).toBe("old");
    expect(state.error).toContain("disk full");
  });
});

describe("pinning", () => {
  /**
   * Pinned facts sort to the top on the server. Without re-sorting locally the
   * row stays where it was and the pin looks like it did nothing until the
   * page is reopened.
   */
  it("moves a pinned fact to the top immediately", async () => {
    useAgentMemoryStore.setState({
      facts: [
        fact("f1", "newest", false, "2026-09-03"),
        fact("f2", "middle", false, "2026-09-02"),
        fact("f3", "oldest", false, "2026-09-01"),
      ],
    });
    invoke.mockResolvedValue(true);

    await useAgentMemoryStore.getState().setPinned("f3", true);

    expect(useAgentMemoryStore.getState().facts.map((f) => f.id)).toEqual([
      "f3",
      "f1",
      "f2",
    ]);
  });

  it("unpinning returns it to its place by recency", async () => {
    useAgentMemoryStore.setState({
      facts: [
        fact("f3", "oldest", true, "2026-09-01"),
        fact("f1", "newest", false, "2026-09-03"),
      ],
    });
    invoke.mockResolvedValue(true);

    await useAgentMemoryStore.getState().setPinned("f3", false);

    expect(useAgentMemoryStore.getState().facts.map((f) => f.id)).toEqual(["f1", "f3"]);
  });

  it("rolls back when the write fails", async () => {
    useAgentMemoryStore.setState({ facts: [fact("f1", "a"), fact("f2", "b")] });
    invoke.mockRejectedValue(new Error("nope"));

    await useAgentMemoryStore.getState().setPinned("f2", true);

    const state = useAgentMemoryStore.getState();
    expect(state.facts.map((f) => f.id)).toEqual(["f1", "f2"]);
    expect(state.facts.every((f) => !f.pinned)).toBe(true);
  });
});

describe("forgetting", () => {
  it("removes the row and decrements the count", async () => {
    useAgentMemoryStore.setState({
      facts: [fact("f1", "a"), fact("f2", "b")],
      stats: { indexedChats: 2, facts: 2 },
    });
    invoke.mockResolvedValue(true);

    await useAgentMemoryStore.getState().forget("f1");

    const state = useAgentMemoryStore.getState();
    expect(state.facts.map((f) => f.id)).toEqual(["f2"]);
    expect(state.stats?.facts).toBe(1);
  });

  it("puts it back when the delete fails", async () => {
    useAgentMemoryStore.setState({
      facts: [fact("f1", "a")],
      stats: { indexedChats: 0, facts: 1 },
    });
    invoke.mockImplementation((command: string) => {
      if (command === "chat_memory_forget_fact") return Promise.reject(new Error("locked"));
      if (command === "chat_memory_list_facts") return Promise.resolve([fact("f1", "a")]);
      if (command === "chat_memory_stats")
        return Promise.resolve({ indexedChats: 0, facts: 1 });
      throw new Error(`unexpected ${command}`);
    });

    await useAgentMemoryStore.getState().forget("f1");

    expect(useAgentMemoryStore.getState().facts).toHaveLength(1);
  });
});

describe("rebuilding the index", () => {
  it("shows it is running, then reloads", async () => {
    invoke.mockImplementation((command: string) => {
      if (command === "chat_memory_rebuild_index") return Promise.resolve(7);
      if (command === "chat_memory_list_facts") return Promise.resolve([]);
      if (command === "chat_memory_stats")
        return Promise.resolve({ indexedChats: 7, facts: 0 });
      throw new Error(`unexpected ${command}`);
    });

    await useAgentMemoryStore.getState().rebuildIndex();

    const state = useAgentMemoryStore.getState();
    expect(state.rebuilding).toBe(false);
    expect(state.stats?.indexedChats).toBe(7);
  });

  it("stops showing as running even when it fails", async () => {
    invoke.mockRejectedValue(new Error("walk failed"));
    await useAgentMemoryStore.getState().rebuildIndex();

    const state = useAgentMemoryStore.getState();
    expect(state.rebuilding).toBe(false);
    expect(state.error).toContain("walk failed");
  });
});
