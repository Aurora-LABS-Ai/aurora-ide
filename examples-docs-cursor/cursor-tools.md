# Cursor Tools Reference

This document describes all available tools for reading, writing, and manipulating files in this workspace. These tools are used by the AI assistant (Claude) to interact with the codebase.

## Table of Contents

- [File Operations](#file-operations)
- [Directory Operations](#directory-operations)
- [Code Search](#code-search)
- [Code Editing](#code-editing)
- [Terminal Operations](#terminal-operations)
- [Linting & Diagnostics](#linting--diagnostics)
- [Notebook Operations](#notebook-operations)
- [Task Management](#task-management)
- [Web Search](#web-search)

---

## File Operations

### `read_file`

Reads a file from the filesystem.

**Parameters:**
- `target_file` (string, required): Path to the file (relative to workspace root or absolute)
- `offset` (integer, optional): Line number to start reading from (1-indexed)
- `limit` (integer, optional): Number of lines to read

**Returns:**
- File contents with line numbers in format `LINE_NUMBER|LINE_CONTENT`
- Empty file returns "File is empty."
- Error if file doesn't exist

**Example:**
```typescript
read_file({ target_file: "src/App.tsx" })
read_file({ target_file: "src/App.tsx", offset: 10, limit: 20 })
```

**Notes:**
- Can read files outside workspace (absolute paths)
- Supports reading portions of large files with offset/limit
- Lines are numbered starting at 1

---

### `write`

Creates or overwrites a file with new content.

**Parameters:**
- `file_path` (string, required): Path to the file (relative to workspace root or absolute)
- `contents` (string, required): Complete file contents to write

**Returns:**
- Success: File is written
- Error if path is invalid or write fails

**Example:**
```typescript
write({ 
  file_path: "src/components/Button.tsx", 
  contents: "export const Button = () => { return <button>Click</button>; };" 
})
```

**Notes:**
- Overwrites existing files completely
- Creates parent directories if they don't exist
- Use `search_replace` for partial edits

---

### `search_replace`

Performs exact string replacements in files.

**Parameters:**
- `file_path` (string, required): Path to the file to modify
- `old_string` (string, required): Exact text to replace (must match exactly including whitespace)
- `new_string` (string, required): Replacement text
- `replace_all` (boolean, optional): Replace all occurrences (default: false)

**Returns:**
- Success: Replacement is made
- Error if `old_string` is not unique (when `replace_all` is false)

**Example:**
```typescript
// Single replacement
search_replace({ 
  file_path: "src/App.tsx",
  old_string: "const count = 0;",
  new_string: "const count = 1;"
})

// Replace all occurrences
search_replace({ 
  file_path: "src/utils.ts",
  old_string: "oldFunction",
  new_string: "newFunction",
  replace_all: true
})
```

**Notes:**
- Preserves exact indentation (tabs/spaces)
- `old_string` must be unique unless `replace_all: true`
- For multiple unique instances, make separate calls
- Use for renaming variables across a file with `replace_all: true`

---

### `delete_file`

Deletes a file from the filesystem.

**Parameters:**
- `target_file` (string, required): Path to the file to delete

**Returns:**
- Success: File is deleted
- Error if file doesn't exist or operation is rejected

**Example:**
```typescript
delete_file({ target_file: "src/old-component.tsx" })
```

**Notes:**
- Fails gracefully if file doesn't exist
- Cannot delete directories (use terminal commands)

---

## Directory Operations

### `list_dir`

Lists files and directories in a given path.

**Parameters:**
- `target_directory` (string, required): Path to directory (relative or absolute)
- `ignore_globs` (array of strings, optional): Glob patterns to ignore

**Returns:**
- Array of file and directory names
- Does not display dot-files/dot-directories by default

**Example:**
```typescript
list_dir({ target_directory: "src/components" })
list_dir({ 
  target_directory: "src", 
  ignore_globs: ["*.test.ts", "**/node_modules/**"] 
})
```

**Notes:**
- Patterns not starting with `**/` are automatically prepended with `**/`
- Example: `"*.js"` becomes `"**/*.js"`

---

### `glob_file_search`

Searches for files matching a glob pattern.

**Parameters:**
- `glob_pattern` (string, required): Glob pattern to match
- `target_directory` (string, optional): Directory to search in (defaults to workspace root)

**Returns:**
- Array of matching file paths sorted by modification time

**Example:**
```typescript
glob_file_search({ glob_pattern: "*.tsx" })
glob_file_search({ glob_pattern: "**/*.test.ts", target_directory: "src" })
glob_file_search({ glob_pattern: "**/components/**/*.tsx" })
```

**Notes:**
- Patterns not starting with `**/` are automatically prepended with `**/`
- Results sorted by modification time (newest first)
- Fast even with large codebases

---

## Code Search

### `codebase_search`

Semantic search across the codebase using AI-powered understanding.

**Parameters:**
- `query` (string, required): Natural language question about the codebase
- `target_directories` (array of strings, optional): Limit search to specific directories
- `search_only_prs` (boolean, optional): Only search pull requests (default: false)

**Returns:**
- Relevant code snippets matching the semantic query

**Example:**
```typescript
codebase_search({ 
  query: "How does the tool registry work?",
  target_directories: ["src/tools"]
})

codebase_search({ 
  query: "Where is user authentication handled?",
  target_directories: []
})
```

**Notes:**
- Use complete questions (e.g., "How does X work?" not just "X")
- More effective than grep for understanding code relationships
- Can search across multiple directories or entire codebase

---

### `grep`

Powerful regex-based search tool built on ripgrep.

**Parameters:**
- `pattern` (string, required): Regular expression pattern to search for
- `path` (string, optional): File or directory to search (defaults to workspace root)
- `type` (string, optional): File type filter (e.g., "js", "ts", "py", "rust")
- `glob` (string, optional): Glob pattern to filter files
- `output_mode` (string, optional): "content" (default), "files_with_matches", or "count"
- `-A` (number, optional): Lines after match
- `-B` (number, optional): Lines before match
- `-C` (number, optional): Lines before and after match
- `-i` (boolean, optional): Case insensitive search
- `multiline` (boolean, optional): Enable multiline matching
- `head_limit` (number, optional): Limit output to first N results

**Returns:**
- Matching lines with file paths and line numbers
- Format: `filepath:LINE_NUMBER:MATCH_CONTENT`

**Example:**
```typescript
// Simple search
grep({ pattern: "useState" })

// Case insensitive with context
grep({ 
  pattern: "function.*Component",
  type: "tsx",
  -C: 3,
  -i: true
})

// Find all imports
grep({ 
  pattern: "^import",
  output_mode: "files_with_matches"
})

// Multiline pattern
grep({ 
  pattern: "interface\\s+\\{[\\s\\S]*?field",
  multiline: true
})
```

**Notes:**
- Faster than terminal grep/rg
- Respects .gitignore/.cursorignore
- Supports full regex syntax
- Use `type` for file type filtering (more efficient than glob)
- Escape special regex characters for literal matches

---

## Code Editing

### `edit_notebook`

Edits Jupyter notebook cells.

**Parameters:**
- `target_notebook` (string, required): Path to notebook file
- `cell_idx` (number, required): 0-based cell index
- `is_new_cell` (boolean, required): Create new cell (true) or edit existing (false)
- `cell_language` (string, required): Language ("python", "markdown", "javascript", etc.)
- `old_string` (string, required): Content to replace (empty for new cells)
- `new_string` (string, required): New cell content

**Returns:**
- Success: Cell is edited/created
- Error if cell index invalid or content doesn't match

**Example:**
```typescript
// Edit existing cell
edit_notebook({
  target_notebook: "analysis.ipynb",
  cell_idx: 0,
  is_new_cell: false,
  cell_language: "python",
  old_string: "print('old')",
  new_string: "print('new')"
})

// Create new cell
edit_notebook({
  target_notebook: "analysis.ipynb",
  cell_idx: 1,
  is_new_cell: true,
  cell_language: "python",
  old_string: "",
  new_string: "import pandas as pd"
})
```

**Notes:**
- Cell indices are 0-based
- `old_string` must uniquely identify the cell content
- Include 3-5 lines of context before/after for unique identification
- Cannot delete cells (set content to empty string instead)

---

## Terminal Operations

### `run_terminal_cmd`

Executes shell commands in the workspace.

**Parameters:**
- `command` (string, required): Shell command to execute
- `is_background` (boolean, optional): Run in background (default: false)

**Returns:**
- Command output (stdout/stderr)
- Exit code information

**Example:**
```typescript
run_terminal_cmd({ command: "pnpm install" })
run_terminal_cmd({ command: "pnpm tauri:dev", is_background: true })
run_terminal_cmd({ command: "git status" })
```

**Notes:**
- Automatically `cd` to workspace root in new shells
- Use `is_background: true` for long-running processes
- Non-interactive flags are assumed (e.g., `--yes` for npx)
- Commands using pagers should append ` | cat`

**Important Guidelines:**
- Never ask for user interaction (use non-interactive flags)
- Background jobs run indefinitely until interrupted
- Commands are executed in PowerShell on Windows, sh on Unix

---

## Linting & Diagnostics

### `read_lints`

Reads linter errors and warnings from the workspace.

**Parameters:**
- `paths` (array of strings, optional): Specific files/directories to check (defaults to all files)

**Returns:**
- Array of diagnostic objects with:
  - File path
  - Line/column numbers
  - Error/warning message
  - Severity level

**Example:**
```typescript
read_lints({ paths: ["src/App.tsx"] })
read_lints({ paths: ["src/components"] })
read_lints() // All files
```

**Notes:**
- Only call on files you've edited or are about to edit
- Avoid calling with very wide scope
- May return pre-existing errors (not just from your changes)

---

## Task Management

### `todo_write`

Creates and manages structured task lists.

**Parameters:**
- `merge` (boolean, required): Merge with existing todos (true) or replace (false)
- `todos` (array, required): Array of todo items with:
  - `id` (string, required): Unique identifier
  - `content` (string, required): Task description
  - `status` (string, required): "pending", "in_progress", "completed", or "cancelled"

**Returns:**
- Success: Todo list is updated

**Example:**
```typescript
// Create initial todos
todo_write({
  merge: false,
  todos: [
    { id: "1", content: "Implement feature X", status: "in_progress" },
    { id: "2", content: "Write tests", status: "pending" }
  ]
})

// Update todo
todo_write({
  merge: true,
  todos: [
    { id: "1", status: "completed" }
  ]
})
```

**Notes:**
- Use for complex multi-step tasks (3+ steps)
- Mark complete immediately after finishing
- Only one task should be "in_progress" at a time
- Don't include linting/testing in todos (operational tasks)

---

## Web Search

### `web_search`

Searches the web for real-time information.

**Parameters:**
- `search_term` (string, required): Search query

**Returns:**
- Relevant snippets and URLs from web pages

**Example:**
```typescript
web_search({ search_term: "React 18.3 new features" })
web_search({ search_term: "Tauri 2.0 API changes" })
```

**Notes:**
- Use for up-to-date information not in training data
- Useful for current events, technology updates, version-specific docs
- Include version numbers or dates for better results

---

## Best Practices

### File Operations

1. **Read before editing**: Always read a file before making changes
2. **Preserve formatting**: Maintain exact indentation and whitespace
3. **Use search_replace for edits**: Prefer `search_replace` over `write` for partial changes
4. **Batch operations**: Read multiple files in parallel when possible

### Code Search

1. **Use semantic search first**: `codebase_search` for understanding, `grep` for exact matches
2. **Be specific**: Include context in search queries
3. **Limit scope**: Use `target_directories` to narrow searches

### Terminal Commands

1. **Check package manager**: This project uses `pnpm`
2. **Background processes**: Use `is_background: true` for dev servers
3. **Non-interactive**: Always assume no user interaction available

### Error Handling

1. **Check file existence**: Files may not exist, handle gracefully
2. **Validate paths**: Use relative paths from workspace root when possible
3. **Read lints**: Check linter errors after making changes

---

## Tool Limitations

- **No directory deletion**: Use terminal commands for recursive directory deletion
- **No file move/rename**: Use `read_file` + `write` + `delete_file` or terminal commands
- **No file permissions**: Cannot change file permissions directly
- **No symlink operations**: Symlinks are followed but not created/managed
- **Background processes**: Limited process management (use terminal for advanced cases)

---

## Common Workflows

### Reading and Editing a File

```typescript
// 1. Read the file
const content = read_file({ target_file: "src/App.tsx" })

// 2. Make targeted edits
search_replace({
  file_path: "src/App.tsx",
  old_string: "const [count, setCount] = useState(0);",
  new_string: "const [count, setCount] = useState(1);"
})

// 3. Check for errors
read_lints({ paths: ["src/App.tsx"] })
```

### Finding and Understanding Code

```typescript
// 1. Semantic search to understand
codebase_search({ 
  query: "How does the tool registry register executors?",
  target_directories: ["src/tools"]
})

// 2. Exact search for specific patterns
grep({ 
  pattern: "registerExecutor",
  type: "ts"
})

// 3. Read relevant files
read_file({ target_file: "src/tools/registry.ts" })
```

### Creating New Files

```typescript
// 1. Check if directory exists
list_dir({ target_directory: "src/components" })

// 2. Create the file
write({
  file_path: "src/components/NewComponent.tsx",
  contents: `import React from 'react';

export const NewComponent = () => {
  return <div>New Component</div>;
};`
})

// 3. Verify no linting errors
read_lints({ paths: ["src/components/NewComponent.tsx"] })
```

---

## Tool Comparison

| Task | Preferred Tool | Alternative |
|------|---------------|-------------|
| Read entire file | `read_file` | - |
| Read file portion | `read_file` (with offset/limit) | - |
| Create new file | `write` | - |
| Edit existing file | `search_replace` | `read_file` + `write` |
| Replace all occurrences | `search_replace` (replace_all: true) | Multiple `search_replace` calls |
| Delete file | `delete_file` | Terminal command |
| List directory | `list_dir` | `glob_file_search` |
| Find files by pattern | `glob_file_search` | Terminal `find` |
| Search code semantically | `codebase_search` | - |
| Search code exactly | `grep` | Terminal `grep` |
| Execute command | `run_terminal_cmd` | - |
| Check errors | `read_lints` | Terminal linter |
| Edit notebook | `edit_notebook` | - |
| Search web | `web_search` | - |

---

## Notes

- All file paths can be relative to workspace root or absolute
- Tools respect `.gitignore` and `.cursorignore` files
- Unsaved files in editors are searchable and show "(unsaved)" marker
- Files outside workspace show "(out of workspace)" marker
- Tools are optimized for large codebases and handle performance automatically
