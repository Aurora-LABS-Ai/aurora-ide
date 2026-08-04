import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { useAgentChatStore } from "../store/useAgentChatStore";
import { useAgentTaskStore, type Task } from "../store/useAgentTaskStore";
import { TaskIndicator } from "./TaskIndicator";

const THREAD = "thread-1";

const task = (id: string, status: Task["status"], content = id): Task => ({
  id,
  content,
  originalContent: content,
  status,
});

/** A live turn on THIS thread — the only thing that entitles a task to spin. */
const setStreaming = (streaming: boolean) =>
  useAgentChatStore.setState({
    liveTurns: streaming
      ? ({ [THREAD]: { id: THREAD, messages: [] } } as never)
      : {},
  });

describe("TaskIndicator", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  const render = () => {
    act(() => {
      root = createRoot(container);
      root.render(<TaskIndicator />);
    });
  };
  const trigger = () => container.querySelector<HTMLButtonElement>(".agw-taskind");

  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    // The card portals into `.agw-root` so the `--agw-*` tokens cascade.
    container.className = "agw-root";
    document.body.appendChild(container);
    useAgentChatStore.setState({ currentThreadId: THREAD });
    useAgentTaskStore.setState({ byThread: {}, dismissed: {} });
    setStreaming(false);
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container.remove();
  });

  it("stays out of the header when nothing is tracked", () => {
    // A one-line change should not put a checklist affordance on screen.
    render();
    expect(trigger()).toBeNull();
  });

  it("counts a cancelled task as closed, not outstanding", () => {
    // Moved here from the composer rail with the rest of the checklist. The
    // panel and Rust's progress line count the same way; two numbers for one
    // list on one screen is a bug.
    useAgentTaskStore.setState({
      byThread: {
        [THREAD]: [
          task("1", "completed"),
          task("2", "cancelled"),
          task("3", "in_progress"),
        ],
      },
    });
    render();
    expect(trigger()?.textContent).toContain("2/3");
  });

  it("spins only while this conversation is actually streaming", () => {
    useAgentTaskStore.setState({
      byThread: { [THREAD]: [task("1", "in_progress", "Add the route")] },
    });
    render();

    // Turn ended with the task still open — that is PAUSED. Motion here would
    // claim work is happening when nothing is running.
    expect(trigger()?.getAttribute("data-state")).toBe("paused");
    expect(container.querySelector(".agw-taskind-spin")).toBeNull();
    expect(trigger()?.getAttribute("aria-label")).toContain("Paused");
    // The imperative title, never the present continuous.
    expect(trigger()?.getAttribute("aria-label")).toContain("Add the route");

    act(() => setStreaming(true));
    expect(trigger()?.getAttribute("data-state")).toBe("running");
    expect(container.querySelector(".agw-taskind-spin")).not.toBeNull();
  });

  it("reports the ending state once every task is closed", () => {
    useAgentTaskStore.setState({
      byThread: { [THREAD]: [task("1", "completed"), task("2", "cancelled")] },
    });
    render();
    expect(trigger()?.getAttribute("data-state")).toBe("done");
    expect(trigger()?.getAttribute("aria-label")).toContain("Tasks complete");
  });

  it("opens the checklist on hover and keeps it after a click", () => {
    useAgentTaskStore.setState({
      byThread: { [THREAD]: [task("1", "pending", "Wire the store")] },
    });
    render();
    const wrap = container.querySelector(".agw-taskind-wrap")!;
    const card = () => document.querySelector(".agw-taskpop");
    // React derives onMouseEnter/Leave from DELEGATED mouseover/mouseout, so a
    // raw `mouseenter` never reaches the handler.
    const hover = () =>
      wrap.dispatchEvent(
        new MouseEvent("mouseover", { bubbles: true, relatedTarget: document.body }),
      );
    const unhover = () =>
      wrap.dispatchEvent(
        new MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body }),
      );

    expect(card()).toBeNull();

    act(() => {
      hover();
    });
    expect(card()?.textContent).toContain("Wire the store");

    // Pinned: leaving no longer closes it, because a checklist is read WHILE
    // working and hover alone would snatch it away.
    act(() => {
      trigger()?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      unhover();
    });
    expect(card()).not.toBeNull();
    expect(trigger()?.getAttribute("aria-expanded")).toBe("true");

    // Escape is the way out of every popover in this window. Asserted on
    // `aria-expanded` rather than DOM removal because the card is inside an
    // AnimatePresence — it stays mounted for its 160ms exit, so removal would
    // be testing framer-motion's clock rather than this component's state.
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(trigger()?.getAttribute("aria-expanded")).toBe("false");
  });
});
