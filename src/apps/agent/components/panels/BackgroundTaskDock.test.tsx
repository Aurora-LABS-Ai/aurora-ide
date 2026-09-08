/**
 * The stop button, and what the row is allowed to claim about it.
 *
 * Stopping used to be unconditional: `cancel_command_stream` discarded its
 * result and always answered Ok, and the row settled to "Stopped" the moment
 * the call returned. A kill that failed left a live process wearing a settled
 * row with a dismiss button — the one state from which nothing in the window
 * could stop it again.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BackgroundTaskDock } from "@/apps/agent/components/panels/BackgroundTaskDock";
import { useAgentBackgroundStore } from "@/apps/agent/store/conversation/useAgentBackgroundStore";
import { useAgentChatStore } from "@/apps/agent/store/conversation/useAgentChatStore";
import { cancelCommandStream } from "@/kernel/lib/ipc/tauri";

vi.mock("@/kernel/lib/ipc/tauri", () => ({
  cancelCommandStream: vi.fn(),
}));

vi.mock("@/kernel/lib/ipc/runtime", () => ({
  auroraInvoke: vi.fn(() => Promise.reject(new Error("no runtime in tests"))),
  auroraListen: vi.fn(() => Promise.resolve(() => {})),
}));

vi.mock("@/apps/agent/shared/AgentIcon", () => ({
  AgentIcon: () => null,
}));

vi.mock("framer-motion", () => ({
  AnimatePresence: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  motion: new Proxy({}, { get: () => "div" }),
}));

const THREAD = "thread-1";
const stopMock = vi.mocked(cancelCommandStream);

const seedRunning = () => {
  useAgentBackgroundStore.setState({
    byThread: {
      [THREAD]: [
        {
          processId: "bg-1",
          title: "pnpm dev",
          command: "pnpm dev",
          status: "running",
          startedAtMs: 0,
        },
      ],
    },
  });
};

const statusOf = (id: string) =>
  useAgentBackgroundStore.getState().byThread[THREAD].find((p) => p.processId === id)?.status;

describe("stopping a background process", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  const mount = async () => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
      .IS_REACT_ACT_ENVIRONMENT = true;
    await act(async () => {
      root = createRoot(container);
      root.render(<BackgroundTaskDock variant="popover" threadId={THREAD} />);
    });
  };

  const clickStop = async () => {
    const button = container.querySelector<HTMLButtonElement>(".agw-bgtask-stop");
    expect(button).not.toBeNull();
    await act(async () => {
      button!.click();
    });
    await act(async () => { await Promise.resolve(); });
  };

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    useAgentChatStore.setState({ currentThreadId: THREAD, liveTurns: {} });
    seedRunning();
    stopMock.mockReset();
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container.remove();
  });

  it("settles the row when the process actually stopped", async () => {
    stopMock.mockResolvedValue({ stopped: true });
    await mount();
    await clickStop();

    expect(statusOf("bg-1")).toBe("stopped");
    expect(container.textContent).not.toContain("Could not stop");
  });

  it("settles the row when the process had already finished on its own", async () => {
    // Idempotent by design: the race between the click and the process ending
    // is common, and it is the outcome the click asked for.
    stopMock.mockResolvedValue({ stopped: true, error: null });
    await mount();
    await clickStop();

    expect(statusOf("bg-1")).toBe("stopped");
  });

  it("leaves the row RUNNING when the kill failed, and says so", async () => {
    stopMock.mockResolvedValue({ stopped: false, error: "Access is denied. (os error 5)" });
    await mount();
    await clickStop();

    expect(statusOf("bg-1")).toBe("running");
    expect(container.textContent).toContain("Could not stop");
    expect(container.querySelector(".agw-bgtask-state")?.getAttribute("title")).toContain(
      "os error 5",
    );
  });

  it("keeps the stop button available to try again after a failure", async () => {
    stopMock.mockResolvedValue({ stopped: false, error: "still running" });
    await mount();
    await clickStop();

    const button = container.querySelector<HTMLButtonElement>(".agw-bgtask-stop");
    expect(button).not.toBeNull();
    expect(button!.disabled).toBe(false);
    // A failed stop must not swap the control for a dismiss, which would be a
    // way to lose a live process off the dock.
    expect(container.querySelector(".agw-bgtask-x")).toBeNull();
  });

  it("treats a rejected call as a failure rather than a stop", async () => {
    stopMock.mockRejectedValue(new Error("IPC died"));
    await mount();
    await clickStop();

    expect(statusOf("bg-1")).toBe("running");
    expect(container.textContent).toContain("Could not stop");
  });
});
