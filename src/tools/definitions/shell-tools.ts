/**
 * Shell Tools - Definitions
 * Tools for executing shell commands and terminal operations
 */

import type { ToolDefinition } from '../types';

// ============================================
// SHELL EXECUTE TOOL
// ============================================
export const shellExecuteTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'shell_execute',
    description: 'Execute a shell command in the workspace directory. Returns stdout, stderr, and exit code. Use with caution as this can modify the system.',
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'The shell command to execute',
        },
        cwd: {
          type: 'string',
          description: 'Working directory for the command. Defaults to workspace root.',
        },
        timeout: {
          type: 'number',
          description: 'Timeout in milliseconds. Defaults to 30000 (30 seconds).',
          default: 30000,
        },
      },
      required: ['command'],
    },
  },
};

// ============================================
// SHELL SPAWN TOOL (Background process)
// ============================================
export const shellSpawnTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'shell_spawn',
    description: 'Spawn a long-running background process (e.g., dev server, watch process). Returns a process ID for later management.',
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'The shell command to spawn',
        },
        cwd: {
          type: 'string',
          description: 'Working directory for the command. Defaults to workspace root.',
        },
        name: {
          type: 'string',
          description: 'A friendly name for this process for later reference',
        },
      },
      required: ['command'],
    },
  },
};

// ============================================
// SHELL KILL TOOL
// ============================================
export const shellKillTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'shell_kill',
    description: 'Kill a running background process by its process ID or name.',
    parameters: {
      type: 'object',
      properties: {
        pid: {
          type: 'number',
          description: 'The process ID to kill',
        },
        name: {
          type: 'string',
          description: 'The friendly name of the process to kill (if pid not provided)',
        },
      },
      required: [],
    },
  },
};

// ============================================
// SHELL LIST PROCESSES TOOL
// ============================================
export const shellListProcessesTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'shell_list_processes',
    description: 'List all background processes spawned by the agent.',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
};

// Export all shell tools as an array
export const shellTools: ToolDefinition[] = [
  shellExecuteTool,
  shellSpawnTool,
  shellKillTool,
  shellListProcessesTool,
];

