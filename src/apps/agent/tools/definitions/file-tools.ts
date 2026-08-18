/**
 * File System Tools — Definitions
 *
 * Refined 8→6: one reader (`file_read`, single or batch), one writer
 * (`file_write`, content required), one editor (`file_edit`, single or
 * atomic batch), plus `move_path` / `delete_path` (file-or-folder) and
 * `grep`. The old `file_create` / `file_delete` / `search_replace` /
 * `multi_search_replace` / `multi_file_read` tools are gone — folded into
 * these. Schemas mirror the native Rust executors in
 * `src-tauri/src/tools/file_workspace_search/`.
 */
import type { ToolDefinition } from "@/apps/agent/tools/types";

// ============================================
// FILE READ TOOL (single or parallel batch)
// ============================================
export const fileReadTool: ToolDefinition = {
  type: 'function',
  nativeRustOwned: true,
  function: {
    name: 'file_read',
    description: `Read one or more files. "path" takes a single path, or an array to read several in parallel (max 20). Start with NO range: files small enough come back whole, and anything larger comes back with its exact total line count and where to continue from — so you never have to guess how long a file is. Then window only the large ones. A missing path reports exists=false instead of failing.

Examples:
- file_read(path="src/App.tsx")
- file_read(path="src/big.ts", start_line=120, end_line=220)
- file_read(path=["src/App.tsx", "src/main.tsx", "package.json"])`,
    parameters: {
      type: 'object',
      properties: {
        // ONE slot names what to read. This mirrors the Rust schema in
        // `tools/file_workspace_search/file_read.rs`, which is the source of
        // truth — this definition is display/approval metadata and is filtered
        // out of the model's roster by `nativeRustOwned`.
        //
        // It previously declared `path` AND `paths` under a `oneOf`. Both
        // halves of that were wrong: `oneOf` in function parameters makes
        // strict validators (xAI/grok) answer HTTP 400, and two slots let a
        // strictly-decoding model fill both and then be told its own
        // schema-obedient call was malformed.
        path: {
          type: ['string', 'array'],
          minLength: 1,
          maxItems: 20,
          items: { type: 'string', minLength: 1 },
          description: 'One file path as a string, or 1-20 file paths as an array of strings to read in parallel. A line range, if given, applies to every path.',
        },
        start_line: {
          type: 'number',
          description: 'Optional 1-based first line to return. With several paths, applies to every file.',
        },
        end_line: {
          type: 'number',
          description: 'Optional 1-based inclusive last line to return. With several paths, applies to every file.',
        },
        max_lines: {
          type: 'number',
          description: 'Optional maximum lines to return from start_line (hard cap 1000 per file).',
        },
        force_full_content: {
          type: 'boolean',
          description: 'Return a whole file in one call with no line cap, however long it is.',
        },
      },
      required: [],
    },
  },
};

// ============================================
// FILE WRITE TOOL (create or overwrite)
// ============================================
export const fileWriteTool: ToolDefinition = {
  type: 'function',
  nativeRustOwned: true,
  function: {
    name: 'file_write',
    description: `Create a new file or COMPLETELY OVERWRITE an existing one with the full content you supply. Emit "path" first, before "content", so the interface can show the target while the file body streams. Creates parent directories automatically. "content" is REQUIRED — provide the entire file body.

Use file_edit for targeted changes to an existing file. Set must_not_exist=true to fail instead of overwriting if the file already exists.`,
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'The full path of the file to write.',
        },
        content: {
          type: 'string',
          description: 'The COMPLETE new content for the file (required).',
        },
        must_not_exist: {
          type: 'boolean',
          description: 'When true, fail if the file already exists (create-only). Default false.',
          default: false,
        },
      },
      required: ['path', 'content'],
    },
  },
};

// ============================================
// FILE EDIT TOOL (single or atomic batch find-and-replace)
// ============================================
export const fileEditTool: ToolDefinition = {
  type: 'function',
  nativeRustOwned: true,
  function: {
    name: 'file_edit',
    description: `Edit files by exact-text find-and-replace. This is the PREFERRED tool for targeted edits. Read each file with file_read first.

Single edit: pass path + old_string + new_string.
Many edits to ONE file: pass an "edits" array plus the top-level "path".
Edits across MULTIPLE files in ONE call: give each item in "edits" its own "path" (the top-level "path" is the default for items that omit it).
For a multi-file batch, emit "target_paths" first with every file path so the interface can show all targets before the edit bodies stream.

The whole batch is ATOMIC: every edit matches against its file's ORIGINAL snapshot, and if any edit fails NO file is changed.

RULES:
- old_string must match the file exactly (whitespace + newlines). LF/CRLF is handled automatically.
- old_string must be unique unless replace_all=true. Include 3-5 lines of surrounding context to disambiguate.
- new_string may be empty to delete old_string. Edits in the same file must not overlap.

Examples:
- file_edit(path="src/App.tsx", old_string="const n = 0;", new_string="const n = 10;")
- file_edit(path="src/App.tsx", edits=[{ old_string:"foo", new_string:"bar" }, { old_string:"baz", new_string:"qux" }])
- file_edit(edits=[{ path:"src/a.ts", old_string:"foo", new_string:"bar" }, { path:"src/b.ts", old_string:"baz", new_string:"qux" }])`,
    parameters: {
      type: 'object',
      properties: {
        target_paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Streaming UI metadata for a multi-file batch. Emit this field first with every file that edits[] will target. It does not change which files are edited.',
        },
        path: {
          type: 'string',
          description: 'The file to edit. Required for the single-edit form. In the batch form it is the DEFAULT path for edits that do not set their own "path".',
        },
        old_string: {
          type: 'string',
          description: 'Single-edit form: the EXACT text to find. Must match perfectly and be unique unless replace_all=true.',
        },
        new_string: {
          type: 'string',
          description: 'Single-edit form: the replacement text. May be empty to delete old_string.',
        },
        replace_all: {
          type: 'boolean',
          description: 'Single-edit form: replace every occurrence of old_string. Default false.',
          default: false,
        },
        edits: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              path: {
                type: 'string',
                description: 'Optional file for THIS edit. Defaults to the top-level "path". Set it to edit several files in one atomic call.',
              },
              old_string: {
                type: 'string',
                description: 'The EXACT text to find. Must match perfectly including whitespace and newlines.',
              },
              new_string: {
                type: 'string',
                description: 'The text to replace old_string with. May be empty to delete.',
              },
              replace_all: {
                type: 'boolean',
                description: 'If true, replace ALL occurrences of this old_string. Default false.',
                default: false,
              },
            },
            required: ['old_string', 'new_string'],
          },
          description: 'Batch form: array of edits applied atomically against each file\'s original snapshot. Give items their own "path" to edit multiple files in one call. Matched regions in the same file must not overlap.',
        },
      },
      required: [],
    },
  },
};

// ============================================
// MOVE PATH TOOL (move/rename a file OR folder)
// ============================================
export const movePathTool: ToolDefinition = {
  type: 'function',
  nativeRustOwned: true,
  function: {
    name: 'move_path',
    description: 'Move or rename a file OR a folder from one path to another. Fails if the source does not exist or the destination already exists.',
    parameters: {
      type: 'object',
      properties: {
        old_path: {
          type: 'string',
          description: 'The current full path (file or folder).',
        },
        new_path: {
          type: 'string',
          description: 'The new full path.',
        },
      },
      required: ['old_path', 'new_path'],
    },
  },
};

// ============================================
// DELETE PATH TOOL (delete a file OR folder)
// ============================================
export const deletePathTool: ToolDefinition = {
  type: 'function',
  nativeRustOwned: true,
  function: {
    name: 'delete_path',
    description: 'Delete a file or a folder. Deleting a folder (with all its contents) requires recursive=true. Irreversible.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'The full path to delete (file or folder).',
        },
        recursive: {
          type: 'boolean',
          description: 'Required (true) to delete a folder and its contents. Default false.',
          default: false,
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
  nativeRustOwned: true,
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
        timeout: {
          type: 'number',
          description: 'Timeout in milliseconds. Defaults to 30000 (30 seconds), maximum 300000 (5 minutes).',
          default: 30000,
        },
      },
      required: ['pattern'],
    },
  },
};

// Export all file tools as an array (the model sees exactly these).
export const fileTools: ToolDefinition[] = [
  fileReadTool,
  fileWriteTool,
  fileEditTool,
  movePathTool,
  deletePathTool,
  grepTool,
];
