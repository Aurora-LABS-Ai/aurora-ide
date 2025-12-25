/**
 * File System Tools - Definitions
 * Tools for file operations: create, read, write, delete
 */

import type { ToolDefinition } from '../types';

// ============================================
// FILE CREATE TOOL
// ============================================
export const fileCreateTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'file_create',
    description: 'Create a new file at the specified path with optional initial content. Creates parent directories if they do not exist.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'The full path where the file should be created (e.g., "src/components/Button.tsx")',
        },
        content: {
          type: 'string',
          description: 'Initial content to write to the file. Defaults to empty string if not provided.',
          default: '',
        },
      },
      required: ['path'],
    },
  },
};

// ============================================
// FILE READ TOOL
// ============================================
export const fileReadTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'file_read',
    description: 'Read the entire content of a file at the specified path. Returns the file content as a string.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'The full path of the file to read (e.g., "src/App.tsx")',
        },
      },
      required: ['path'],
    },
  },
};

// ============================================
// FILE READ LINES TOOL
// ============================================
export const fileReadLinesTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'file_read_lines',
    description: 'Read specific lines from a file. Useful for reading portions of large files. Line numbers are 1-indexed.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'The full path of the file to read',
        },
        start_line: {
          type: 'number',
          description: 'The starting line number (1-indexed, inclusive)',
        },
        end_line: {
          type: 'number',
          description: 'The ending line number (1-indexed, inclusive). If not provided, reads to end of file.',
        },
      },
      required: ['path', 'start_line'],
    },
  },
};

// ============================================
// FILE WRITE TOOL
// ============================================
export const fileWriteTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'file_write',
    description: 'Write content to a file, completely replacing its existing content. Use file_patch for partial modifications.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'The full path of the file to write',
        },
        content: {
          type: 'string',
          description: 'The complete content to write to the file',
        },
      },
      required: ['path', 'content'],
    },
  },
};

// ============================================
// FILE PATCH TOOL (Line-specific write)
// ============================================
export const filePatchTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'file_patch',
    description: 'Apply a patch to a file by replacing specific lines or inserting content at a specific position. Line numbers are 1-indexed.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'The full path of the file to patch',
        },
        start_line: {
          type: 'number',
          description: 'The starting line number where the patch begins (1-indexed)',
        },
        end_line: {
          type: 'number',
          description: 'The ending line number where the patch ends (1-indexed, inclusive). Use same as start_line to insert without replacing.',
        },
        content: {
          type: 'string',
          description: 'The new content to insert/replace at the specified lines',
        },
      },
      required: ['path', 'start_line', 'end_line', 'content'],
    },
  },
};

// ============================================
// FILE DELETE TOOL
// ============================================
export const fileDeleteTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'file_delete',
    description: 'Delete a file at the specified path. This action is irreversible.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'The full path of the file to delete',
        },
      },
      required: ['path'],
    },
  },
};

// ============================================
// FILE EXISTS TOOL
// ============================================
export const fileExistsTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'file_exists',
    description: 'Check if a file or directory exists at the specified path.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'The path to check for existence',
        },
      },
      required: ['path'],
    },
  },
};

// ============================================
// FILE SEARCH TOOL
// ============================================
export const fileSearchTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'file_search',
    description: 'Search for a pattern (regex or plain text) within a file. Returns matching lines with line numbers.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'The full path of the file to search',
        },
        pattern: {
          type: 'string',
          description: 'The search pattern (supports regex)',
        },
        is_regex: {
          type: 'boolean',
          description: 'Whether the pattern is a regex. Defaults to false (plain text search).',
          default: false,
        },
      },
      required: ['path', 'pattern'],
    },
  },
};

// Export all file tools as an array
export const fileTools: ToolDefinition[] = [
  fileCreateTool,
  fileReadTool,
  fileReadLinesTool,
  fileWriteTool,
  filePatchTool,
  fileDeleteTool,
  fileExistsTool,
  fileSearchTool,
];

