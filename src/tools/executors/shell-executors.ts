/**
 * Shell Tool Executors
 * Implementations for shell command tools using Tauri commands
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
const getOrCreateTerminalSession = (cwd?: string): string | null => {
  const terminal = useTerminalStore.getState();

  if (!terminal.isOpen) {
    terminal.openTerminal();
  }

  let sessionId = useTerminalStore.getState().activeSessionId;

  if (!sessionId) {
    const state = useTerminalStore.getState();

    if (state.sessions.length === 0) {
      sessionId = state.createSession(cwd);
    } else {
      sessionId = state.sessions[0].id;
      state.setActiveSession(sessionId);
    }
  }

  if (sessionId && cwd) {
    useTerminalStore.getState().updateSessionCwd(sessionId, cwd);
  }

  return sessionId;
};

const shellExecuteExecutor = async (args: Record<string, any>): Promise<string> => {
  if (!isTauri()) {
    return JSON.stringify({ success: false, error: 'Shell operations require desktop app' });
  }

  const rootPath = useWorkspaceStore.getState().rootPath;
  const cwd = args.cwd || rootPath || undefined;
  const terminalSessionId = getOrCreateTerminalSession(cwd);

  if (terminalSessionId) {
    useTerminalStore.getState().addLine(terminalSessionId, {
      type: 'input',
      content: args.command,
    });
    useTerminalStore.getState().setSessionRunning(terminalSessionId, true);
  }

  console.log('[shell_execute] Running command:', args.command, 'in:', cwd);

  try {
    const result = await executeCommand(args.command, cwd);

    if (terminalSessionId) {
      if (result.stdout?.trim()) {
        useTerminalStore.getState().addLine(terminalSessionId, {
          type: 'output',
          content: result.stdout.trimEnd(),
        });
      }
      if (result.stderr?.trim()) {
        useTerminalStore.getState().addLine(terminalSessionId, {
          type: 'error',
          content: result.stderr.trimEnd(),
        });
      }
      if (!result.success && !result.stdout && !result.stderr) {
        useTerminalStore.getState().addLine(terminalSessionId, {
          type: 'error',
          content: `Command failed with exit code: ${result.exit_code ?? 'unknown'}`,
        });
      }
    }

    if (terminalSessionId) {
      useTerminalStore.getState().setSessionRunning(terminalSessionId, false);
    }
    
    return JSON.stringify({ 
      success: result.success,
      command: args.command,
      cwd,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exit_code,
      terminalSessionId: terminalSessionId || undefined,
    });
  } catch (error) {
    console.error('[shell_execute] Error:', error);

    if (terminalSessionId) {
      useTerminalStore.getState().setSessionRunning(terminalSessionId, false);
      useTerminalStore.getState().addLine(terminalSessionId, {
        type: 'error',
        content: error instanceof Error ? error.message : String(error),
      });
    }

    return JSON.stringify({ 
      success: false, 
      error: error instanceof Error ? error.message : String(error) 
    });
  }
};

// ============================================
// SHELL SPAWN EXECUTOR (Background Process)
// ============================================
const shellSpawnExecutor = async (args: Record<string, any>): Promise<string> => {
  if (!isTauri()) {
    return JSON.stringify({ success: false, error: 'Shell operations require desktop app' });
  }

  const { command, cwd: argCwd } = args;
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

    // Execute command asynchronously
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
const shellKillExecutor = async (args: Record<string, any>): Promise<string> => {
  // Support both processId (new) and pid (legacy) parameters
  const processId = args.processId || (args.pid !== undefined ? String(args.pid) : undefined);
  const processName = args.name;

  if (!processId && !processName) {
    return JSON.stringify({ 
      success: false, 
      error: 'Either processId or name is required' 
    });
  }

  let targetProcess: BackgroundProcess | undefined;
  let targetId: string | undefined;

  if (processId) {
    // First try exact match
    targetProcess = backgroundProcesses.get(processId);
    targetId = processId;

    // If not found, try to find by partial match (for cases where only the numeric part is passed)
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
    // Find by name (command contains the name)
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

  // Mark as completed (actual process termination would need native support)
  targetProcess.status = 'completed';
  targetProcess.output.push('[terminated by user]');

  return JSON.stringify({
    success: true,
    processId: targetId,
    message: `Process ${targetId} marked for termination`,
    note: 'Full process termination requires native implementation',
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

