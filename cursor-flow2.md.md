# All Tools Usage Documentation

## How I Write Files

I use the `write` tool to create or overwrite files:

```json
{
  "name": "write",
  "description": "Writes a file to the local filesystem.\n\nUsage:\n- This tool will overwrite the existing file if there is one at the provided path.\n- If this is an existing file, you MUST use the read_file tool first to read the file's contents.\n- ALWAYS prefer editing existing files in the codebase. NEVER write new files unless explicitly required.\n- NEVER proactively create documentation files (*.md) or README files. Only create documentation files if explicitly requested by the User.",
  "parameters": {
    "type": "object",
    "properties": {
      "file_path": {
        "type": "string",
        "description": "The path to the file to modify. Always specify the target file as the first argument. You can use either a relative path in the workspace or an absolute path."
      },
      "contents": {
        "type": "string",
        "description": "The contents of the file to write"
      }
    },
    "required": ["file_path", "contents"]
  }
}
```

## How I Read Files

I use the `read_file` tool to read file contents:

```json
{
  "name": "read_file",
  "description": "\nReads a file from the local filesystem. You can access any file directly by using this tool.\nIf the User provides a path to a file assume that path is valid. It is okay to read a file that does not exist; an error will be returned.\n\nUsage:\n- You can optionally specify a line offset and limit (especially handy for long files), but it's recommended to read the whole file by not providing these parameters.\n- Lines in the output are numbered starting at 1, using following format: LINE_NUMBER|LINE_CONTENT.\n- You have the capability to call multiple tools in a single response. It is always better to speculatively read multiple files as a batch that are potentially useful.\n- If you read a file that exists but has empty contents you will receive 'File is empty.'.\n\n\nImage Support:\n- This tool can also read image files when called with the appropriate path.\n- Supported image formats: jpeg/jpg, png, gif, webp.",
  "parameters": {
    "type": "object",
    "properties": {
      "target_file": {
        "type": "string",
        "description": "The path of the file to read. You can use either a relative path in the workspace or an absolute path. If an absolute path is provided, it will be preserved as is."
      },
      "offset": {
        "integer": "The line number to start reading from. Only provide if the file is too large to read at once."
      },
      "limit": {
        "integer": "The number of lines to read. Only provide if the file is too large to read at once."
      }
    },
    "required": ["target_file"]
  }
}
```

## Complete List of All Available Tools

### 1. codebase_search
```json
{
  "name": "codebase_search",
  "description": "`codebase_search`: semantic search that finds code by meaning, not exact text\n\n### When to Use This Tool\n\nUse `codebase_search` when you need to:\n- Explore unfamiliar codebases\n- Ask \"how / where / what\" questions to understand behavior\n- Find code by meaning rather than exact text\n\n### When NOT to Use\n\nSkip `codebase_search` for:\n1. Exact text matches (use `grep`)\n2. Reading known files (use `read_file`)\n3. Simple symbol lookups (use `grep`)\n4. Find file by name (use `file_search`)\n\n### Examples\n\n<example>\n  Query: \"Where is interface MyInterface implemented in the frontend?\"\n<reasoning>\n  Good: Complete question asking about implementation location with specific context (frontend).\n</reasoning>\n</example>\n\n<example>\n  Query: \"Where do we encrypt user passwords before saving?\"\n<reasoning>\n  Good: Clear question about a specific process with context about when it happens.\n</reasoning>\n</example>\n\n<example>\n  Query: \"MyInterface frontend\"\n<rereasoning>\n  BAD: Too vague; use a specific question instead. This would be better as \"Where is MyInterface used in the frontend?\"\n</reasoning>\n</example>\n\n<example>\n  Query: \"AuthService\"\n<rereasoning>\n  BAD: Single word searches should use `grep` for exact text matching instead.\n</reasoning>\n</example>\n\n<example>\n  Query: \"What is AuthService? How does AuthService work?\"\n<rereasoning>\n  BAD: Combines two separate queries. A single semantic search is not good at looking for multiple things in parallel. Split into separate parallel searches: like \"What is AuthService?\" and \"How does AuthService work?\"\n</reasoning>\n</example>\n\n### Target Directories\n\n- Provide ONE directory or file path; [] searches the whole repo. No globs or wildcards.\n  Good:\n  - [\"backend/api/\"]   - focus directory\n  - [\"src/components/Button.tsx\"] - single file\n  - [] - search everywhere when unsure\n  BAD:\n  - [\"frontend/\", \"backend/\"] - multiple paths\n  - [\"src/**/utils/**\"] - globs\n  - [\"*.ts\"] or [\"**/*\"] - wildcard paths\n\n### Search Strategy\n\n1. Start with exploratory queries - semantic search is powerful and often finds relevant context in one go. Begin broad with [] if you're not sure where relevant code is.\n2. Review results; if a directory or file stands out, rerun with that as the target.\n3. Break large questions into smaller ones (e.g. auth roles vs session storage).\n4. For big files (>1K lines) run `codebase_search`, or `grep` if you know the exact symbols you're looking for, scoped to that file instead of reading the entire file.\n\n<example>\n  Step 1: { \"query\": \"How does user authentication work?\", \"target_directories\": [], \"explanation\": \"Find auth flow\" }\n  Step 2: Suppose results point to backend/auth/ → rerun:\n          { \"query\": \"Where are user roles checked?\", \"target_directories\": [\"backend/auth/\"], \"explanation\": \"Find role logic\" }\n</reasoning>\n  Good strategy: Start broad to understand overall system, then narrow down to specific areas based on initial results.\n</reasoning>\n</example>\n\n<example>\n  Query: \"How are websocket connections handled?\"\n  Target: [\"backend/services/realtime.ts\"]\n<rereasoning>\n  Good: We know the answer is in this specific file, but the file is too large to read entirely, so we use semantic search to find the relevant parts.\n</reasoning>\n</example>",
  "parameters": {
    "type": "object",
    "properties": {
      "explanation": {
        "type": "string",
        "description": "One sentence explanation as to why this tool is being used, and how it contributes to the goal."
      },
      "query": {
        "type": "string",
        "description": "A complete question about what you want to understand. Ask as if talking to a colleague: 'How does X work?', 'What happens when Y?', 'Where is Z handled?'"
      },
      "target_directories": {
        "type": "array",
        "items": {
          "type": "string"
        },
        "description": "Prefix directory paths to limit search scope (single directory only, no glob patterns)"
      }
    },
    "required": ["explanation", "query", "target_directories"]
  }
}
```

### 2. run_terminal_cmd
```json
{
  "name": "run_terminal_cmd",
  "description": "PROPOSE a command to run on behalf of the user.\nNote that the user may have to approve the command before it is executed.\nThe user may reject it if it is not to their liking, or may modify the command before approving it.  If they do change it, take those changes into account.\nIn using these tools, adhere to the following guidelines:\n1. Before starting servers or long-running processes, list the terminals folder to check if they are already running in existing terminals.\n2. Based on the contents of the conversation, you will be told if you are in the same shell as a previous step or a different shell.\n3. If in a new shell, you should `cd` to the appropriate directory and do necessary setup in addition to running the command. By default, the shell will initialize in the project root.\n4. If in the same shell, LOOK IN CHAT HISTORY for your current working directory. The environment also persists (e.g. exported env vars, venv/nvm activations).\n5. For ANY commands that would require user interaction, ASSUME THE USER IS NOT AVAILABLE TO INTERACT and PASS THE NON-INTERACTIVE FLAGS (e.g. --yes for npx).\n6. For commands that are long running/expected to run indefinitely until interruption, please run them in the background. To run jobs in the background, set `is_background` to true rather than changing the details of the command.",
  "parameters": {
    "type": "object",
    "properties": {
      "command": {
        "type": "string",
        "description": "The terminal command to execute"
      },
      "is_background": {
        "type": "boolean",
        "description": "Whether the command should be run in the background"
      },
      "explanation": {
        "type": "string",
        "description": "One sentence explanation as to why this command needs to be run and how it contributes to the goal."
      }
    },
    "required": ["command", "is_background"]
  }
}
```

### 3. grep
```json
{
  "name": "grep",
  "description": "A powerful search tool built on ripgrep\n\nUsage:\n- Prefer grep for exact symbol/string searches. Whenever possible, use this instead of terminal grep/rg. This tool is faster and respects .gitignore/.cursorignore.\n- Supports full regex syntax, e.g. \"log.*Error\", \"function\\s+\\w+\". Ensure you escape special chars to get exact matches, e.g. \"functionCall\\(\"\n- Avoid overly broad glob patterns (e.g., '--glob *') as they bypass .gitignore rules and may be slow\n- Only use 'type' (or 'glob' for file types) when certain of the file type needed. Note: import paths may not match source file types (.js vs .ts)\n- Output modes: \"content\" shows matching lines (default), \"files_with_matches\" shows only file paths, \"count\" shows match counts per file\n- Pattern syntax: Uses ripgrep (not grep) - literal braces need escaping (e.g. use interface\\{\\} to find interface{} in Go code)\n- Multiline matching: By default patterns match within single lines only. For cross-line patterns like struct \\{[\\s\\S]*?field, use multiline: true\n- Results are capped for responsiveness; truncated results show \"at least\" counts.\n- Content output follows ripgrep format: '-' for context lines, ':' for match lines, and all lines grouped by file.\n- Unsaved or out of workspace active editors are also searched and show \"(unsaved)\" or \"(out of workspace)\". Use absolute paths to read/edit these files.",
  "parameters": {
    "type": "object",
    "properties": {
      "pattern": {
        "type": "string",
        "description": "The regular expression pattern to search for in file contents (rg --regexp)"
      },
      "path": {
        "type": "string",
        "description": "File or directory to search in (rg pattern -- PATH). Defaults to Cursor workspace roots."
      },
      "glob": {
        "type": "string",
        "description": "Glob pattern (rg --glob GLOB -- PATH) to filter files (e.g. \"*.js\", \"*.{ts,tsx}\")."
      },
      "output_mode": {
        "type": "string",
        "description": "Output mode: \"content\" shows matching lines (supports -A/-B/-C context, -n line numbers, head_limit), \"files_with_matches\" shows file paths (supports head_limit), \"count\" shows match counts (supports head_limit). Defaults to \"content\".",
        "enum": ["content", "files_with_matches", "count"]
      },
      "-B": {
        "type": "number",
        "description": "Number of lines to show before each match (rg -B). Requires output_mode: \"content\", ignored otherwise."
      },
      "-A": {
        "type": "number",
        "description": "Number of lines to show after each match (rg -A). Requires output_mode: \"content\", ignored otherwise."
      },
      "-C": {
        "type": "number",
        "description": "Number of lines to show before and after each match (rg -C). Requires output_mode: \"content\", ignored otherwise."
      },
      "-i": {
        "type": "boolean",
        "description": "Case insensitive search (rg -i) Defaults to false"
      },
      "type": {
        "type": "string",
        "description": "File type to search (rg --type). Common types: js, py, rust, go, java, etc. More efficient than glob for standard file types."
      },
      "head_limit": {
        "type": "number",
        "description": "Limit output to first N lines/entries, equivalent to \"| head -N\". Works across all output modes: content (limits output lines), files_with_matches (limits file paths), count (limits count entries). When unspecified, shows all ripgrep results."
      },
      "multiline": {
        "type": "boolean",
        "description": "Enable multiline mode where . matches newlines and patterns can span lines (rg -U --multiline-dotall). Default: false."
      }
    },
    "required": ["pattern"]
  }
}
```

### 4. delete_file
```json
{
  "name": "delete_file",
  "description": "Deletes a file at the specified path. The operation will fail gracefully if:\n    - The file doesn't exist\n    - The operation is rejected for security reasons\n    - The file cannot be deleted",
  "parameters": {
    "type": "object",
    "properties": {
      "target_file": {
        "type": "string",
        "description": "The path of the file to delete, relative to the workspace root."
      },
      "explanation": {
        "type": "string",
        "description": "One sentence explanation as to why this tool is being used, and how it contributes to the goal."
      }
    },
    "required": ["target_file"]
  }
}
```

### 5. read_lints
```json
{
  "name": "read_lints",
  "description": "Read and display linter errors from the current workspace. You can provide paths to specific files or directories, or omit the argument to get diagnostics for all files.\n\n- If a file path is provided, returns diagnostics for that file only\n- If a directory path is provided, returns diagnostics for all files within that directory\n- If no path is provided, returns diagnostics for all files in the workspace\n- This tool can return linter errors that were already present before your edits, so avoid calling it with a very wide scope of files\n- NEVER call this tool on a file unless you've edited it or are about to edit it",
  "parameters": {
    "type": "object",
    "properties": {
      "paths": {
        "description": "Optional. An array of paths to files or directories to read linter errors for. You can use either relative paths in the workspace or absolute paths. If provided, returns diagnostics for the specified files/directories only. If not provided, returns diagnostics for all files in the workspace.",
        "type": "array",
        "items": {
          "type": "string"
        }
      }
    },
    "required": []
  }
}
```

### 6. todo_write
```json
{
  "name": "todo_write",
  "description": "Use this tool to create and manage a structured task list for your current coding session. This helps track progress, organize complex tasks, and demonstrate thoroughness.\n\nNote: Other than when first creating todos, don't tell the user you're updating todos, just do it.\n\n### When to Use This Tool\n\nUse proactively for:\n1. Complex multi-step tasks (3+ distinct steps)\n2. Non-trivial tasks requiring careful planning\n3. User explicitly requests todo list\n4. User provides multiple tasks (numbered/comma-separated)\n5. After receiving new instructions - capture requirements as todos (use merge=false to add new ones)\n6. After completing tasks - mark complete with merge=true and add follow-ups\n7. When starting new tasks - mark as in_progress (ideally only one at a time)\n\n### When NOT to Use\n\nSkip for:\n1. Single, straightforward tasks\n2. Trivial tasks with no organizational benefit\n3. Tasks completable in < 3 trivial steps\n4. Purely conversational/informational requests\n5. Todo items should NOT include operational actions done in service of higher-level tasks.\n\nNEVER INCLUDE THESE IN TODOS: linting; testing; searching or examining the codebase.\n\n### Examples\n\n<example>\n  User: Add dark mode toggle to settings\n  Assistant:\n    - *Creates todo list:*\n      1. Add state management [in_progress]\n      2. Implement styles\n      3. Create toggle component\n      4. Update components\n    - [Immediately begins working on todo 1 in the same tool call batch]\n</reasoning>\n  Good: Multi-step feature with dependencies.\n</reasoning>\n</example>\n\n<example>\n  User: Rename getCwd to getCurrentWorkingDirectory across my project\n  Assistant: *Searches codebase, finds 15 instances across 8 files*\n  *Creates todo list with specific items for each file that needs updating*\n\n</reasoning>\n  Complex refactoring requiring systematic tracking across multiple files.\n</reasoning>\n</example>\n\n<example>\n  User: Implement user registration, product catalog, shopping cart, checkout flow.\n  Assistant: *Creates todo list breaking down each feature into specific tasks*\n\n</reasoning>\n  Multiple complex features provided as list requiring organized task management.\n</reasoning>\n</example>\n\n<example>\n  User: Optimize my React app - it's rendering slowly.\n  Assistant: *Analyzes codebase, identifies issues*\n  *Creates todo list: 1) Memoization, 2) Virtualization, 3) Image optimization, 4) Fix state loops, 5) Code splitting*\n\n</reasoning>\n  Performance optimization requires multiple steps across different components.\n</reasoning>\n</example>\n\n### Examples of When NOT to Use the Todo List\n\n<example>\n  User: What does git status do?\n  Assistant: Shows current state of working directory and staging area...\n\n</reasoning>\n  Informational request with no coding task to complete.\n</reasoning>\n</example>\n\n<example>\n  User: Add comment to calculateTotal function.\n  Assistant: *Uses edit tool to add comment*\n\n</reasoning>\n  Single straightforward task in one location.\n</reasoning>\n</example>\n\n<example>\n  User: Run npm install for me.\n  Assistant: *Executes npm install* Command completed successfully...\n\n</reasoning>\n  Single command execution with immediate results.\n</reasoning>\n</example>\n\n### Task States and Management\n\n1. **Task States:**\n  - pending: Not yet started\n  - in_progress: Currently working on\n  - completed: Finished successfully\n  - cancelled: No longer needed\n\n2. **Task Management:**\n  - Update status in real-time\n  - Mark complete IMMEDIATELY after finishing\n  - Only ONE task in_progress at a time\n  - Complete current tasks before starting new ones\n\n3. **Task Breakdown:**\n  - Create specific, actionable items\n  - Break complex tasks into manageable steps\n  - Use clear, descriptive names\n\n4. **Parallel Todo Writes:**\n  - Prefer creating the first todo as in_progress\n  - Start working on todos by using tool calls in the same tool call batch\n  - Batch todo updates with other tool calls for better latency and lower costs for the user\n\nWhen in doubt, use this tool. Proactive task management demonstrates attentiveness and ensures complete requirements.",
  "parameters": {
    "type": "object",
    "properties": {
      "merge": {
        "type": "boolean",
        "description": "Whether to merge the todos with the existing todos. If true, the todos will be merged into the existing todos based on the id field. You can leave unchanged properties undefined. If false, the new todos will replace the existing todos."
      },
      "todos": {
        "type": "array",
        "description": "Array of todo items to write to the workspace",
        "items": {
          "type": "object",
          "properties": {
            "content": {
              "type": "string",
              "description": "The description/content of the todo item",
              "maxLength": 70
            },
            "status": {
              "type": "string",
              "enum": ["pending", "in_progress", "completed", "cancelled"],
              "description": "The current status of the todo item"
            },
            "id": {
              "type": "string",
              "description": "Unique identifier for the todo item"
            }
          },
          "required": ["content", "status", "id"]
        },
        "minItems": 2
      }
    },
    "required": ["merge", "todos"]
  }
}
```

### 7. search_replace
```json
{
  "name": "search_replace",
  "description": "Performs exact string replacements in files.\n\nUsage:\n- When editing text, ensure you preserve the exact indentation (tabs/spaces) as it appears before.\n- ALWAYS prefer editing existing files in the codebase. NEVER write new files unless explicitly required.\n- Only use emojis if the user explicitly requests it. Avoid adding emojis to files unless asked.\n- The edit will FAIL if old_string is not unique in the file. Either provide a larger string with more surrounding context to make it unique or use replace_all to change every instance of old_string.\n- Use replace_all for replacing and renaming strings across the file. This parameter is useful if you want to rename a variable for instance.\n- To create or overwrite a file, you should prefer the write tool.",
  "parameters": {
    "type": "object",
    "properties": {
      "file_path": {
        "type": "string",
        "description": "The path to the file to modify. Always specify the target file as the first argument. You can use either a relative path in the workspace or an absolute path."
      },
      "old_string": {
        "type": "string",
        "description": "The text to replace"
      },
      "new_string": {
        "type": "string",
        "description": "The text to replace it with (must be different from old_string)"
      },
      "replace_all": {
        "type": "boolean",
        "description": "Replace all occurences of old_string (default false)"
      }
    },
    "required": ["file_path", "old_string", "new_string"]
  }
}
```

### 8. list_dir
```json
{
  "name": "list_dir",
  "description": "Lists files and directories in a given path.\nThe 'target_directory' parameter can be relative to the workspace root or absolute.\nYou can optionally provide an array of glob patterns to ignore with the \"ignore_globs\" parameter.\n\nOther details:\n- The result does not display dot-files and dot-directories.\n",
  "parameters": {
    "type": "object",
    "properties": {
      "target_directory": {
        "type": "string",
        "description": "Path to directory to list contents of."
      },
      "ignore_globs": {
        "type": "array",
        "items": {
          "type": "string"
        },
        "description": "Optional array of glob patterns to ignore.\nAll patterns match anywhere in the target directory. Patterns not starting with \"**/\" are automatically prepended with \"**/\".\n\nExamples:\n\t- \"*.js\" (becomes \"**/*.js\") - ignore all .js files\n\t- \"**/node_modules/**\" - ignore all node_modules directories\n\t- \"**/test/**/test_*.ts\" - ignore all test_*.ts files in any test directory\n"
      }
    },
    "required": ["target_directory"]
  }
}
```

### 9. glob_file_search
```json
{
  "name": "glob_file_search",
  "description": "\nTool to search for files matching a glob pattern\n\n- Works fast with codebases of any size\n- Returns matching file paths sorted by modification time\n- Use this tool when you need to find files by name patterns\n- You have the capability to call multiple tools in a single response. It is always better to speculatively perform multiple searches that are potentially useful as a batch.\n",
  "parameters": {
    "type": "object",
    "properties": {
      "target_directory": {
        "type": "string",
        "description": "Path to directory to search for files in. If not provided, defaults to Cursor workspace roots."
      },
      "glob_pattern": {
        "type": "string",
        "description": "The glob pattern to match files against.\nPatterns not starting with \"**/\" are automatically prepended with \"**/\" to enable recursive searching.\n\nExamples:\n\t- \"*.js\" (becomes \"**/*.js\") - find all .js files\n\t- \"**/node_modules/**\" - find all node_modules directories\n\t- \"**/test/**/test_*.ts\" - find all test_*.ts files in any test directory\n"
      }
    },
    "required": ["glob_pattern"]
  }
}
```

### 10. list_mcp_resources
```json
{
  "name": "list_mcp_resources",
  "description": "List available resources from configured MCP servers. Each returned resource will include all standard MCP resource fields plus a 'server' field indicating which server the resource belongs to.",
  "parameters": {
    "type": "object",
    "properties": {
      "server": {
        "type": "string",
        "description": "Optional server identifier to filter resources by. If not provided, resources from all servers will be returned."
      }
    },
    "required": []
  }
}
```

### 11. fetch_mcp_resource
```json
{
  "name": "fetch_mcp_resource",
  "description": "Reads a specific resource from an MCP server, identified by server name and resource URI. Optionally, set downloadPath (relative to the workspace) to save the resource to disk; when set, the resource will be downloaded and not returned to the model.",
  "parameters": {
    "type": "object",
    "properties": {
      "server": {
        "type": "string",
        "description": "The MCP server identifier"
      },
      "uri": {
        "type": "string",
        "description": "The resource URI to read"
      },
      "downloadPath": {
        "type": "string",
        "description": "Optional relative path in the workspace to save the resource to. When set, the resource is written to disk and is not returned to the model."
      }
    },
    "required": ["server", "uri"]
  }
}
```

### 12. mcp_context7_url_resolve-library-id
```json
{
  "name": "mcp_context7_url_resolve-library-id",
  "description": "Resolves a package/product name to a Context7-compatible library ID and returns matching libraries.\n\nYou MUST call this function before 'query-docs' to obtain a valid Context7-compatible library ID UNLESS the user explicitly provides a library ID in the format '/org/project' or '/org/project/version' in their query.\n\nSelection Process:\n1. Analyze the query to understand what library/package the user is looking for\n2. Return the most relevant match based on:\n- Name similarity to the query (exact matches prioritized)\n- Description relevance to the query's intent\n- Documentation coverage (prioritize libraries with higher Code Snippet counts)\n- Source reputation (consider libraries with High or Medium reputation more authoritative)\n- Benchmark Score: Quality indicator (100 is the highest score)\n\nResponse Format:\n- Return the selected library ID in a clearly marked section\n- Provide a brief explanation for why this library was chosen\n- If multiple good matches exist, acknowledge this but proceed with the most relevant one\n- If no good matches exist, clearly state this and suggest query refinements\n\nFor ambiguous queries, request clarification before proceeding with a best-guess match.\n\nIMPORTANT: Do not call this tool more than 3 times per question. If you cannot find what you need after 3 calls, use the best result you have.",
  "parameters": {
    "type": "object",
    "properties": {
      "query": {
        "type": "string",
        "description": "The user's original question or task. This is used to rank library results by relevance to what the user is trying to accomplish. IMPORTANT: Do not include any sensitive or confidential information such as API keys, passwords, credentials, or personal data in your query."
      },
      "libraryName": {
        "type": "string",
        "description": "Library name to search for and retrieve a Context7-compatible library ID."
      }
    },
    "required": ["query", "libraryName"],
    "additionalProperties": false,
    "$schema": "http://json-schema.org/draft-07/schema#"
  }
}
```

### 13. mcp_context7_url_query-docs
```json
{
  "name": "mcp_context7_url_query-docs",
  "description": "Retrieves and queries up-to-date documentation and code examples from Context7 for any programming library or framework.\n\nYou must call 'resolve-library-id' first to obtain the exact Context7-compatible library ID required to use this tool, UNLESS the user explicitly provides a library ID in the format '/org/project' or '/org/project/version' in their query.\n\nIMPORTANT: Do not call this tool more than 3 times per question. If you cannot find what you need after 3 calls, use the best information you have.",
  "parameters": {
    "type": "object",
    "properties": {
      "libraryId": {
        "type": "string",
        "description": "Exact Context7-compatible library ID (e.g., '/mongodb/docs', '/vercel/next.js', '/supabase/supabase', '/vercel/next.js/v14.3.0-canary.87') retrieved from 'resolve-library-id' or directly from user query in the format '/org/project' or '/org/project/version'."
      },
      "query": {
        "type": "string",
        "description": "The question or task you need help with. Be specific and include relevant details. Good: 'How to set up authentication with JWT in Express.js' or 'React useEffect cleanup function examples'. Bad: 'auth' or 'hooks'. IMPORTANT: Do not include any sensitive or confidential information such as API keys, passwords, credentials, or personal data in your query."
      }
    },
    "required": ["libraryId", "query"],
    "additionalProperties": false,
    "$schema": "http://json-schema.org/draft-07/schema#"
  }
}
```

### 14. mcp_MiniMax_API_Docs_SearchMiniMaxApiDocs
```json
{
  "name": "mcp_MiniMax_API_Docs_SearchMiniMaxApiDocs",
  "description": "Search across the MiniMax API Docs knowledge base to find relevant information, code examples, API references, and guides. Use this tool when you need to answer questions about MiniMax API Docs, find specific documentation, understand how features work, or locate implementation details. The search returns contextual content with titles and direct links to the documentation pages.",
  "parameters": {
    "type": "object",
    "properties": {
      "query": {
        "type": "string"
      }
    },
    "required": ["query"],
    "additionalProperties": false,
    "$schema": "http://json-schema.org/draft-07/schema#"
  }
}
```

## Metadata from Current Message

### User Info
```
<user_info>
OS Version: win32 10.0.26200
Current Date: Wednesday Dec 31, 2025
Shell: C:\Program Files\PowerShell\7\pwsh.exe
Workspace Path: E:\VOID-EDITOR\Testing-Aurora-Agent\aurora-doc
Terminals folder: c:\Users\Alvan\.cursor\projects\e-VOID-EDITOR-Testing-Aurora-Agent-aurora-doc\terminals
</user_info>
```

### Additional Data
```
<additional_data>
Below are some potentially helpful/relevant pieces of information for figuring out how to respond:
</additional_data>
```

### Rules Section
```
<rules>
The rules section has a number of possible rules/memories/context that you should consider. In each subsection, we provide instructions about what information the subsection contains and how you should consider/follow the contents of the subsection.

<mcp_instructions description="Instructions provided by MCP servers to help use them properly">
Server: context7_url
Use this server to retrieve up-to-date documentation and code examples for any library.
</mcp_instructions>

<user_rules description="These are rules set by the user that you should follow if appropriate.">
- LOOK WHENEVER USER ASK QUESTION ABOUT RELATED ISSUE NEVER CREATE ANY KIND OF .MD FILE WITH ANALYZATIONS SUMMARY CUZ USER MAY ASK YOU TO ANSWER HIM JUST ANALYZE USER REQST DO IT CORRECTLY ANSWER USER NEVER BLOAT CODEBASE WITH .MD FILE NEVER CREATE .MD FILE UNTILL USER TOLD YOU TO CREATE JUST ONLY CREATE README.md if its not created according to PROJECT NEVER USE UNICODE EMOJI WITHIN CODE WITHIN SCRIPT ALWAYS BE PROFESSIONAL
</user_rules>

</rules>
```

### Project Layout
```
<project_layout>
Below is a snapshot of the current workspace's file structure at the start of the conversation. This snapshot will NOT update during the conversation.

e:\VOID-EDITOR\Testing-Aurora-Agent\aurora-doc\
  - app\
    - components\
      - Navbar.tsx
      - Sidebar.tsx
    - favicon.ico
    - globals.css
    - layout.tsx
    - page.tsx
  - eslint.config.mjs
  - next-env.d.ts
  - next.config.ts
  - node_modules\
  - package.json
  - pnpm-lock.yaml
  - postcss.config.mjs
  - public\
    - file.svg
    - globe.svg
    - next.svg
    - vercel.svg
    - window.svg
  - README.md
  - tsconfig.json


</project_layout>
```

### User Query Field
```
<user_query>
perfect now how u write the file how u read the file create all tools usage.md file including metadata u get with this message including user query filed 
</user_query>
```
