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

The app uses six specialized Zustand stores located in `src/store/`:

1. **useSettingsStore** - Global app settings (LLM providers, model selection, tool approval, editor settings)
   - Persists to localStorage (`aurora-settings`, version 3)
   - Model selection format: `"providerId:model"` (e.g., `"glm:glm-4.7"`)
   - Supports preset providers (GLM, DeepSeek, OpenAI) and custom providers
   - Provider config includes: `baseUrl`, `apiKey`, `model`, `contextWindow`, `maxOutputTokens`, `supportsThinking`, `customHeaders`, `customParams`, `providerType`

2. **useChatStore** - Chat messages and loading state
   - Tool approval workflow state
   - Message CRUD operations

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

6. **useUiStore** - UI state
   - Theme toggling
   - Modal states
   - Chat panel visibility
   - Detached chat window state

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
5. `settings` - Key-value settings storage (future use)
6. `schema_version` - Database version tracking

**Tauri State Commands:**
- `save_workspace_state` / `get_workspace_state`
- `save_editor_state` / `get_editor_state`
- `save_explorer_state` / `get_explorer_state`

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
  - `file-tools.ts` - File operations (read, write, create, delete)
  - `shell-tools.ts` - Shell command execution
  - `workspace-tools.ts` - Workspace navigation, search
  - `editor-tools.ts` - Editor operations (open files, tabs)

- **executors/** - Tool implementations
  - Each tool has a risk level: low (auto-approve), medium/high (requires approval)

- **registry.ts** - Central tool registry

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
- `read_directory` - List directory contents (filters node_modules, target, dist)
- `read_file_content` - Read file to string
- `write_file_content` - Write string to file (creates parent dirs)
- `execute_command` - Execute shell command (cmd on Windows, sh on Unix)
- `get_system_info` - Get OS, arch, hostname
- `get_workspace_root` - Get current workspace root path
- `create_file` / `create_folder` / `delete_path` / `rename_path`

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
- `ChatPanel` - Chat interface with message history, input, thread sidebar
- `EditorPanel` - Monaco editor with tab bar
- `FileExplorer` - File tree with expand/collapse

### Thread Persistence

Threads are stored as JSON files in `.aurora/threads/{threadId}.json`. Each thread contains messages and metadata. The thread store auto-saves when messages change.

### Unique Features

1. **Detachable Chat Window** - Chat can open in separate Tauri window with cross-window state sync via `useWindowStateSync` hook

2. **Timeline Event System** - Sequential tracking of AI response components (thinking, tool, content events) for granular display

3. **Multi-Provider LLM Support** - Preset + custom providers with explicit `providerType` field for correct handling

4. **Thinking Mode** - Provider-specific thinking content (DeepSeek uses `reasoning_content`, GLM uses `thinking` parameter)

5. **VS Code-Inspired Design** - Color hierarchy: titlebar (darkest) → tabs → sidebar → editor (lightest)

## File Structure Notes

- **Settings modal:** `src/components/modals/SettingsPanel.tsx`
- **Tool approval modal:** `src/components/modals/ToolApprovalModal.tsx`
- **Type definitions:** `src/types/index.ts` (shared), `src/services/llm-types.ts` (LLM-specific)
- **Database types:** `src/types/database.ts` (WorkspaceState, EditorState, ExplorerState)
- **Database service:** `src/services/database.ts` (frontend database API)
- **Rust database module:** `src-tauri/src/db/` (SQLite persistence layer)
- **Tauri capabilities:** `src-tauri/capabilities/default.json` - defines frontend permissions

## Important Patterns

- **Provider config access:** Use `useSettingsStore.getState().getLLMConfig()` to get current provider config
- **Model selection format:** Always `"providerId:model"` (e.g., `"deepseek:deepseek-chat"`)
- **Tool execution:** Tools go through agent service → Tauri commands → Rust executors
- **State updates:** Always update via Zustand store actions, never mutate directly
- **Thread saving:** Automatic via useThreadStore when messages change
- **Database access:** Import `databaseService` from `src/services/database.ts`, use async methods
- **Database repository pattern:** In Rust, use `db.workspace()`, `db.editor()`, `db.explorer()` to get repositories

## Provider-Specific Notes

When adding new LLM providers or debugging provider issues:
- Check `providerType` field in settings (determines how the provider is handled)
- Custom headers go in `customHeaders` object
- Custom request params go in `customParams` object
- DeepSeek reasoner (`deepseek-reasoner`) ignores temperature parameter
- GLM thinking mode requires `thinking: true` in request body
