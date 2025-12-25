/**
 * Shell Tool Executors
 * Implementations for shell command tools using Tauri commands
 */

import { toolRegistry } from '../registry';
import { isTauri, executeCommand } from '../../lib/tauri';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';

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
// REGISTER ALL SHELL EXECUTORS
// ============================================
export const registerShellExecutors = (): void => {
  toolRegistry.registerExecutor('shell_execute', shellExecuteExecutor);
};

