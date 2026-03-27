import { describe, expect, it, vi } from "vitest";

import { useTerminalStore } from "../../store/useTerminalStore";
import { useWorkspaceStore } from "../../store/useWorkspaceStore";
import { toolRegistry } from "../registry";
import { registerShellExecutors } from "./shell-executors";

type ListenerPayload = {
  data?: string;
  done?: boolean;
  exitCode?: number;
  stream?: string;
  success?: boolean;
};

type Listener = (event: { payload: ListenerPayload }) => void;

const listeners = new Map<string, Listener>();

vi.mock("@tauri-apps/api/event", () => {
  return {
    listen: vi.fn(async (eventName: string, cb: Listener) => {
      listeners.set(eventName, cb);
      return () => {
        listeners.delete(eventName);
      };
    }),
  };
});

vi.mock("../../lib/tauri", () => {
  return {
    isTauri: () => true,
    cancelCommandStream: vi.fn(async () => undefined),
    executeCommandStream: vi.fn(async (requestId: string) => {
      const onChunk = listeners.get(`shell-stream-${requestId}`);
      if (onChunk) {
        onChunk({ payload: { stream: "stdout", data: "one\n", done: false } });
        useTerminalStore.setState({ activeSessionId: "s2" });
        onChunk({ payload: { stream: "stdout", data: "two\n", done: false } });
        onChunk({ payload: { stream: "stderr", data: "err\n", done: false } });
        onChunk({
          payload: {
            stream: "meta",
            data: "",
            done: true,
            exitCode: 0,
            success: true,
          },
        });
      }
      return {
        stdout: "one\ntwo\n",
        stderr: "err\n",
        exit_code: 0,
        success: true,
      };
    }),
  };
});

describe("shell_execute modes", () => {
  it("defaults to inline mode without opening or writing to the IDE terminal", async () => {
    registerShellExecutors();

    const openTerminal = vi.fn();
    const s1Writes: string[] = [];

    useWorkspaceStore.setState({ rootPath: "C:\\" } as Partial<
      ReturnType<typeof useWorkspaceStore.getState>
    >);

    useTerminalStore.setState({
      isOpen: false,
      activeSessionId: "s1",
      sessions: [
        {
          id: "s1",
          name: "pwsh 1",
          cwd: "",
          isRunning: true,
          profile: "powershell",
          isPty: true,
          ptyConnected: true,
          cols: 80,
          rows: 24,
        },
      ],
      openTerminal,
      sessionHandlers: new Map([["s1", (d: string) => s1Writes.push(d)]]),
    } satisfies Partial<ReturnType<typeof useTerminalStore.getState>>);

    const tool = toolRegistry.getTool("shell_execute");
    expect(tool).toBeDefined();

    const result = await tool!.executor({ command: "echo test" }, "tc-inline");
    const parsed = JSON.parse(result);

    expect(parsed.success).toBe(true);
    expect(parsed.type).toBe("inline");
    expect(parsed.stdout).toBe("one\ntwo\n");
    expect(parsed.stderr).toBe("err\n");
    expect(openTerminal).not.toHaveBeenCalled();
    expect(s1Writes).toHaveLength(0);
  });

  it("writes streamed output to the initially selected terminal session when type is terminal", async () => {
    registerShellExecutors();

    const s1Writes: string[] = [];
    const s2Writes: string[] = [];

    useWorkspaceStore.setState({ rootPath: "C:\\" } as Partial<
      ReturnType<typeof useWorkspaceStore.getState>
    >);

    useTerminalStore.setState({
      isOpen: true,
      activeSessionId: "s1",
      sessions: [
        {
          id: "s1",
          name: "pwsh 1",
          cwd: "",
          isRunning: true,
          profile: "powershell",
          isPty: true,
          ptyConnected: true,
          cols: 80,
          rows: 24,
        },
        {
          id: "s2",
          name: "pwsh 2",
          cwd: "",
          isRunning: true,
          profile: "powershell",
          isPty: true,
          ptyConnected: true,
          cols: 80,
          rows: 24,
        },
      ],
      sessionHandlers: new Map([
        ["s1", (d: string) => s1Writes.push(d)],
        ["s2", (d: string) => s2Writes.push(d)],
      ]),
    } satisfies Partial<ReturnType<typeof useTerminalStore.getState>>);

    const tool = toolRegistry.getTool("shell_execute");
    expect(tool).toBeDefined();

    const result = await tool!.executor(
      { command: "echo test", type: "terminal" },
      "tc1",
    );
    const parsed = JSON.parse(result);
    expect(parsed.success).toBe(true);
    expect(parsed.type).toBe("terminal");

    const s1Text = s1Writes.join("");
    const s2Text = s2Writes.join("");

    expect(s1Text).toContain("one\n");
    expect(s1Text).toContain("two\n");
    expect(s1Text).toContain("err\n");
    expect(s2Text).not.toContain("one\n");
    expect(s2Text).not.toContain("two\n");
    expect(s2Text).not.toContain("err\n");
  });
});
