import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useAgentBackgroundStore } from "../../store/useAgentBackgroundStore";
import { useAgentChatStore } from "../../store/useAgentChatStore";
import { ComposerRail } from "./ComposerRail";

// The panels are the popover BODIES; this suite is about the rail itself —
// which chips exist, what they read, and that clicking one mounts its panel.
vi.mock("../BackgroundTaskDock", () => ({
  BackgroundTaskDock: () => <div data-testid="process-panel">processes</div>,
}));

const THREAD = "thread-1";

const process = (id: string, status: "running" | "exited") => ({
  processId: id,
  title: id,
  command: id,
  status,
  startedAtMs: 0,
});

describe("ComposerRail", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  const render = (node: React.ReactNode) => {
    act(() => {
      root = createRoot(container);
      root.render(node);
    });
  };

  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    useAgentChatStore.setState({ currentThreadId: THREAD });
    useAgentBackgroundStore.setState({ byThread: {} });
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container.remove();
  });

  it("shows only the disclaimer when nothing is running", () => {
    render(<ComposerRail />);
    expect(container.textContent).toContain("AI can make mistakes");
    expect(container.querySelectorAll(".agw-crail-chip")).toHaveLength(0);
  });

  it("lets a transient notice take the slot instead of the disclaimer", () => {
    render(<ComposerRail notice={{ text: "Microphone: denied", tone: "error" }} />);
    expect(container.textContent).toContain("Microphone: denied");
    expect(container.textContent).not.toContain("AI can make mistakes");
  });

  it("counts running vs total processes, and only asks for attention while one runs", () => {
    useAgentBackgroundStore.setState({
      byThread: { [THREAD]: [process("dev", "running"), process("tsc", "exited")] },
    });
    render(<ComposerRail />);
    const chip = container.querySelector(".agw-crail-chip");
    expect(chip?.textContent).toBe("1/2");
    expect(chip?.getAttribute("data-attention")).toBe("true");

    // Everything settled → the chip stays reachable but stops pulsing.
    act(() => {
      useAgentBackgroundStore.setState({
        byThread: { [THREAD]: [process("dev", "exited"), process("tsc", "exited")] },
      });
    });
    const settled = container.querySelector(".agw-crail-chip");
    expect(settled?.textContent).toBe("0/2");
    expect(settled?.getAttribute("data-attention")).toBeNull();
  });

  it("mounts a chip's panel only once the chip is clicked", () => {
    useAgentBackgroundStore.setState({
      byThread: { [THREAD]: [process("dev", "running")] },
    });
    render(<ComposerRail />);
    expect(container.querySelector('[data-testid="process-panel"]')).toBeNull();

    act(() => {
      container
        .querySelector<HTMLButtonElement>(".agw-crail-chip")
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(container.querySelector('[data-testid="process-panel"]')).not.toBeNull();
    expect(container.querySelector(".agw-crail-chip")?.getAttribute("data-open")).toBe(
      "true",
    );
  });

  it("no longer hosts the task checklist — that moved to the header", () => {
    // The rail sits in the WRITING zone. A checklist is read while the agent
    // works, so it lives in the header beside context usage (`TaskIndicator`).
    // Background processes stay, because stopping one is a composer action.
    useAgentBackgroundStore.setState({
      byThread: { [THREAD]: [process("dev", "running")] },
    });
    render(<ComposerRail />);
    const readouts = [...container.querySelectorAll(".agw-crail-chip-readout")].map(
      (node) => node.textContent,
    );
    expect(readouts).toEqual(["1/1"]);
  });
});
