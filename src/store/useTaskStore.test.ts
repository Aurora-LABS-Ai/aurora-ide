import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useTaskStore } from "./useTaskStore";

describe("useTaskStore", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useTaskStore.getState().clearTasks();
  });

  afterEach(() => {
    useTaskStore.getState().clearTasks();
    vi.useRealTimers();
  });

  it("auto-finalizes in-progress tasks after a completed agent turn", () => {
    useTaskStore.getState().setTasks([
      { id: "1", content: "Inspect tools", status: "completed" },
      { id: "2", content: "Fixing tools", status: "in_progress" },
      { id: "3", content: "Run validation", status: "pending" },
    ]);

    useTaskStore.getState().finalizeActiveTasks("completed");

    expect(useTaskStore.getState().tasks.map((task) => task.status)).toEqual([
      "completed",
      "completed",
      "completed",
    ]);
    expect(useTaskStore.getState().isVisible).toBe(true);

    vi.advanceTimersByTime(2_500);

    expect(useTaskStore.getState().tasks).toEqual([]);
    expect(useTaskStore.getState().isVisible).toBe(false);
  });

  it("cancels non-terminal tasks after a failed or cancelled agent turn", () => {
    useTaskStore.getState().setTasks([
      { id: "1", content: "Inspect tools", status: "completed" },
      { id: "2", content: "Fixing tools", status: "in_progress" },
      { id: "3", content: "Run validation", status: "pending" },
    ]);

    useTaskStore.getState().finalizeActiveTasks("cancelled");

    expect(useTaskStore.getState().tasks.map((task) => task.status)).toEqual([
      "completed",
      "cancelled",
      "cancelled",
    ]);
  });
});
