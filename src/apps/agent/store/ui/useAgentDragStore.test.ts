import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { dragJustEnded, useAgentDragStore } from "@/apps/agent/store/ui/useAgentDragStore";

const reset = () =>
  useAgentDragStore.setState({
    pendingPath: null,
    pendingName: null,
    pendingIsDir: false,
    startX: 0,
    startY: 0,
    path: null,
    name: null,
    isDir: false,
    isDragging: false,
    x: 0,
    y: 0,
    endedAt: 0,
  });

describe("agent-window path drag", () => {
  beforeEach(reset);
  afterEach(() => vi.restoreAllMocks());

  /** The whole reason a press is only "pending": rows are click-to-open, and a
   *  hand that shakes 2px must not turn opening a file into a drag. */
  it("keeps a small pointer move a click, not a drag", () => {
    const s = useAgentDragStore.getState();
    s.prepare("C:/p/a.ts", "a.ts", 100, 100);
    s.moveTo(103, 102);

    const after = useAgentDragStore.getState();
    expect(after.isDragging).toBe(false);
    expect(after.pendingPath).toBe("C:/p/a.ts");
  });

  it("promotes the press to a drag once the pointer travels", () => {
    const s = useAgentDragStore.getState();
    s.prepare("C:/p/a.ts", "a.ts", 100, 100);
    s.moveTo(100, 112);

    const after = useAgentDragStore.getState();
    expect(after.isDragging).toBe(true);
    expect(after.path).toBe("C:/p/a.ts");
    expect(after.name).toBe("a.ts");
    // Consumed: the press can't also still be waiting to become a drag.
    expect(after.pendingPath).toBeNull();
    expect([after.x, after.y]).toEqual([100, 112]);
  });

  it("carries the folder flag from press to drag", () => {
    const s = useAgentDragStore.getState();
    s.prepare("C:/p/src", "src", 100, 100, true);
    expect(useAgentDragStore.getState().isDir).toBe(false); // not dragging yet
    s.moveTo(100, 120);

    const after = useAgentDragStore.getState();
    expect(after.isDragging).toBe(true);
    expect(after.isDir).toBe(true);

    after.end();
    expect(useAgentDragStore.getState().isDir).toBe(false);
  });

  it("tracks the pointer only while dragging", () => {
    const s = useAgentDragStore.getState();
    s.moveTo(400, 400);
    expect([useAgentDragStore.getState().x, useAgentDragStore.getState().y]).toEqual([0, 0]);

    s.prepare("C:/p/a.ts", "a.ts", 0, 0);
    s.moveTo(50, 50);
    s.moveTo(60, 70);
    expect([useAgentDragStore.getState().x, useAgentDragStore.getState().y]).toEqual([60, 70]);
  });

  /** Releasing a drag over the row it started on still fires `click`. Without
   *  this the file would open behind every such drop. */
  it("swallows the click that trails a real drag", () => {
    const now = vi.spyOn(performance, "now");
    now.mockReturnValue(1_000);

    const s = useAgentDragStore.getState();
    s.prepare("C:/p/a.ts", "a.ts", 0, 0);
    s.moveTo(0, 40);
    s.end();

    expect(dragJustEnded()).toBe(true);
    // …but only for as long as a click can plausibly belong to that release.
    now.mockReturnValue(1_400);
    expect(dragJustEnded()).toBe(false);
  });

  it("leaves an ordinary press-and-release clickable", () => {
    const s = useAgentDragStore.getState();
    s.prepare("C:/p/a.ts", "a.ts", 0, 0);
    s.end();

    expect(dragJustEnded()).toBe(false);
    expect(useAgentDragStore.getState().pendingPath).toBeNull();
  });
});
