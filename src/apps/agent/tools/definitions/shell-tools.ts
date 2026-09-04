/**
 * Shell Tools - Definitions
 *
 * Display and approval metadata only. The model's real schema for every tool
 * here is the Rust one (`src-tauri/src/tools/shell_editor_todo/`), which is
 * what `nativeRustOwned` means — so this file mirrors that schema rather than
 * describing a tool of its own. The `shell` argument is enumerated from the
 * user's enabled shells at runtime and cannot be listed statically here.
 */
import type { ToolDefinition } from "@/apps/agent/tools/types";

// ============================================
// SHELL EXECUTE TOOL
// ============================================
export const shellExecuteTool: ToolDefinition = {
  type: "function",
  nativeRustOwned: true,
  function: {
    name: "shell_execute",
    description:
      "Run a command in a shell, exactly as if typed at its prompt, and return what it printed with its exit code. Runs in the workspace root unless cwd says otherwise. It can change files and the system, so use it with care.",
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "The shell command to execute",
        },
        shell: {
          type: "string",
          description:
            "The shell this command is written for, chosen from the ones enabled in Settings → Tools → Shells. Required — command syntax is not portable between shells.",
        },
        cwd: {
          type: "string",
          description:
            "Working directory for the command. Defaults to workspace root.",
        },
        timeout: {
          type: "number",
          description:
            "Timeout in milliseconds. Defaults to 120000 (2 minutes), maximum 1800000 (30 minutes). On timeout the process is killed and whatever it printed comes back with timedOut: true. Use shell_spawn for work with no natural end.",
          default: 120000,
        },
      },
      required: ["command", "shell"],
    },
  },
};

// ============================================
// SHELL KILL TOOL
// ============================================
export const shellKillTool: ToolDefinition = {
  type: "function",
  nativeRustOwned: true,
  function: {
    name: "shell_kill",
    description:
      "Stop a running background process by the process ID returned from shell_spawn or shell_list_processes, its friendly name, or its OS pid.",
    parameters: {
      type: "object",
      properties: {
        processId: {
          type: "string",
          description:
            'The process ID to kill (string format, e.g., "bg-1-1234567890")',
        },
        name: {
          type: "string",
          description:
            "The friendly name of the process to kill (if processId not provided)",
        },
        requestId: {
          type: "string",
          description: "The stream request ID returned by shell_list_processes",
        },
        pid: {
          type: "number",
          description: "The OS process ID returned by shell_list_processes",
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
  type: "function",
  nativeRustOwned: true,
  function: {
    name: "shell_list_processes",
    description: "List all background processes spawned by the agent.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
  },
};

// ============================================
// SHELL SPAWN TOOL (Background process)
// ============================================
export const shellSpawnTool: ToolDefinition = {
  type: "function",
  nativeRustOwned: true,
  function: {
    name: "shell_spawn",
    description:
      "Start a long-running process in the background (a dev server, a watcher) and return a process ID. Its output is written to a file you can follow with shell_read_output; stop it with shell_kill.",
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "The shell command to spawn",
        },
        shell: {
          type: "string",
          description:
            "The shell this command is written for, chosen from the ones enabled in Settings → Tools → Shells. Required.",
        },
        cwd: {
          type: "string",
          description:
            "Working directory for the command. Defaults to workspace root.",
        },
        name: {
          type: "string",
          description:
            "One-line title shown to the user while the process runs, e.g. \"Vite dev server\". Describe what it is, not the command line.",
        },
        timeout: {
          type: "number",
          description:
            "Hard lifetime cap in milliseconds. Omit for a server you will stop yourself with shell_kill.",
        },
      },
      required: ["command", "name", "shell"],
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
