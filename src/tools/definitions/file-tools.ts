/**
 * File System Tools - Definitions
 * Tools for file operations: create, read, write, delete
 */
import type { ToolDefinition } from "../types";

// ============================================
// FILE CREATE TOOL
// ============================================
export const fileCreateTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'file_create',
    description: `Create a NEW file that does not exist yet. Creates parent directories automatically if needed.

WHEN TO USE file_create:
- Creating a brand new file that doesn't exist
- Setting up new components, modules, or config files

WHEN NOT TO USE:
- If the file already exists (use file_write or file_patch instead)
- For editing existing files

NOTE: This tool will FAIL if the file already exists. Use file_write to overwrite existing files.`,
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'The full path where the NEW file should be created (e.g., "src/components/Button.tsx")',
        },
        content: {
          type: 'string',
          description: 'The initial content for the new file. Defaults to empty string if not provided.',
          default: '',
        },
      },
      required: ['path'],
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
    description: `COMPLETELY REPLACE the entire content of a file. This tool OVERWRITES the whole file.

WHEN TO USE file_write:
- Creating a new file with content
- Rewriting an entire file from scratch
- When changes are so extensive that replacing the whole file is cleaner
- When you need to restructure the entire file

WHEN NOT TO USE (use file_patch instead):
- Making small edits to specific lines
- Changing a few lines in a large file
- Fixing a bug in one function
- Adding/removing a single import

WARNING: This replaces ALL content. The entire file content must be provided.`,
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'The full path of the file to write',
        },
        content: {
          type: 'string',
          description: 'The COMPLETE new content for the file. This will REPLACE everything in the file.',
        },
      },
      required: ['path', 'content'],
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
    description: `Search the codebase for exact text or regex patterns using real ripgrep.

Usage:
- Use for exact symbol or string searches across the codebase
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

// ============================================
// SEARCH REPLACE TOOL (Cursor-style exact string replacement)
// ============================================
export const searchReplaceTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'search_replace',
    description: `Find and replace exact text in a file. This is the PREFERRED tool for making targeted edits.

HOW IT WORKS:
1. Provide the EXACT text you want to find (old_string)
2. Provide the text you want to replace it with (new_string)
3. The tool finds the old_string and replaces it with new_string

IMPORTANT RULES:
- old_string MUST match the current file content exactly for indentation and surrounding code
- Line ending differences (LF vs CRLF) are handled automatically
- old_string must be UNIQUE in the file (appears only once)
- Include enough context (3-5 lines before/after) to make old_string unique
- new_string replaces old_string completely

WHEN TO USE search_replace:
- Editing specific functions or code blocks
- Fixing bugs in specific locations
- Adding/modifying/removing imports
- Changing variable names or values
- Any targeted edit

WHEN NOT TO USE (use file_write instead):
- Creating a new file
- Rewriting the entire file from scratch
- When the text to find appears multiple times (use replace_all=true or be more specific)

EXAMPLE:
To change a function, provide the EXACT current function as old_string:

old_string:
"function hello() {
  return 'Hello';
}"

new_string:
"function hello() {
  return 'Hello World';
}"`,
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'The path of the file to modify',
        },
        old_string: {
          type: 'string',
          description: 'The EXACT text to find and replace. Must match perfectly including whitespace and newlines. Must be unique in the file.',
        },
        new_string: {
          type: 'string',
          description: 'The text to replace old_string with. Can be empty string to delete the old_string.',
        },
        replace_all: {
          type: 'boolean',
          description: 'If true, replace ALL occurrences of old_string. Default is false (replace only first/unique occurrence).',
          default: false,
        },
      },
      required: ['path', 'old_string', 'new_string'],
    },
  },
};

// ============================================
// MULTI SEARCH REPLACE TOOL (Batch replacements in one call)
// ============================================
export const multiSearchReplaceTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'multi_search_replace',
    description: `Make MULTIPLE find-and-replace edits to a file in a SINGLE tool call. Much faster than calling search_replace multiple times.

WHEN TO USE multi_search_replace:
- Making 2 or more separate edits to the same file
- Refactoring multiple functions at once
- Updating multiple imports
- Changing multiple variable names or values
- Any task requiring multiple targeted edits in one file

HOW IT WORKS:
1. Provide the file path
2. Provide an array of replacements, each with old_string and new_string
3. Each replacement is matched against the original file snapshot
4. Replacement regions must not overlap each other
5. All replacements must be unique in the file (unless replace_all is set per replacement)

EXAMPLE:
{
  "path": "src/App.tsx",
  "replacements": [
    { "old_string": "import React from 'react'", "new_string": "import * as React from 'react'" },
    { "old_string": "const count = 0;", "new_string": "const count = 10;" },
    { "old_string": "function App() {", "new_string": "const App: React.FC = () => {" }
  ]
}

IMPORTANT RULES:
- Each old_string must match the current file content exactly for indentation and surrounding code
- Line ending differences (LF vs CRLF) are handled automatically
- Each old_string should be unique in the file for precise replacements
- Replacements are matched against the original file snapshot
- Replacements must not overlap; if two edits are close together, combine them into one larger replacement
- If any replacement fails, the entire operation is rolled back
- Include enough context (3-5 lines) in each old_string to make it unique`,
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'The path of the file to modify',
        },
        replacements: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              old_string: {
                type: 'string',
                description: 'The EXACT text to find and replace. Must match perfectly including whitespace and newlines.',
              },
              new_string: {
                type: 'string',
                description: 'The text to replace old_string with. Can be empty string to delete the old_string.',
              },
              replace_all: {
                type: 'boolean',
                description: 'If true, replace ALL occurrences of this old_string. Default is false.',
                default: false,
              },
            },
            required: ['old_string', 'new_string'],
          },
          description: 'Array of replacements to apply. Each replacement has old_string, new_string, and optional replace_all.',
        },
      },
      required: ['path', 'replacements'],
    },
  },
};

// Export all file tools as an array
export const fileTools: ToolDefinition[] = [
  fileCreateTool,
  fileReadTool,
  fileWriteTool,
  searchReplaceTool,
  multiSearchReplaceTool,
  fileDeleteTool,
  grepTool,
  multiFileReadTool,
];
