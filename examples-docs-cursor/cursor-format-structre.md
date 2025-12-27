# Cursor Format Structure

This document describes the exact format and structure of metadata received with each user query in Cursor.

## 1. User Query

The actual user query text:
```
what project is this let me know
```

## 2. User Info Section

```xml
<user_info>
OS Version: win32 10.0.26200
Shell: C:\Program Files\PowerShell\7\pwsh.exe
Workspace Path: E:\VOID-EDITOR\jules_aurora-agent-frontend
</user_info>
```

**Contains:**
- OS Version (e.g., `win32 10.0.26200`)
- Shell path (e.g., `C:\Program Files\PowerShell\7\pwsh.exe`)
- Workspace Path (absolute path to project root)

## 3. Rules Section

Multiple subsections containing various rules and instructions:

### 3a. Always Applied Workspace Rules

```xml
<always_applied_workspace_rules description="These are workspace-level rules that the agent must always follow.">
[Full content of CLAUDE.md file - 249 lines]
</always_applied_workspace_rules>
```

**Contains:**
- Complete `CLAUDE.md` content
- Project architecture documentation
- Development commands
- Code patterns and conventions
- Technology stack details
- File structure notes

### 3b. MCP Instructions

```xml
<mcp_instructions description="Instructions provided by MCP servers to help use them properly">
Server: context7_url
Use this server to retrieve up-to-date documentation and code examples for any library.
</mcp_instructions>
```

**Contains:**
- MCP server names and their usage instructions

### 3c. Citing Code Rules

```xml
<citing_code>
[Detailed instructions on code citation format]
- CODE REFERENCES format: startLine:endLine:filepath
- MARKDOWN CODE BLOCKS format: language tag only
- Rules about when to use each format
- Formatting requirements (no indentation, no line numbers in content, etc.)
</citing_code>
```

**Contains:**
- Rules for citing existing code vs. proposing new code
- Format specifications
- Examples of correct and incorrect usage

### 3d. User Rules

```xml
<user_rules description="These are rules set by the user that you should follow if appropriate.">
- LOOK WHENEVER USER ASK QUESTION ABOUT RELATED ISSUE NEVER CREATE ANY KIND OF .MD FILE WITH ANALYZATIONS SUMMARY CUZ USER MAY ASK YOU TO ANSWER HIM JUST ANALYZE USER REQST DO IT CORRECTLY ANSWER USER NEVER BLOAT CODEBASE WITH .MD FILE NEVER CREATE .MD FILE UNTILL USER TOLD YOU TO CREATE JUST ONLY CREATE README.md if its not created according to PROJECT NEVER USE UNICODE EMOJI WITHIN CODE WITHIN SCRIPT ALWAYS BE PROFESSIONAL
</user_rules>
```

**Contains:**
- User-specific preferences and constraints
- Project-specific rules

## 4. Project Layout Section

```xml
<project_layout>
Below is a snapshot of the current workspace's file structure at the start of the conversation. This snapshot will NOT update during the conversation.

e:\VOID-EDITOR\jules_aurora-agent-frontend\
  - app-icon.svg
  - CLAUDE.md
  - cursor-systempromt.md
  - [complete directory tree with all files and folders]
  - [file counts for directories]
  - [note about ignored files]

Note: File extension counts do not include files ignored by .gitignore.
</project_layout>
```

**Contains:**
- Complete directory tree structure
- All files and folders in the workspace
- File counts for directories (e.g., `[1196 files in subtree: 1196 *.svg]`)
- Note about `.gitignore` exclusions
- **Important:** This snapshot is static and does NOT update during conversation

## 5. Additional Data Section

```xml
<additional_data>
Below are some helpful pieces of information that may be relevant to the current conversation:

<open_and_recently_viewed_files>
Recently viewed files (recent at the top, oldest at the bottom):
- e:\VOID-EDITOR\jules_aurora-agent-frontend\README.md (total lines: 249)
- e:\VOID-EDITOR\jules_aurora-agent-frontend\tool-new.md (total lines: 187)
- e:\VOID-EDITOR\jules_aurora-agent-frontend\cursor-format-structre.md (total lines: 161)
- e:\VOID-EDITOR\jules_aurora-agent-frontend\cursor-systempromt.md (total lines: 432)
- e:\VOID-EDITOR\jules_aurora-agent-frontend\src-tauri\src\commands\mod.rs (total lines: 614)
- e:\VOID-EDITOR\jules_aurora-agent-frontend\src-tauri\src\main.rs (total lines: 8)
- e:\VOID-EDITOR\jules_aurora-agent-frontend\src-tauri\src\lib.rs (total lines: 75)

Files that are currently open and visible in the user's IDE:
- e:\VOID-EDITOR\jules_aurora-agent-frontend\README.md (currently focused file, cursor is on line 1, total lines: 249)

Note: these files may or may not be relevant to the current conversation. Use the read_file tool if you need to get the contents of some of them.
</additional_data>
```

**Contains:**
- List of recently viewed files (most recent first)
- File paths with total line counts
- Currently open files in IDE (with focus status and cursor position)
- Note about potential relevance

## 6. Attached Files/Folders Section (When Files or Folders Are Referenced)

### 6a. Attached Files Format

When a user attaches a file using `@filename` syntax in their query, the file contents are included in an `<attached_files>` section:

```xml
<attached_files>

<file_contents path="README.md" isFullFile="true">
     1|# CLAUDE.md
     2|
     3|This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.
     4|
     5|## Development Commands
     6|
     7|```bash
     8|# Start development environment (Tauri + Vite dev server)
     9|pnpm tauri:dev
    10|
    11|# Frontend only (runs on http://localhost:5173)
    12|pnpm dev
    13|
    14|# Build for production
    15|pnpm tauri:build
    16|
    17|# Frontend build only
    18|pnpm build
    19|
    20|# Lint code
    21|pnpm lint
    22|```
    23|
    24|**Note:** Use `pnpm` as the package manager for this project.
    25|
    26|## Project Overview
    27|
    28|Aurora is an AI-powered agentic code editor built with Tauri (Rust backend + React frontend). It provides a VS Code-like interface with an AI assistant that can execute tools to manipulate files, run commands, and navigate workspaces.
    29|
    30|### Technology Stack
    31|
    32|**Frontend:**
    33|- React 18.3.1 + TypeScript
    34|- Vite 7.2.4 (build tool)
    35|- Monaco Editor (code editing)
    36|- Zustand 5.0.9 (state management)
    37|- Tailwind CSS (styling with VS Code-inspired dark theme)
    38|- react-resizable-panels (layout)
    39|
    40|**Backend (Rust):**
    41|- Tauri 2.x
    42|- tauri-plugin-fs (file operations)
    43|- tauri-plugin-shell (command execution)
    44|- tauri-plugin-dialog (file dialogs)
    45|- tauri-plugin-process, tauri-plugin-os, tauri-plugin-clipboard-manager
    46|- rusqlite (SQLite database for state persistence)
    47|- Tokio (async runtime)
    48|
    49|## Architecture
    50|
    51|### State Management (Zustand Stores)
    52|
    53|The app uses six specialized Zustand stores located in `src/store/`:
    54|
    55|1. **useSettingsStore** - Global app settings (LLM providers, model selection, tool approval, editor settings)
    56|   - Persists to localStorage (`aurora-settings`, version 3)
    57|   - Model selection format: `"providerId:model"` (e.g., `"glm:glm-4.7"`)
    58|   - Supports preset providers (GLM, DeepSeek, OpenAI) and custom providers
    59|   - Provider config includes: `baseUrl`, `apiKey`, `model`, `contextWindow`, `maxOutputTokens`, `supportsThinking`, `customHeaders`, `customParams`, `providerType`
    60|
    61|2. **useChatStore** - Chat messages and loading state
    62|   - Tool approval workflow state
    63|   - Message CRUD operations
    64|
    65|3. **useThreadStore** - Conversation thread management
    66|   - Persists threads to `.aurora/threads/{threadId}.json`
    67|   - Thread summaries for history
    68|   - Auto-saves on message changes
    69|
    70|4. **useEditorStore** - Code editor tabs
    71|   - Open tabs management
    72|   - Active tab tracking
    73|   - File content caching
    74|   - Dirty state tracking
    75|
    76|5. **useWorkspaceStore** - File explorer
    77|   - Root path management
    78|   - File tree structure
    79|   - Folder expansion state
    80|
    81|6. **useUiStore** - UI state
    82|   - Theme toggling
    83|   - Modal states
    84|   - Chat panel visibility
    85|   - Detached chat window state
    86|
    87|### Database Persistence System (SQLite)
    88|
    89|The app uses SQLite for persistent state storage, managed through a repository pattern.
    90|
    91|**Database Location:**
    92|- Windows: `%APPDATA%\com.aurora.agent\aurora.db`
    93|- macOS: `~/Library/Application Support/com.aurora.agent/aurora.db`
    94|- Linux: `~/.config/com.aurora.agent/aurora.db`
    95|
    96|**Architecture:** `src-tauri/src/db/`
    97|
    98|```
    99|db/
   100|  mod.rs          - Database manager, exposes repositories
   101|  connection.rs   - SQLite connection with WAL mode, performance tuning
   102|  error.rs        - DbError enum (Sqlite, Serialization, Io, Migration, NotFound, InvalidData)
   103|  schema.rs       - Table definitions, schema versioning
   104|  migrations.rs   - Version-based migration system
   105|  models.rs       - Rust structs (WorkspaceState, EditorState, ExplorerState, etc.)
   106|  repositories/
   107|    workspace.rs  - WorkspaceRepository (CRUD for workspace state)
   108|    editor.rs     - EditorRepository (CRUD for editor state per file)
   109|    explorer.rs   - ExplorerRepository (CRUD for file explorer state)
   110|```
    111|
    112|**Frontend Service:** `src/services/database.ts`
    113|- `DatabaseService` singleton class
    114|- Invokes Tauri commands for state operations
    115|- Types defined in `src/types/database.ts`
    116|
    117|**Tables:**
    118|1. `workspace_state` - Open tabs, panel sizes per workspace
    119|2. `editor_state` - Cursor position, scroll offset, folded regions per file
    120|3. `explorer_state` - Expanded folders, selected file per workspace
    121|4. `threads` - Chat threads with messages (future use)
    122|5. `settings` - Key-value settings storage (future use)
    123|6. `schema_version` - Database version tracking
    124|
    125|**Tauri State Commands:**
    126|- `save_workspace_state` / `get_workspace_state`
    127|- `save_editor_state` / `get_editor_state`
    128|- `save_explorer_state` / `get_explorer_state`
    129|
    130|### Application Flow
    131|
    132|```
    133|User Action → Component Event Handler → Zustand Store Action → Tauri Command → Rust Backend → Result → Store Update → Component Re-render
    134|```
    135|
    136|**Entry Points:**
    137|- Frontend: `src/main.tsx` → `src/App.tsx` (determines main vs detached chat view)
    138|- Backend: `src-tauri/src/lib.rs` → Tauri app setup with plugins
    139|
    140|### Tool System Architecture
    141|
    142|Located in `src/tools/`:
    143|
    144|- **definitions/** - Tool schemas (OpenAI function format)
    145|   - `file-tools.ts` - File operations (read, write, create, delete)
    146|   - `shell-tools.ts` - Shell command execution
    147|   - `workspace-tools.ts` - Workspace navigation, search
    148|   - `editor-tools.ts` - Editor operations (open files, tabs)
    149|
    150|- **executors/** - Tool implementations
    151|   - Each tool has a risk level: low (auto-approve), medium/high (requires approval)
    152|
    153|- **registry.ts** - Central tool registry
    154|
    155|Tools are called by the AI agent through the agent service, executed via Tauri commands, and results are streamed back to the LLM.
    156|
    157|### LLM Provider System
    158|
    159|**Service:** `src/services/llm-provider.ts`
    159|
    160|- Singleton pattern for provider instance
    161|- Supports multiple providers: OpenAI, DeepSeek, GLM, custom
    162|- Provider-specific handling:
    163|   - **DeepSeek**: `reasoning_content` field, no temperature for reasoner
    164|   - **GLM**: Full thinking mode support
    165|   - **OpenAI**: Standard implementation
    166|- Streaming SSE (Server-Sent Events) implementation
    167|- Custom headers and parameters support via provider config
    168|
    169|**Agent Service:** `src/services/agent-service.ts`
    170|- Orchestrates AI conversation with tool execution
    171|- Conversation loop: LLM → Tool Calls → Execution → Response
    172|- Max 25 tool iterations per request
    173|
    174|### Rust Backend (Tauri Commands)
    175|
    176|**File System Commands:** `src-tauri/src/commands/mod.rs`
    177|- `read_directory` - List directory contents (filters node_modules, target, dist)
    178|- `read_file_content` - Read file to string
    179|- `write_file_content` - Write string to file (creates parent dirs)
    180|- `execute_command` - Execute shell command (cmd on Windows, sh on Unix)
    181|- `get_system_info` - Get OS, arch, hostname
    182|- `get_workspace_root` - Get current workspace root path
    183|- `create_file` / `create_folder` / `delete_path` / `rename_path`
    184|
    185|**State Persistence Commands:** `src-tauri/src/commands/state.rs`
    186|- `save_workspace_state` / `get_workspace_state` - Workspace tabs and panel layout
    187|- `save_editor_state` / `get_editor_state` - Per-file cursor, scroll, folds
    188|- `save_explorer_state` / `get_explorer_state` - Expanded folders, selection
    189|
    190|All file commands return `Result<T, String>`. State commands return `Result<T, DbError>` (DbError is serializable for Tauri IPC).
    191|
    192|### Component Architecture
    193|
    194|**Layout:** `src/components/layout/MainLayout.tsx`
    195|- Three-panel layout using react-resizable-panels: Explorer (18%) | Editor (57%) | Chat (25%)
    196|- Custom title bar (no decorations, window controls in TitleBar component)
    197|- Detachable chat window (separate Tauri window at route `/chat-detached`)
    198|
    199|**Key Components:**
    200|- `ChatPanel` - Chat interface with message history, input, thread sidebar
    201|- `EditorPanel` - Monaco editor with tab bar
    202|- `FileExplorer` - File tree with expand/collapse
    203|
    204|### Thread Persistence
    205|
    206|Threads are stored as JSON files in `.aurora/threads/{threadId}.json`. Each thread contains messages and metadata. The thread store auto-saves when messages change.
    207|
    208|### Unique Features
    209|
    210|1. **Detachable Chat Window** - Chat can open in separate Tauri window with cross-window state sync via `useWindowStateSync` hook
    211|
    212|2. **Timeline Event System** - Sequential tracking of AI response components (thinking, tool, content events) for granular display
    213|
    214|3. **Multi-Provider LLM Support** - Preset + custom providers with explicit `providerType` field for correct handling
    215|
    216|4. **Thinking Mode** - Provider-specific thinking content (DeepSeek uses `reasoning_content`, GLM uses `thinking` parameter)
    217|
    218|5. **VS Code-Inspired Design** - Color hierarchy: titlebar (darkest) → tabs → sidebar → editor (lightest)
    219|
    220|## File Structure Notes
    221|
    222|- **Settings modal:** `src/components/modals/SettingsPanel.tsx`
    223|- **Tool approval modal:** `src/components/modals/ToolApprovalModal.tsx`
    224|- **Type definitions:** `src/types/index.ts` (shared), `src/services/llm-types.ts` (LLM-specific)
    225|- **Database types:** `src/types/database.ts` (WorkspaceState, EditorState, ExplorerState)
    226|- **Database service:** `src/services/database.ts` (frontend database API)
    227|- **Rust database module:** `src-tauri/src/db/` (SQLite persistence layer)
    228|- **Tauri capabilities:** `src-tauri/capabilities/default.json` - defines frontend permissions
    229|
    230|## Important Patterns
    231|
    232|- **Provider config access:** Use `useSettingsStore.getState().getLLMConfig()` to get current provider config
    233|- **Model selection format:** Always `"providerId:model"` (e.g., `"deepseek:deepseek-chat"`)
    234|- **Tool execution:** Tools go through agent service → Tauri commands → Rust executors
    235|- **State updates:** Always update via Zustand store actions, never mutate directly
    236|- **Thread saving:** Automatic via useThreadStore when messages change
    237|- **Database access:** Import `databaseService` from `src/services/database.ts`, use async methods
    238|- **Database repository pattern:** In Rust, use `db.workspace()`, `db.editor()`, `db.explorer()` to get repositories
    239|
    240|## Provider-Specific Notes
    241|
    242|When adding new LLM providers or debugging provider issues:
    243|- Check `providerType` field in settings (determines how the provider is handled)
    244|- Custom headers go in `customHeaders` object
    245|- Custom request params go in `customParams` object
    246|- DeepSeek reasoner (`deepseek-reasoner`) ignores temperature parameter
    247|- GLM thinking mode requires `thinking: true` in request body
    248|
</file_contents>

</attached_files>
```

**Format Details:**
- Wrapped in `<attached_files>` tags
- Each file in `<file_contents>` tag with attributes:
  - `path="filename"` - Relative path to the file
  - `isFullFile="true"` - Indicates complete file content (vs. partial selection)
- File content includes line numbers (1-based) at the start of each line
- Content is indented with spaces (typically 5-6 spaces before line numbers)
- Multiple files can be attached in a single query

**Example Query with Attached File:**
```
@README.md now what format u get exact format query cuz i attach a file in query so i wanna know what format u see this query and add this query exact format into themd file as well
```

**When This Section Appears:**
- Only when user explicitly references files using `@filename` syntax
- File contents are automatically included in the metadata
- No need to call `read_file` tool - content is already available

### 6b. Attached Folders Format

When a user attaches a folder using `@folderpath` syntax, the format includes a header section before the query:

**Header Format (appears before user query):**
```
Here are some folder(s) I manually attached to my message:
Folder: /e:/VOID-EDITOR/jules_aurora-agent-frontend/src-tauri/capabilities
Contents of directory:

[file] default.json (1.6KB, 58 lines)
```

**Then in `<attached_files>` section:**
```xml
<attached_files>

<file_contents path="src-tauri/capabilities/default.json" isFullFile="true">
     1|{
     2|  "$schema": "https://schema.tauri.app/config/2/capability",
     3|  "identifier": "default",
     ...
    58|}
</file_contents>

</attached_files>
```

**Format Details for Folders:**
- Header appears **before** the user query text
- Header format: `"Here are some folder(s) I manually attached to my message:"`
- Folder path shown as: `Folder: /e:/absolute/path/to/folder`
- Directory listing header: `"Contents of directory:"`
- Files listed with format: `[file] filename.ext (size, line count)`
- File sizes shown (e.g., `1.6KB`)
- Line counts shown (e.g., `58 lines`)
- Files from the folder are then included in `<attached_files>` section with full content
- Folder path in header uses absolute path format: `/e:/path/to/folder` (Windows style with forward slashes)
- File paths in `<file_contents>` are relative to workspace root (e.g., `src-tauri/capabilities/default.json`)

**Example Query with Attached Folder:**
```
@src-tauri/capabilities what about now cuz i attach a folder now instead of file what current exact format update the md file
```

**Differences from File Attachments:**
- Folder attachments include a header section before the query
- Header shows folder path and directory listing
- Multiple files from the folder can be included in `<attached_files>`
- Folder path uses absolute format in header, but file paths in content are relative

## Complete Structure Summary

```
1. <user_info> - OS, Shell, Workspace Path
2. <rules>
   ├─ <always_applied_workspace_rules> - Full CLAUDE.md content
   ├─ <mcp_instructions> - MCP server instructions
   ├─ <citing_code> - Code citation format rules
   └─ <user_rules> - User-specific preferences
3. <project_layout> - Static snapshot of file structure
4. <additional_data>
   └─ <open_and_recently_viewed_files> - Recent file activity
5. Folder Attachment Header (optional) - When @folderpath is used
   └─ Shows folder path and directory listing before query
6. <attached_files> (optional) - File/folder contents when @filename or @folderpath is used
   └─ <file_contents> - Complete file content with line numbers
7. User Query - The actual question/request
```

## Notes

- **Project Layout** is a static snapshot that does NOT update during the conversation
- **Recently Viewed Files** updates with each query
- **Workspace Rules** contain the complete `CLAUDE.md` content (249 lines in this project)
- **Attached Files** section only appears when user uses `@filename` or `@folderpath` syntax in query
- When files are attached, their complete content is included with line numbers (no need to call `read_file` tool)
- **Folder attachments** include a header section before the query showing folder path and directory listing
- Folder attachment headers show absolute paths in format `/e:/path/to/folder` (Windows with forward slashes)
- File paths in `<attached_files>` are relative to workspace root (e.g., `README.md` or `src-tauri/capabilities/default.json`)
- All metadata is wrapped in XML-like tags for structure
- Project layout file paths are absolute paths (e.g., `E:\VOID-EDITOR\jules_aurora-agent-frontend\...`)

