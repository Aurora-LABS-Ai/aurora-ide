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
// GREP TOOL (Ripgrep-style search)
// ============================================
export const grepTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'grep',
    description: `Search for patterns in files using regex. Built on ripgrep for speed.

Usage:
- Use for exact symbol/string searches across the codebase
- Supports full regex syntax (e.g., "log.*Error", "function\\s+\\w+")
- Respects .gitignore by default
- Output modes: "content" (default), "files_with_matches", "count"

Examples:
- grep(pattern="TODO", path="src/") - Find all TODOs in src
- grep(pattern="function.*export", path=".", is_regex=true) - Find exported functions
- grep(pattern="import.*react", path=".", case_insensitive=true) - Case-insensitive`,
    parameters: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'The search pattern. Supports regex syntax if is_regex is true.',
        },
        path: {
          type: 'string',
          description: 'Path to search in. Can be a file or directory. Defaults to workspace root.',
          default: '.',
        },
        output_mode: {
          type: 'string',
          enum: ['content', 'files_with_matches', 'count'],
          description: 'Output mode: "content" shows matching lines, "files_with_matches" shows file paths only, "count" shows match counts per file.',
          default: 'content',
        },
        is_regex: {
          type: 'boolean',
          description: 'Whether to treat pattern as regex. Default: true',
          default: true,
        },
        case_insensitive: {
          type: 'boolean',
          description: 'Case-insensitive search. Default: false',
          default: false,
        },
        glob: {
          type: 'string',
          description: 'Glob pattern to filter files (e.g., "*.ts", "*.{js,jsx}")',
        },
        context_lines: {
          type: 'number',
          description: 'Number of context lines before and after match. Default: 0',
          default: 0,
        },
        max_results: {
          type: 'number',
          description: 'Maximum number of results to return. Default: 50',
          default: 50,
        },
      },
      required: ['pattern'],
    },
  },
};

// ============================================
// MULTI FILE READ TOOL (Cursor-style parallel reading)
// ============================================
export const multiFileReadTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'multi_file_read',
    description: `Read multiple files in parallel (10-100x faster than reading files one by one).

USE THIS TOOL when you need to read 2 or more files at once. This is significantly faster than calling file_read multiple times.

Examples:
- multi_file_read(paths=["src/App.tsx", "src/main.tsx", "src/types/index.ts"])
- multi_file_read(paths=["package.json", "tsconfig.json", "vite.config.ts"])

Returns: JSON with file contents, errors, and performance metrics.`,
    parameters: {
      type: 'object',
      properties: {
        paths: {
          type: 'array',
          items: {
            type: 'string',
          },
          description: 'Array of file paths to read. All files will be read in parallel for maximum speed.',
        },
      },
      required: ['paths'],
    },
  },
};

// Export all file tools as an array
export const fileTools: ToolDefinition[] = [
  fileCreateTool,
  fileReadTool,
  fileWriteTool,
  filePatchTool,
  fileDeleteTool,
  grepTool,
  multiFileReadTool,
];
