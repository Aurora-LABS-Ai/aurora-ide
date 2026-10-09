import { beforeEach, describe, expect, it, vi } from "vitest";

const disk = vi.hoisted(() => ({
  files: new Map<string, { pinned: string[]; expanded: string[] }>(),
  get: vi.fn(),
  set: vi.fn(),
}));
vi.mock("@/apps/agent/services/subagents/commands", () => ({
  getSubagentRail: (parentThreadId: string) => disk.get(parentThreadId),
  setSubagentRail: (parentThreadId: string, state: { pinned: string[]; expanded: string[] }) =>
    disk.set(parentThreadId, state),
}));
vi.mock("@/apps/agent/store/ui/useAgentToastStore", () => ({ toast: vi.fn() }));

import { useSubagentRailStore } from "./useSubagentRailStore";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const rail = () => useSubagentRailStore.getState();

beforeEach(() => {
  disk.files.clear();
  disk.get.mockReset().mockImplementation(async (id: string) =>
    disk.files.get(id) ?? { pinned: [], expanded: [] },
  );
  disk.set.mockReset().mockImplementation(async (id: string, state: { pinned: string[]; expanded: string[] }) => {
    disk.files.set(id, { pinned: [...state.pinned], expanded: [...state.expanded] });
    return state;
  });
  useSubagentRailStore.setState({ open: null, pinnedByParent: {}, expandedByParent: {}, hydrated: {} });
});

describe("useSubagentRailStore", () => {
  it("saves a pin and a grown card to the conversation's file", async () => {
    await rail().hydrate("chat");
    rail().pin("chat", "a");
    rail().setExpanded("chat", "a", true);
    await flush();
    expect(disk.files.get("chat")).toEqual({ pinned: ["a"], expanded: ["a"] });
  });

  it("puts saved pins back when the conversation is opened again (a restart)", async () => {
    disk.files.set("chat", { pinned: ["a", "b"], expanded: ["b"] });
    await rail().hydrate("chat");
    expect(rail().pinnedByParent.chat).toEqual(["a", "b"]);
    expect(rail().expandedByParent.chat).toEqual(["b"]);
  });

  it("refuses a fourth pin and changes nothing", async () => {
    await rail().hydrate("chat");
    expect(rail().pin("chat", "a")).toBe(true);
    expect(rail().pin("chat", "b")).toBe(true);
    expect(rail().pin("chat", "c")).toBe(true);
    expect(rail().pin("chat", "d")).toBe(false);
    await flush();
    expect(disk.files.get("chat")?.pinned).toEqual(["a", "b", "c"]);
  });

  it("keeps a pin made before the saved state arrived, beside the saved ones", async () => {
    disk.files.set("chat", { pinned: ["a"], expanded: [] });
    let release!: () => void;
    disk.get.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve(disk.files.get("chat"));
        }),
    );
    const reading = rail().hydrate("chat");
    rail().pin("chat", "b");
    release();
    await reading;
    await flush();
    expect(rail().pinnedByParent.chat).toEqual(["a", "b"]);
    expect(disk.files.get("chat")?.pinned).toEqual(["a", "b"]);
  });

  it("turns the open card into the pinned one, and unpinning saves too", async () => {
    await rail().hydrate("chat");
    rail().toggleOpen("chat", "a");
    expect(rail().open).toEqual({ parentThreadId: "chat", agentId: "a" });
    rail().togglePin("chat", "a");
    expect(rail().open).toBeNull();
    rail().togglePin("chat", "a");
    await flush();
    expect(disk.files.get("chat")?.pinned).toEqual([]);
  });

  it("does not save the unpinned card: it is a glance", async () => {
    await rail().hydrate("chat");
    rail().toggleOpen("chat", "a");
    await flush();
    expect(disk.set).not.toHaveBeenCalled();
  });
});
