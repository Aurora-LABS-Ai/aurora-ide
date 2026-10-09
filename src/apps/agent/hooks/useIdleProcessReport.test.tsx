/**
 * When an idle conversation is woken by a background process, and when it isn't.
 *
 * The whole value of this is in the conditions. Firing too eagerly interrupts
 * someone mid-sentence with news about a build; never firing is what left the
 * agent certain a test run was still going twenty minutes after it failed.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SendOutcome } from "@/apps/agent/hooks/conversation/send-outcome";
import {
  clearProcessReportFlights,
  useIdleProcessReport,
} from "@/apps/agent/hooks/useIdleProcessReport";
import { clearIdleReports } from "@/apps/agent/hooks/useBackgroundProcessWatch";
import { useAgentChatStore } from "@/apps/agent/store/conversation/useAgentChatStore";
import { useAgentDraftStore } from "@/apps/agent/store/conversation/useAgentDraftStore";
import { useAgentBackgroundStore } from "@/apps/agent/store/conversation/useAgentBackgroundStore";

const listeners = new Set<(event: { payload: unknown }) => void>();
vi.mock("@/kernel/lib/ipc/runtime", () => ({
  auroraInvoke: vi.fn(() => Promise.reject(new Error("no runtime in tests"))),
  auroraListen: vi.fn((_name: string, handler: (event: { payload: unknown }) => void) => {
    listeners.add(handler);
    return Promise.resolve(() => listeners.delete(handler));
  }),
}));

const THREAD = "thread-1";
const send = vi.fn<(text: string, summary: string) => Promise<SendOutcome>>(() =>
  Promise.resolve("started"),
);

/** Mounts the watch (which parks endings) and the drain (which sends them). */
const Harness = () => {
  useBackgroundProcessWatchForTest(THREAD);
  useIdleProcessReport(THREAD, send);
  return null;
};

// Imported lazily so the mock above is installed first.
let useBackgroundProcessWatchForTest: (threadId: string | null) => void;

const seedRunning = () => {
  useAgentBackgroundStore.setState({
    byThread: {
      [THREAD]: [
        {
          processId: "bg-1",
          title: "pnpm test",
          command: "pnpm test",
          status: "running",
          startedAtMs: 0,
          outputFile: "C:/tmp/x.log",
        },
      ],
    },
  });
};

/** Rust announcing the ending on its app-wide event. */
const endProcess = async (exitCode: number | null = 1, processId = "bg-1") => {
  await act(async () => {
    listeners.forEach((handler) =>
      handler({ payload: { processId, exitCode, outcome: "exited" } }),
    );
    await Promise.resolve();
  });
};

describe("waking an idle conversation for a finished process", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  const mount = async () => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
      .IS_REACT_ACT_ENVIRONMENT = true;
    await act(async () => {
      root = createRoot(container);
      root.render(<Harness />);
    });
  };

  beforeEach(async () => {
    ({ useBackgroundProcessWatch: useBackgroundProcessWatchForTest } = await import(
      "@/apps/agent/hooks/useBackgroundProcessWatch"
    ));
    container = document.createElement("div");
    document.body.appendChild(container);
    listeners.clear();
    clearIdleReports();
    clearProcessReportFlights();
    send.mockClear();
    send.mockImplementation(() => Promise.resolve("started"));
    useAgentChatStore.setState({
      currentThreadId: THREAD,
      liveTurns: {},
      queuedByThread: {},
    });
    useAgentDraftStore.setState({ drafts: {} });
    seedRunning();
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container.remove();
  });

  it("starts a turn when nothing is running", async () => {
    await mount();
    await endProcess(1);

    expect(send).toHaveBeenCalledTimes(1);
    const [detail, summary] = send.mock.calls[0];
    // The model gets the id and the log path, because its useful next move is
    // shell_read_output and it cannot make that call out of prose.
    expect(detail).toContain("bg-1");
    expect(detail).toContain("exit code 1");
    expect(detail).toContain("shell_read_output");
    // The transcript gets one line.
    expect(summary).toBe("Failed pnpm test · exit 1");
  });

  it("stays quiet while a turn is already running", async () => {
    useAgentChatStore.setState({ liveTurns: { [THREAD]: { id: THREAD } as never } });
    await mount();
    await endProcess(0);

    // The mid-turn path owns this one — it queues into the running turn.
    expect(send).not.toHaveBeenCalled();
  });

  it("waits while the person is typing", async () => {
    useAgentDraftStore.setState({ drafts: { [THREAD]: "what about the " } });
    await mount();
    await endProcess(0);

    expect(send).not.toHaveBeenCalled();
  });

  it("waits while the person already has a message queued", async () => {
    useAgentChatStore.setState({
      queuedByThread: { [THREAD]: { text: "hold on", queuedAt: Date.now() } as never },
    });
    await mount();
    await endProcess(0);

    expect(send).not.toHaveBeenCalled();
  });

  it("announces a report parked earlier once the conversation frees up", async () => {
    useAgentDraftStore.setState({ drafts: { [THREAD]: "typing" } });
    await mount();
    await endProcess(0);
    expect(send).not.toHaveBeenCalled();

    // They sent it, the composer is empty again.
    await act(async () => {
      useAgentDraftStore.setState({ drafts: {} });
      useAgentChatStore.setState({ liveTurns: {} });
      await Promise.resolve();
    });

    expect(send).toHaveBeenCalledTimes(1);
  });

  it("folds two endings into one turn rather than two", async () => {
    useAgentDraftStore.setState({ drafts: { [THREAD]: "typing" } });
    await mount();
    await endProcess(0);
    await endProcess(1);

    await act(async () => {
      useAgentDraftStore.setState({ drafts: {} });
      useAgentChatStore.setState({ liveTurns: {} });
      await Promise.resolve();
    });

    expect(send).toHaveBeenCalledTimes(1);
    const [detail] = send.mock.calls[0];
    // Both endings are in it, in the order they happened.
    expect(detail.match(/has ended/g)).toHaveLength(2);
  });

  it("keeps the report when the send did not open a turn, and sends it at the next idle moment", async () => {
    // The pipeline awaits before it marks the turn live; a turn that opens in
    // that window makes the send return `skipped`. The report used to be
    // taken already and gone.
    send.mockImplementationOnce(() => Promise.resolve("skipped"));
    await mount();
    await endProcess(1);
    expect(send).toHaveBeenCalledTimes(1);

    // The other turn runs and ends.
    await act(async () => {
      useAgentChatStore.setState({ liveTurns: { [THREAD]: { id: THREAD } as never } });
      await Promise.resolve();
      useAgentChatStore.setState({ liveTurns: {} });
      await Promise.resolve();
    });

    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1][0]).toContain("bg-1");
  });

  it("holds the next report while a send is still in flight", async () => {
    // Every chat-store change re-runs the drain. While the first send has
    // not settled the turn is not live yet, so a second drain used to take a
    // second report and race it. Both finished processes must still arrive.
    let settleFirst: (outcome: SendOutcome) => void = () => {};
    send.mockImplementationOnce(
      () =>
        new Promise<SendOutcome>((resolve) => {
          settleFirst = resolve;
        }),
    );
    useAgentBackgroundStore.setState({
      byThread: {
        [THREAD]: [
          {
            processId: "bg-1",
            title: "pnpm test",
            command: "pnpm test",
            status: "running",
            startedAtMs: 0,
            outputFile: "C:/tmp/x.log",
          },
          {
            processId: "bg-2",
            title: "pnpm lint",
            command: "pnpm lint",
            status: "running",
            startedAtMs: 0,
            outputFile: "C:/tmp/y.log",
          },
        ],
      },
    });
    await mount();
    await endProcess(1);
    expect(send).toHaveBeenCalledTimes(1);

    // A second ending lands and the store churns while the first send waits.
    await endProcess(0, "bg-2");
    await act(async () => {
      useAgentChatStore.setState({ sending: true } as never);
      await Promise.resolve();
    });
    expect(send).toHaveBeenCalledTimes(1);

    // The first turn opens, runs, ends: the second report goes now.
    await act(async () => {
      useAgentChatStore.setState({ liveTurns: { [THREAD]: { id: THREAD } as never } });
      settleFirst("started");
      for (let i = 0; i < 6; i += 1) await Promise.resolve();
    });
    expect(send).toHaveBeenCalledTimes(1);
    await act(async () => {
      useAgentChatStore.setState({ liveTurns: {} });
      for (let i = 0; i < 6; i += 1) await Promise.resolve();
    });
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1][0]).toContain("bg-2");
  });

  it("sends nothing at all when no process was ever tracked", async () => {
    useAgentBackgroundStore.setState({ byThread: {} });
    await mount();
    await endProcess(0);

    // Every foreground shell_execute announces on this same channel. Only what
    // the process list holds is a background process.
    expect(send).not.toHaveBeenCalled();
  });
});
