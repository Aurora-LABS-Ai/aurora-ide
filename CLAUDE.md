# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Commands

```bash
# Start development environment (Tauri + Vite dev server)
pnpm tauri:dev

# Frontend only (runs on http://localhost:5173)
pnpm dev

# Build for production
pnpm tauri:build

# Frontend build only
pnpm build

# Lint code
pnpm lint
```

**Note:** Use `pnpm` as the package manager for this project.

## Project Overview

Aurora is an AI-powered agentic code editor built with Tauri (Rust backend + React frontend). It provides a VS Code-like interface with an AI assistant that can execute tools to manipulate files, run commands, and navigate workspaces.

### Technology Stack

**Frontend:**
- React 18.3.1 + TypeScript
- Vite 7.2.4 (build tool)
- Monaco Editor (code editing)
- Zustand 5.0.9 (state management)
- Tailwind CSS (styling with VS Code-inspired dark theme)
- react-resizable-panels (layout)

**Backend (Rust):**
- Tauri 2.x
- tauri-plugin-fs (file operations)
- tauri-plugin-shell (command execution)
- tauri-plugin-dialog (file dialogs)
- tauri-plugin-process, tauri-plugin-os, tauri-plugin-clipboard-manager
- rusqlite (SQLite database for state persistence)
- Tokio (async runtime)

## Architecture

### State Management (Zustand Stores)

The app uses nine specialized Zustand stores located in `src/store/`:

1. **useSettingsStore** - Global app settings (LLM providers, model selection, tool approval, editor settings)
   - Persists to localStorage (`aurora-settings`, version 3)
   - Model selection format: `"providerId:model"` (e.g., `"glm:glm-4.7"`)
   - Supports preset providers (GLM, DeepSeek, OpenAI) and custom providers
   - Provider config includes: `baseUrl`, `apiKey`, `model`, `contextWindow`, `maxOutputTokens`, `supportsThinking`, `customHeaders`, `customParams`, `providerType`

2. **useChatStore** - Chat messages and loading state
   - Tool approval workflow state
   - Message CRUD operations
   - Syncs `todo_write` tool calls to TaskStore

3. **useThreadStore** - Conversation thread management
   - Persists threads to `.aurora/threads/{threadId}.json`
   - Thread summaries for history
   - Auto-saves on message changes

4. **useEditorStore** - Code editor tabs
   - Open tabs management
   - Active tab tracking
   - File content caching
   - Dirty state tracking

5. **useWorkspaceStore** - File explorer
   - Root path management
   - File tree structure
   - Folder expansion state
   - Filesystem watcher integration (auto-refreshes on file changes)

6. **useUiStore** - UI state
   - Theme toggling
   - Modal states
   - Chat panel visibility
   - Detached chat window state

7. **useDragStore** - Drag-drop state for file operations
   - Pending drag state (before threshold met)
   - Active drag state (path, name, mouse position)
   - Drop target tracking (folder, root, editor)
   - 5px movement threshold before drag activates

8. **useTaskStore** - Task management (UI only, not wired to AI)
   - Task list storage (pending, in_progress, completed, cancelled)
   - Task visibility state
   - Used by `TaskView` component to display tasks from `todo_write` tool calls
   - Note: Task system exists but `todo_write` tool is not registered in tool registry

9. **useTerminalStore** - Integrated terminal sessions
   - Multiple terminal sessions (PowerShell, Bash)
   - Session management (create, close, switch)
   - Terminal output lines (input, output, error)
   - Current working directory per session
   - Terminal visibility and height state

### Database Persistence System (SQLite)

The app uses SQLite for persistent state storage, managed through a repository pattern.

**Database Location:**
- Windows: `%APPDATA%\com.aurora.agent\aurora.db`
- macOS: `~/Library/Application Support/com.aurora.agent/aurora.db`
- Linux: `~/.config/com.aurora.agent/aurora.db`

**Architecture:** `src-tauri/src/db/`

```
db/
  mod.rs          - Database manager, exposes repositories
  connection.rs   - SQLite connection with WAL mode, performance tuning
  error.rs        - DbError enum (Sqlite, Serialization, Io, Migration, NotFound, InvalidData)
  schema.rs       - Table definitions, schema versioning
  migrations.rs   - Version-based migration system
  models.rs       - Rust structs (WorkspaceState, EditorState, ExplorerState, etc.)
  repositories/
    workspace.rs  - WorkspaceRepository (CRUD for workspace state)
    editor.rs     - EditorRepository (CRUD for editor state per file)
    explorer.rs   - ExplorerRepository (CRUD for file explorer state)
```

**Frontend Service:** `src/services/database.ts`
- `DatabaseService` singleton class
- Invokes Tauri commands for state operations
- Types defined in `src/types/database.ts`

**Tables:**
1. `workspace_state` - Open tabs, panel sizes per workspace
2. `editor_state` - Cursor position, scroll offset, folded regions per file
3. `explorer_state` - Expanded folders, selected file per workspace
4. `threads` - Chat threads with messages (future use)
5. `settings` - Key-value settings storage (LLM providers, tool settings, app settings)
6. `schema_version` - Database version tracking

**Settings Repository:** `src-tauri/src/db/repositories/settings.rs`
- `get_app_settings` / `save_app_settings` - App-wide settings
- `get_all_providers` / `save_provider` / `delete_provider` - LLM provider management
- `get_all_tool_settings` / `set_tool_setting` - Per-tool approval settings

**Tauri State Commands:** `src-tauri/src/commands/state.rs`
- `save_workspace_state` / `get_workspace_state`
- `save_editor_state` / `get_editor_state`
- `save_explorer_state` / `get_explorer_state`

**Tauri Settings Commands:** `src-tauri/src/commands/settings.rs`
- `get_app_settings` / `save_app_settings`
- `get_all_providers` / `get_provider` / `save_provider` / `delete_provider` / `has_providers` / `save_all_providers`
- `get_all_tool_settings` / `set_tool_approval` / `save_all_tool_settings`

### Application Flow

```
User Action → Component Event Handler → Zustand Store Action → Tauri Command → Rust Backend → Result → Store Update → Component Re-render
```

**Entry Points:**
- Frontend: `src/main.tsx` → `src/App.tsx` (determines main vs detached chat view)
- Backend: `src-tauri/src/lib.rs` → Tauri app setup with plugins

### Tool System Architecture

Located in `src/tools/`:

- **definitions/** - Tool schemas (OpenAI function format)
  - `file-tools.ts` - File operations (read, write, create, delete, grep, multi_file_read)
  - `shell-tools.ts` - Shell command execution (execute, spawn, kill, list_processes)
  - `workspace-tools.ts` - Workspace navigation (tree, folder_create, folder_delete, workspace_info)
  - `editor-tools.ts` - Editor operations (open files, tabs, selection, insert text)
  - `risk-levels-enhanced.ts` - Risk level definitions for all tools

- **executors/** - Tool implementations
  - `file-executors-enhanced.ts` - Enhanced file operations with operation logging
  - `shell-executors.ts` - Shell execution with terminal integration
  - `workspace-executors.ts` - Workspace operations
  - `editor-executors.ts` - Editor operations
  - Each tool has a risk level: low (auto-approve), medium/high (requires approval)

- **registry.ts** - Central tool registry
  - Registers all tool definitions and executors
  - Tracks active tool calls
  - Manages tool approval requirements

**Available Tools:**
- **File Tools:** `file_read`, `file_read_lines`, `file_write`, `file_patch`, `file_create`, `file_delete`, `file_exists`, `file_search`, `grep`, `multi_file_read`
- **Workspace Tools:** `workspace_tree`, `folder_create`, `folder_delete`, `workspace_info`
- **Shell Tools:** `shell_execute`, `shell_spawn`, `shell_kill`, `shell_list_processes`
- **Editor Tools:** `editor_open_file`, `editor_get_active_file`, `editor_get_selection`, `editor_insert_text`, `editor_get_open_tabs`, `editor_close_tab`

**Note:** `todo_write` tool exists in UI (`TaskView` component) but is NOT registered in the tool registry, so AI cannot use it.

Tools are called by the AI agent through the agent service, executed via Tauri commands, and results are streamed back to the LLM.

### LLM Provider System

**Service:** `src/services/llm-provider.ts`

- Singleton pattern for provider instance
- Supports multiple providers: OpenAI, DeepSeek, GLM, custom
- Provider-specific handling:
  - **DeepSeek**: `reasoning_content` field, no temperature for reasoner
  - **GLM**: Full thinking mode support
  - **OpenAI**: Standard implementation
- Streaming SSE (Server-Sent Events) implementation
- Custom headers and parameters support via provider config

**Agent Service:** `src/services/agent-service.ts`
- Orchestrates AI conversation with tool execution
- Conversation loop: LLM → Tool Calls → Execution → Response
- Max 25 tool iterations per request

### Rust Backend (Tauri Commands)

**File System Commands:** `src-tauri/src/commands/mod.rs`
- `read_directory` - List directory contents (filters node_modules, target, dist, hidden files except .aurora)
- `read_file_content` - Read file to string
- `write_file_content` - Write string to file (creates parent dirs)
- `execute_command` - Execute shell command (PowerShell on Windows, sh on Unix, supports bash profile)
- `get_system_info` - Get OS, arch, hostname
- `get_workspace_root` - Get current workspace root path
- `create_file` / `create_folder` / `delete_path` / `rename_path` / `copy_path`
- `start_fs_watcher` / `stop_fs_watcher` - Filesystem watcher (emits `fs-changed` events)
- `reveal_in_explorer` - Open file/folder in system file explorer (Windows Explorer, Finder, etc.)
- `open_in_terminal` - Open terminal at specified path (Windows Terminal, Terminal.app, etc.)

**State Persistence Commands:** `src-tauri/src/commands/state.rs`
- `save_workspace_state` / `get_workspace_state` - Workspace tabs and panel layout
- `save_editor_state` / `get_editor_state` - Per-file cursor, scroll, folds
- `save_explorer_state` / `get_explorer_state` - Expanded folders, selection

All file commands return `Result<T, String>`. State commands return `Result<T, DbError>` (DbError is serializable for Tauri IPC).

### Component Architecture

**Layout:** `src/components/layout/MainLayout.tsx`
- Three-panel layout using react-resizable-panels: Explorer (18%) | Editor (57%) | Chat (25%)
- Custom title bar (no decorations, window controls in TitleBar component)
- Detachable chat window (separate Tauri window at route `/chat-detached`)

**Key Components:**
- `ChatPanel` - Chat interface with message history, input, thread sidebar, task view
- `EditorPanel` - Monaco editor with tab bar
- `FileExplorer` - File tree with expand/collapse, context menu, drag-drop
- `Terminal` - Integrated terminal with multiple sessions (PowerShell/Bash), command history, auto-scroll
- `TaskView` - Task list display component (shows tasks from `todo_write` tool calls)

### Thread Persistence

Threads are stored as JSON files in `.aurora/threads/{threadId}.json`. Each thread contains messages and metadata. The thread store auto-saves when messages change.

### Unique Features

1. **Detachable Chat Window** - Chat can open in separate Tauri window with cross-window state sync via `useWindowStateSync` hook

2. **Timeline Event System** - Sequential tracking of AI response components (thinking, tool, content events) for granular display

3. **Multi-Provider LLM Support** - Preset + custom providers with explicit `providerType` field for correct handling

4. **Thinking Mode** - Provider-specific thinking content (DeepSeek uses `reasoning_content`, GLM uses `thinking` parameter)

5. **VS Code-Inspired Design** - Color hierarchy: titlebar (darkest) → tabs → sidebar → editor (lightest)

6. **Dual Drag-Drop System** - Supports both internal and external file drag operations
   - Internal drag (within app): Mouse-based system via `useInternalDrag` hook, uses `renamePath` to move files
   - External drag (from OS): Tauri native events via `useTauriDragDrop` hook, uses `copyPath` to import files
   - Visual feedback: `DragPreview` component follows cursor, drop targets highlight
   - Data attributes for drop detection: `data-folder-path`, `data-editor-panel`, `data-explorer-content`

7. **Grep Search Tool** - Powerful regex-based file search (`grep` tool)
   - Supports regex patterns, glob filtering, case-insensitive search
   - Output modes: content (matching lines), files_with_matches, count
   - Context lines support, max results limit
   - Implemented in `file-executors-enhanced.ts` with recursive directory traversal

8. **Multi-File Read Tool** - Parallel file reading (`multi_file_read` tool)
   - Reads multiple files simultaneously (10-100x faster than sequential reads)
   - Returns JSON with file contents, errors, and performance metrics
   - Used for reading multiple files at once

9. **Integrated Terminal** - Native-like terminal with multiple sessions
   - Supports PowerShell and Git Bash profiles
   - Multiple concurrent sessions with tabbed interface
   - Command history, auto-scroll, working directory tracking
   - Integrated with `shell_execute` tool (commands appear in terminal)
   - VS Code-inspired styling with syntax highlighting

10. **Filesystem Watcher** - Real-time file change detection
    - Watches workspace directory recursively
    - Emits `fs-changed` events to frontend
    - Auto-refreshes file explorer on file changes
    - Uses `notify` crate in Rust backend

11. **Task Management System** - UI for tracking AI tasks
    - `useTaskStore` for task state (pending, in_progress, completed, cancelled)
    - `TaskView` component displays tasks in chat
    - Tasks synced from `todo_write` tool calls in chat messages
    - **Note:** `todo_write` tool is NOT registered in tool registry, so AI cannot create tasks

## File Structure Notes

- **Settings modal:** `src/components/modals/SettingsPanel.tsx`
- **Tool approval modal:** `src/components/modals/ToolApprovalModal.tsx`
- **Terminal component:** `src/components/terminal/Terminal.tsx`
- **Task view:** `src/components/chat/TaskView.tsx`
- **Type definitions:** `src/types/index.ts` (shared), `src/services/llm-types.ts` (LLM-specific)
- **Database types:** `src/types/database.ts` (WorkspaceState, EditorState, ExplorerState)
- **Database service:** `src/services/database.ts` (frontend database API)
- **Rust database module:** `src-tauri/src/db/` (SQLite persistence layer)
- **Settings repository:** `src-tauri/src/db/repositories/settings.rs` (LLM providers, tool settings)
- **Tauri capabilities:** `src-tauri/capabilities/default.json` - defines frontend permissions
- **Drag-drop hooks:** `src/hooks/useInternalDrag.ts` (internal), `src/hooks/useTauriDragDrop.ts` (external)
- **Drag preview:** `src/components/ui/DragPreview.tsx`
- **Drag store:** `src/store/useDragStore.ts`
- **Task store:** `src/store/useTaskStore.ts` (task management, not wired to AI)
- **Terminal store:** `src/store/useTerminalStore.ts` (terminal sessions)
- **Tool registry:** `src/tools/registry.ts` (central tool registration)
- **Tool executors:** `src/tools/executors/` (tool implementations)

## Important Patterns

- **Provider config access:** Use `useSettingsStore.getState().getLLMConfig()` to get current provider config
- **Model selection format:** Always `"providerId:model"` (e.g., `"deepseek:deepseek-chat"`)
- **Tool execution:** Tools go through agent service → Tauri commands → Rust executors
- **State updates:** Always update via Zustand store actions, never mutate directly
- **Thread saving:** Automatic via useThreadStore when messages change
- **Database access:** Import `databaseService` from `src/services/database.ts`, use async methods
- **Database repository pattern:** In Rust, use `db.workspace()`, `db.editor()`, `db.explorer()`, `db.settings()` to get repositories
- **Terminal integration:** Shell commands executed via `shell_execute` tool automatically appear in terminal sessions
- **Filesystem watcher:** Started automatically when workspace root is set, emits `fs-changed` events
- **Task system:** Tasks are displayed in chat via `TaskView` component, but `todo_write` tool is not registered for AI use

## Provider-Specific Notes

When adding new LLM providers or debugging provider issues:
- Check `providerType` field in settings (determines how the provider is handled)
- Custom headers go in `customHeaders` object
- Custom request params go in `customParams` object
- DeepSeek reasoner (`deepseek-reasoner`) ignores temperature parameter
- GLM thinking mode requires `thinking: true` in request body
