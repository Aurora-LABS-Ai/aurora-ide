/**
 * Editor Tools - Definitions
 * Tools for interacting with the code editor UI
 */
import type { ToolDefinition } from "../types";

// ============================================
// EDITOR OPEN FILE TOOL
// ============================================
export const editorOpenFileTool: ToolDefinition = {
  type: 'function',
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

// ============================================
// READ LINTS TOOL (Monaco Diagnostics)
// ============================================
export const readLintsTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'read_lints',
    description: `Read linter/diagnostic errors from files. Returns TypeScript, JavaScript, and other language errors detected by the editor.

USE THIS TOOL:
- After making code changes to check for errors
- When the user reports a bug or error
- To verify your edits didn't introduce problems

IMPORTANT:
- Only call this on files you've edited or are about to edit
- Don't call with a very wide scope (entire workspace) as it may return too many results
- If no path provided, returns diagnostics for all open files`,
    parameters: {
      type: 'object',
      properties: {
        paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of file paths to check for lint errors. If empty, checks all open files.',
        },
      },
      required: [],
    },
  },
};

// Export all editor tools as an array
export const editorTools: ToolDefinition[] = [
  editorOpenFileTool,
  readLintsTool,
];
