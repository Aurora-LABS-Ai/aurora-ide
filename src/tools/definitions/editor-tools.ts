/**
 * Editor Tools - Definitions
 * Tools for interacting with the code editor UI
 */

import type { ToolDefinition } from '../types';

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

// Export all editor tools as an array
export const editorTools: ToolDefinition[] = [
  editorOpenFileTool,
];
