/**
 * Shell Tool Executors
 * Implementations for shell command tools using Tauri commands
 * Uses standard executeCommand for agent tool calls (simpler, no PTY needed)
 */
import {
  cancelCommandStream,
  executeCommandStream,
  isTauri,
} from "../../lib/tauri";
import { listen } from "@tauri-apps/api/event";
import { useTerminalStore } from "../../store/useTerminalStore";
import { useWorkspaceStore } from "../../store/useWorkspaceStore";
import { toolRegistry } from "../registry";

// Track background processes
interface BackgroundProcess {
  command: string;
  cwd: string;
  id: string;
  output: string[];
  requestId?: string;
  startedAt: number;
  status: "running" | "completed" | "failed";
}

type ShellStreamName = "stdout" | "stderr";

interface ShellStreamChunk {
  data: string;
  done: boolean;
  exitCode?: number | null;
  stream: ShellStreamName;
  success?: boolean;
}

type ShellExecuteMode = "inline" | "terminal";

const getRequestId = (): string => {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `req-${Math.random().toString(36).slice(2)}-${Date.now()}`;
};

const getShellExecuteMode = (value: unknown): ShellExecuteMode =>
  value === "terminal" ? "terminal" : "inline";

const executeInlineShellCommand = async (
  command: string,
  cwd: string | undefined,
  timeoutMs: number,
): Promise<string> => {
  try {
    const result = await executeCommandStream(
      getRequestId(),
      command,
      cwd,
      undefined,
      timeoutMs,
    );

    return JSON.stringify({
      success: result.success,
      type: "inline",
      command,
      cwd,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exit_code,
    });
  } catch (error) {
    console.error("[shell_execute:inline] Error:", error);
    const errorMsg = error instanceof Error ? error.message : String(error);

    return JSON.stringify({
      success: false,
      type: "inline",
      command,
      cwd,
      error: errorMsg,
    });
  }
};

const executeTerminalShellCommand = async (
  command: string,
  cwd: string | undefined,
  timeoutMs: number,
): Promise<string> => {
  // Open terminal to show activity
  const terminal = useTerminalStore.getState();
  if (!terminal.isOpen) {
    terminal.openTerminal();
  }

  const targetSessionId = useTerminalStore.getState().activeSessionId;
  if (!targetSessionId) {
    return JSON.stringify({
      success: false,
      type: "terminal",
      command,
      cwd,
      error: "No active terminal session available",
    });
  }

  const pendingWrites: string[] = [];

  const writeOutput = (data: string) => {
    const state = useTerminalStore.getState();
    const handler = state.sessionHandlers.get(targetSessionId);
    if (handler) {
      if (pendingWrites.length > 0) {
        for (const chunk of pendingWrites) {
          handler(chunk);
        }
        pendingWrites.length = 0;
      }
      handler(data);
      return;
    }
    pendingWrites.push(data);
  };

  const flushPending = () => {
    if (pendingWrites.length === 0) return;
    const state = useTerminalStore.getState();
    const handler = state.sessionHandlers.get(targetSessionId);
    if (!handler) return;

    for (const chunk of pendingWrites) {
      handler(chunk);
    }
    pendingWrites.length = 0;
  };

  const waitForSessionHandler = async (maxWaitMs = 3000): Promise<boolean> => {
    const startTime = Date.now();
    while (Date.now() - startTime < maxWaitMs) {
      const state = useTerminalStore.getState();

      if (state.sessionHandlers.has(targetSessionId)) {
        return true;
      }

      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    return false;
  };

  await waitForSessionHandler();
  flushPending();

  const green = "\x1b[32m";
  const reset = "\x1b[0m";
  const dim = "\x1b[2m";
  const red = "\x1b[31m";
  const yellow = "\x1b[33m";

  writeOutput(
    `\r\n${green}[Aurora]${reset} ${command} ${dim}(in ${cwd || "root"})${reset}\r\n`,
  );

  const requestId = getRequestId();
  const streamEvent = `shell-stream-${requestId}`;
  const streamErrorEvent = `shell-stream-error-${requestId}`;
  let unlisten: (() => void) | null = null;
  let unlistenError: (() => void) | null = null;

  try {
    unlisten = await listen<ShellStreamChunk>(streamEvent, (event) => {
      const payload = event.payload;
      if (!payload || payload.done) return;

      if (payload.stream === "stderr") {
        writeOutput(`${yellow}${payload.data}${reset}`);
      } else {
        writeOutput(payload.data);
      }
    });

    unlistenError = await listen<string>(streamErrorEvent, (event) => {
      const msg = event.payload;
      if (!msg) return;
      writeOutput(`${red}${msg}${reset}\r\n`);
    });

    const result = await executeCommandStream(
      requestId,
      command,
      cwd,
      undefined,
      timeoutMs,
    );

    if (result.exit_code !== 0) {
      writeOutput(
        `${red}Command failed with exit code ${result.exit_code}${reset}\r\n`,
      );
    }

    writeOutput(`${dim}[Done]${reset}\r\n`);

    return JSON.stringify({
      success: result.success,
      type: "terminal",
      command,
      cwd,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exit_code,
    });
  } catch (error) {
    console.error("[shell_execute:terminal] Error:", error);
    const errorMsg = error instanceof Error ? error.message : String(error);

    writeOutput(`${red}Execution Error: ${errorMsg}${reset}\r\n`);

    return JSON.stringify({
      success: false,
      type: "terminal",
      command,
      cwd,
      error: errorMsg,
    });
  } finally {
    if (unlisten) {
      try {
        unlisten();
      } catch (e) {
        console.warn(
          "[shell_execute] Failed to remove shell stream listener",
          e,
        );
      }
    }
    if (unlistenError) {
      try {
        unlistenError();
      } catch (e) {
        console.warn(
          "[shell_execute] Failed to remove shell stream error listener",
          e,
        );
      }
    }
  }
};

// ============================================
// SHELL EXECUTE EXECUTOR
// ============================================
const shellExecuteExecutor = async (
  args: Record<string, unknown>,
): Promise<string> => {
  if (!isTauri()) {
    return JSON.stringify({
      success: false,
      error: "Shell operations require desktop app",
    });
  }

  const command = args.command as string;
  const rootPath = useWorkspaceStore.getState().rootPath;
  const cwd = (args.cwd as string) || rootPath || undefined;
  const timeoutMs =
    typeof args.timeout === "number" ? (args.timeout as number) : 30000;
  const mode = getShellExecuteMode(args.type);

  console.log(
    "[shell_execute] Running command:",
    command,
    "in:",
    cwd,
    "mode:",
    mode,
  );

  if (mode === "terminal") {
    return executeTerminalShellCommand(command, cwd, timeoutMs);
  }

  return executeInlineShellCommand(command, cwd, timeoutMs);
};

// ============================================
// SHELL KILL EXECUTOR
// ============================================
const shellKillExecutor = async (
  args: Record<string, unknown>,
): Promise<string> => {
  const processId =
    (args.processId as string) ||
    (args.pid !== undefined ? String(args.pid) : undefined);
  const processName = args.name as string | undefined;

  if (!processId && !processName) {
    return JSON.stringify({
      success: false,
      error: "Either processId or name is required",
    });
  }

  let targetProcess: BackgroundProcess | undefined;
  let targetId: string | undefined;

  if (processId) {
    targetProcess = backgroundProcesses.get(processId);
    targetId = processId;

    if (!targetProcess) {
      for (const [id, proc] of backgroundProcesses.entries()) {
        if (id.includes(processId) || id.endsWith(`-${processId}`)) {
          targetProcess = proc;
          targetId = id;
          break;
        }
      }
    }
  } else if (processName) {
    for (const [id, proc] of backgroundProcesses.entries()) {
      if (proc.command.includes(processName)) {
        targetProcess = proc;
        targetId = id;
        break;
      }
    }
  }

  if (!targetProcess || !targetId) {
    const identifier = processId || processName;
    return JSON.stringify({
      success: false,
      error: `Process not found: ${identifier}`,
      availableProcesses: Array.from(backgroundProcesses.keys()),
    });
  }

  if (targetProcess.status === "running" && targetProcess.requestId) {
    try {
      await cancelCommandStream(targetProcess.requestId);
    } catch (e) {
      console.warn("[shell_kill] Failed to cancel command stream", e);
    }
  }

  targetProcess.status = "completed";
  targetProcess.output.push("[terminated by user]");

  return JSON.stringify({
    success: true,
    processId: targetId,
    message: `Process ${targetId} marked as terminated`,
  });
};

// ============================================
// SHELL LIST PROCESSES EXECUTOR
// ============================================
const shellListProcessesExecutor = async (): Promise<string> => {
  const processes = Array.from(backgroundProcesses.values()).map((proc) => ({
    id: proc.id,
    command: proc.command,
    cwd: proc.cwd,
    status: proc.status,
    startedAt: new Date(proc.startedAt).toISOString(),
    outputLines: proc.output.length,
  }));

  return JSON.stringify({
    success: true,
    count: processes.length,
    processes,
  });
};

// ============================================
// SHELL SPAWN EXECUTOR (Background Process)
// ============================================
const shellSpawnExecutor = async (
  args: Record<string, unknown>,
): Promise<string> => {
  if (!isTauri()) {
    return JSON.stringify({
      success: false,
      error: "Shell operations require desktop app",
    });
  }

  const command = args.command as string;
  const argCwd = args.cwd as string | undefined;
  const rootPath = useWorkspaceStore.getState().rootPath;
  const cwd = argCwd || rootPath || "";

  if (!command) {
    return JSON.stringify({ success: false, error: "Command is required" });
  }

  try {
    // Generate unique process ID
    const processId = `bg-${++processIdCounter}-${Date.now()}`;
    const requestId = getRequestId();

    // Create process record
    const process: BackgroundProcess = {
      id: processId,
      command,
      cwd,
      startedAt: Date.now(),
      status: "running",
      output: [],
      requestId,
    };

    backgroundProcesses.set(processId, process);

    // Execute in background
    executeCommandStream(requestId, command, cwd)
      .then((result) => {
        const proc = backgroundProcesses.get(processId);
        if (proc) {
          proc.status = result.success ? "completed" : "failed";
          proc.output.push(result.stdout || "");
          if (result.stderr) {
            proc.output.push(`[stderr] ${result.stderr}`);
          }
        }
      })
      .catch((error) => {
        const proc = backgroundProcesses.get(processId);
        if (proc) {
          proc.status = "failed";
          proc.output.push(`[error] ${error.message || String(error)}`);
        }
      });

    return JSON.stringify({
      success: true,
      processId,
      command,
      cwd,
      message: `Background process started with ID: ${processId}`,
    });
  } catch (error) {
    console.error("[shell_spawn] Error:", error);
    return JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

// ============================================
// REGISTER ALL SHELL EXECUTORS
// ============================================
export const registerShellExecutors = (): void => {
  toolRegistry.registerExecutor("shell_execute", shellExecuteExecutor);
  toolRegistry.registerExecutor("shell_spawn", shellSpawnExecutor);
  toolRegistry.registerExecutor("shell_kill", shellKillExecutor);
  toolRegistry.registerExecutor(
    "shell_list_processes",
    shellListProcessesExecutor,
  );
};

const backgroundProcesses: Map<string, BackgroundProcess> = new Map();

let processIdCounter = 0;
