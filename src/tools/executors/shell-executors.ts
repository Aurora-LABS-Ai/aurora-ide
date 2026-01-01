/**
 * Shell Tool Executors
 * Implementations for shell command tools using Tauri commands
 * Uses standard executeCommand for agent tool calls (simpler, no PTY needed)
 */

import { toolRegistry } from '../registry';
import { isTauri, executeCommand } from '../../lib/tauri';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { useTerminalStore } from '../../store/useTerminalStore';

// Track background processes
interface BackgroundProcess {
  id: string;
  command: string;
  cwd: string;
  startedAt: number;
  status: 'running' | 'completed' | 'failed';
  output: string[];
}

const backgroundProcesses: Map<string, BackgroundProcess> = new Map();
let processIdCounter = 0;

// ============================================
// SHELL EXECUTE EXECUTOR
// ============================================
const shellExecuteExecutor = async (args: Record<string, unknown>): Promise<string> => {
  if (!isTauri()) {
    return JSON.stringify({ success: false, error: 'Shell operations require desktop app' });
  }

  const command = args.command as string;
  const rootPath = useWorkspaceStore.getState().rootPath;
  const cwd = (args.cwd as string) || rootPath || undefined;

  console.log('[shell_execute] Running command:', command, 'in:', cwd);

  // Open terminal to show activity
  const terminal = useTerminalStore.getState();
  if (!terminal.isOpen) {
    terminal.openTerminal();
  }
  
  // Ensure we have an active session and wait for handler to be registered
  const waitForTerminalReady = async (maxWaitMs = 3000): Promise<boolean> => {
    const startTime = Date.now();
    while (Date.now() - startTime < maxWaitMs) {
      const state = useTerminalStore.getState();
      const { activeSessionId, sessionHandlers } = state;
      
      // Check if we have an active session with a registered handler
      if (activeSessionId && sessionHandlers.has(activeSessionId)) {
        return true;
      }
      
      // Wait a bit before checking again
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    return false;
  };
  
  await waitForTerminalReady();

  // Get fresh reference to write handler after waiting
  const writeOutput = (data: string) => {
    const state = useTerminalStore.getState();
    const { activeSessionId, sessionHandlers } = state;
    
    if (activeSessionId && sessionHandlers.has(activeSessionId)) {
      const handler = sessionHandlers.get(activeSessionId);
      handler?.(data);
    }
  };

  // formatted output with colors
  const green = '\x1b[32m';
  const reset = '\x1b[0m';
  const dim = '\x1b[2m';
  const red = '\x1b[31m';
  const yellow = '\x1b[33m';

  // Echo command
  writeOutput(`\r\n${green}[Aurora]${reset} ${command} ${dim}(in ${cwd || 'root'})${reset}\r\n`);

  try {
    const result = await executeCommand(command, cwd);

    // Echo Output
    if (result.stdout) {
      // Normalize line endings
      const normalized = result.stdout.replace(/\n/g, '\r\n');
      writeOutput(normalized);
      if (!normalized.endsWith('\n')) writeOutput('\r\n');
    }

    if (result.stderr) {
      const normalized = result.stderr.replace(/\n/g, '\r\n');
      writeOutput(`${yellow}${normalized}${reset}`);
      if (!normalized.endsWith('\n')) writeOutput('\r\n');
    }

    if (result.exit_code !== 0) {
      writeOutput(`${red}Command failed with exit code ${result.exit_code}${reset}\r\n`);
    }
    
    // Add a completion marker
    writeOutput(`${dim}[Done]${reset}\r\n`);

    return JSON.stringify({
      success: result.success,
      command,
      cwd,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exit_code,
    });
  } catch (error) {
    console.error('[shell_execute] Error:', error);
    const errorMsg = error instanceof Error ? error.message : String(error);

    writeOutput(`${red}Execution Error: ${errorMsg}${reset}\r\n`);

    return JSON.stringify({
      success: false,
      error: errorMsg,
    });
  }
};

// ============================================
// SHELL SPAWN EXECUTOR (Background Process)
// ============================================
const shellSpawnExecutor = async (args: Record<string, unknown>): Promise<string> => {
  if (!isTauri()) {
    return JSON.stringify({ success: false, error: 'Shell operations require desktop app' });
  }

  const command = args.command as string;
  const argCwd = args.cwd as string | undefined;
  const rootPath = useWorkspaceStore.getState().rootPath;
  const cwd = argCwd || rootPath || '';

  if (!command) {
    return JSON.stringify({ success: false, error: 'Command is required' });
  }

  try {
    // Generate unique process ID
    const processId = `bg-${++processIdCounter}-${Date.now()}`;

    // Create process record
    const process: BackgroundProcess = {
      id: processId,
      command,
      cwd,
      startedAt: Date.now(),
      status: 'running',
      output: [],
    };

    backgroundProcesses.set(processId, process);

    // Execute in background
    executeCommand(command, cwd).then(result => {
      const proc = backgroundProcesses.get(processId);
      if (proc) {
        proc.status = result.success ? 'completed' : 'failed';
        proc.output.push(result.stdout || '');
        if (result.stderr) {
          proc.output.push(`[stderr] ${result.stderr}`);
        }
      }
    }).catch(error => {
      const proc = backgroundProcesses.get(processId);
      if (proc) {
        proc.status = 'failed';
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
    console.error('[shell_spawn] Error:', error);
    return JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

// ============================================
// SHELL KILL EXECUTOR
// ============================================
const shellKillExecutor = async (args: Record<string, unknown>): Promise<string> => {
  const processId = (args.processId as string) || (args.pid !== undefined ? String(args.pid) : undefined);
  const processName = args.name as string | undefined;

  if (!processId && !processName) {
    return JSON.stringify({
      success: false,
      error: 'Either processId or name is required'
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

  targetProcess.status = 'completed';
  targetProcess.output.push('[terminated by user]');

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
  const processes = Array.from(backgroundProcesses.values()).map(proc => ({
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
// REGISTER ALL SHELL EXECUTORS
// ============================================
export const registerShellExecutors = (): void => {
  toolRegistry.registerExecutor('shell_execute', shellExecuteExecutor);
  toolRegistry.registerExecutor('shell_spawn', shellSpawnExecutor);
  toolRegistry.registerExecutor('shell_kill', shellKillExecutor);
  toolRegistry.registerExecutor('shell_list_processes', shellListProcessesExecutor);
};
