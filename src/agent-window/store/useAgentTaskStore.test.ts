/**
 * The checklist must reflect what Rust says, not what the frontend guessed.
 *
 * The bug these cover: the panel was built by parsing `todo_write` tool-call
 * arguments, so `todo_update` — the tool the agent uses for nearly all progress
 * — moved nothing. The user watched 0/4 with the first row spinning while the
 * agent completed the list.
 */

import { beforeEach, describe, expect, it } from "vitest";

import { useAgentTaskStore } from "./useAgentTaskStore";

const THREAD = "thread-a";
const OTHER = "thread-b";

describe("useAgentTaskStore", () => {
  beforeEach(() => {
    useAgentTaskStore.setState({ byThread: {}, dismissed: {} });
  });

  it("applies a Rust payload, keeping the backend's stable ids", () => {
    useAgentTaskStore.getState().applyTodos(THREAD, [
      { id: "t1", content: "Add the route", activeForm: "Adding the route", status: "completed" },
      { id: "t2", content: "Wire auth", activeForm: "Wiring auth", status: "in_progress" },
    ]);

    const tasks = useAgentTaskStore.getState().byThread[THREAD];
    expect(tasks.map((t) => t.id)).toEqual(["t1", "t2"]);
    // The running row shows the present-continuous form; the imperative is
    // retained so a paused row can fall back to it.
    expect(tasks[1].content).toBe("Wiring auth");
    expect(tasks[1].originalContent).toBe("Wire auth");
    // A finished row is named by what it was, not what it was doing.
    expect(tasks[0].content).toBe("Add the route");
  });

  it("advances the list on a single-item update, not just a full rewrite", () => {
    useAgentTaskStore.getState().applyTodos(THREAD, [
      { id: "t1", content: "a", activeForm: "a-ing", status: "in_progress" },
      { id: "t2", content: "b", activeForm: "b-ing", status: "pending" },
    ]);
    // `todo_update` emits the same full payload — the panel moves either way.
    useAgentTaskStore.getState().applyTodos(THREAD, [
      { id: "t1", content: "a", activeForm: "a-ing", status: "completed" },
      { id: "t2", content: "b", activeForm: "b-ing", status: "in_progress" },
    ]);

    const tasks = useAgentTaskStore.getState().byThread[THREAD];
    expect(tasks.map((t) => t.status)).toEqual(["completed", "in_progress"]);
    expect(tasks[0].id).toBe("t1");
  });

  it("keeps each conversation's list to itself", () => {
    useAgentTaskStore
      .getState()
      .applyTodos(THREAD, [{ id: "t1", content: "a", status: "pending" }]);
    useAgentTaskStore
      .getState()
      .applyTodos(OTHER, [{ id: "t1", content: "z", status: "completed" }]);

    expect(useAgentTaskStore.getState().byThread[THREAD][0].content).toBe("a");
    expect(useAgentTaskStore.getState().byThread[OTHER][0].content).toBe("z");
  });

  it("clears the panel when the list is emptied", () => {
    useAgentTaskStore
      .getState()
      .applyTodos(THREAD, [{ id: "t1", content: "a", status: "pending" }]);
    useAgentTaskStore.getState().applyTodos(THREAD, []);

    expect(useAgentTaskStore.getState().byThread[THREAD]).toBeUndefined();
  });

  it("ignores a malformed payload instead of rendering blank rows", () => {
    useAgentTaskStore
      .getState()
      .applyTodos(THREAD, [{ id: "t1", content: "a", status: "pending" }]);
    useAgentTaskStore.getState().applyTodos(THREAD, "not-an-array");

    expect(useAgentTaskStore.getState().byThread[THREAD]).toBeUndefined();
  });

  it("ignores an update with no thread to route it to", () => {
    useAgentTaskStore
      .getState()
      .applyTodos("", [{ id: "t1", content: "a", status: "pending" }]);
    expect(useAgentTaskStore.getState().byThread).toEqual({});
  });

  describe("dismissal", () => {
    it("does not resurrect a list the user closed", async () => {
      useAgentTaskStore
        .getState()
        .applyTodos(THREAD, [{ id: "t1", content: "a", status: "pending" }]);
      useAgentTaskStore.getState().clear(THREAD);

      // Switching away and back must not bring it straight back — the ✕ would
      // feel broken.
      await useAgentTaskStore.getState().hydrate(THREAD);
      expect(useAgentTaskStore.getState().byThread[THREAD]).toBeUndefined();
    });

    it("shows the list again as soon as the agent touches it", () => {
      useAgentTaskStore
        .getState()
        .applyTodos(THREAD, [{ id: "t1", content: "a", status: "pending" }]);
      useAgentTaskStore.getState().clear(THREAD);
      useAgentTaskStore
        .getState()
        .applyTodos(THREAD, [{ id: "t1", content: "a", status: "in_progress" }]);

      expect(useAgentTaskStore.getState().byThread[THREAD]).toHaveLength(1);
    });
  });

  it("does not re-read a thread it already holds", async () => {
    // Cold start only: the live event keeps every thread current, and a re-read
    // could resolve after a newer event and replay a stale list.
    useAgentTaskStore
      .getState()
      .applyTodos(THREAD, [{ id: "t1", content: "a", status: "completed" }]);

    await useAgentTaskStore.getState().hydrate(THREAD);

    expect(useAgentTaskStore.getState().byThread[THREAD][0].status).toBe(
      "completed",
    );
  });
});
