import { beforeEach, describe, expect, it } from "vitest";

import { useAgentBackgroundStore } from "@/apps/agent/store/conversation/useAgentBackgroundStore";

/**
 * "Run in background" seeds a row before the ledger has been read, and that
 * row used to carry no log file. The ledger sync only adopted processes it had
 * never seen, so the panel said "not recording output to a file" for the whole
 * run while Rust was writing the log all along (2026-10-17).
 */
describe("useAgentBackgroundStore.reconcile", () => {
  beforeEach(() => {
    useAgentBackgroundStore.setState({ byThread: {} });
  });

  it("fills a known row's missing log file from the ledger", () => {
    const store = useAgentBackgroundStore.getState();
    store.track("t1", {
      processId: "shell_execute:61",
      title: "pnpm test",
      command: "pnpm test",
      status: "running",
      startedAtMs: 1,
    });

    store.reconcile("t1", [
      {
        processId: "shell_execute:61",
        title: "pnpm test",
        command: "pnpm test",
        outputFile: "C:\\logs\\shell_execute_61.log",
        status: "running",
        startedAtMs: 1,
      },
    ]);

    const row = useAgentBackgroundStore.getState().byThread.t1?.[0];
    expect(row?.outputFile).toBe("C:\\logs\\shell_execute_61.log");
    expect(row?.status).toBe("running");
  });

  it("keeps a log file the row already has", () => {
    const store = useAgentBackgroundStore.getState();
    store.track("t1", {
      processId: "bg-1",
      title: "dev server",
      command: "pnpm dev",
      outputFile: "C:\\logs\\mine.log",
      status: "running",
      startedAtMs: 1,
    });

    store.reconcile("t1", [
      {
        processId: "bg-1",
        title: "dev server",
        command: "pnpm dev",
        outputFile: "C:\\logs\\other.log",
        status: "running",
        startedAtMs: 1,
      },
    ]);

    expect(useAgentBackgroundStore.getState().byThread.t1?.[0]?.outputFile).toBe(
      "C:\\logs\\mine.log",
    );
  });
});
