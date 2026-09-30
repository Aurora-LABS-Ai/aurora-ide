/**
 * Editor Tools - Definitions
 * Tools for interacting with the code editor UI
 */
import type { ToolDefinition } from "@/apps/agent/tools/types";

// ============================================
// EDITOR OPEN FILE TOOL
// ============================================
export const editorOpenFileTool: ToolDefinition = {
  type: 'function',
  nativeRustOwned: true,
  function: {
    name: 'editor_open_file',
    description: 'Open a file in the code editor. Optionally navigate to a specific line. Use this to show important files to the user.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'The full path of the file to open',
        },
        line: {
          type: 'number',
          description: 'Line number to navigate to (1-indexed)',
        },
        column: {
          type: 'number',
          description: 'Column number to navigate to (1-indexed)',
        },
      },
      required: ['path'],
    },
  },
};

// There is no `read_lints` tool any more (2026-09-29). It wrapped the
// project's own checkers and summarised a checker that never ran as a clean
// result. The agent runs the project's check command with `shell_execute`
// and reads the raw output; the rule lives in the system prompt.

// Export all editor tools as an array
export const editorTools: ToolDefinition[] = [
  editorOpenFileTool,
];
