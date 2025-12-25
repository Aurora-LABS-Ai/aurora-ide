/**
 * Shell Tool Executors
 * Implementations for shell command tools using Tauri commands
 */

import { toolRegistry } from '../registry';
import { isTauri, executeCommand } from '../../lib/tauri';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';

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
const shellExecuteExecutor = async (args: Record<string, any>): Promise<string> => {
  if (!isTauri()) {
    return JSON.stringify({ success: false, error: 'Shell operations require desktop app' });
  }

  const rootPath = useWorkspaceStore.getState().rootPath;
  const cwd = args.cwd || rootPath || undefined;
  
  console.log('[shell_execute] Running command:', args.command, 'in:', cwd);

  try {
    const result = await executeCommand(args.command, cwd);
    
    return JSON.stringify({ 
      success: result.success,
      command: args.command,
      cwd,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exit_code
    });
  } catch (error) {
    console.error('[shell_execute] Error:', error);
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
  const { processId } = args;

  if (!processId) {
    return JSON.stringify({ success: false, error: 'Process ID is required' });
  }

  const process = backgroundProcesses.get(processId);
  
  if (!process) {
    return JSON.stringify({
      success: false,
      error: `Process not found: ${processId}`,
    });
  }

  // Mark as completed (actual process termination would need native support)
  process.status = 'completed';
  process.output.push('[terminated by user]');

  return JSON.stringify({
    success: true,
    processId,
    message: `Process ${processId} marked for termination`,
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

