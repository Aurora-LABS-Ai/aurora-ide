# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

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

# Run tests
pnpm test
```

**Note:** Use `pnpm` as the package manager for this project.

## Project Overview

Aurora is an AI-powered agentic code editor built with Tauri (Rust backend + React frontend). It provides a VS Code-like interface with an AI assistant that can execute tools to manipulate files, run commands, navigate workspaces, perform semantic code search, integrate MCP servers, and manage Git repositories.

**Current Version:** 0.1.2

### Technology Stack

**Frontend:**
- React 18.3.1 + TypeScript 5.9
- Vite 7.2.4 (build tool)
- Monaco Editor (code editing)
- Zustand 5.0.9 (state management)
- Tailwind CSS (styling with VS Code-inspired dark theme + CSS variable system)
- react-resizable-panels (layout)
- @xterm/xterm (integrated terminal)
- Framer Motion (animations)
- Lucide React (icons)

**Backend (Rust):**
- Tauri 2.x
- tauri-plugin-fs (file operations)
- tauri-plugin-shell (command execution)
- tauri-plugin-dialog (file dialogs)
- tauri-plugin-pty (integrated terminal)
- tauri-plugin-process, tauri-plugin-os, tauri-plugin-clipboard-manager
- rusqlite (SQLite database for state persistence)
- aurora-semantic v1.2.1 (semantic code search with ONNX embeddings)
- rmcp v0.1 (MCP client support)
- reqwest (HTTP client for streaming)
- Tokio (async runtime)

**External Dependencies:**
- aurora_websearch (native web search SDK)
- tauri-pty (PTY terminal support)

## Architecture

### High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    Frontend (React/TS)                      │
│  ┌─────────────┐  ┌──────────────┐  ┌──────────────┐   │
│  │ Agent Mode  │  │ Editor Panel │  │ Chat Panel   │   │
│  │ (Full-chat) │  │ (Monaco)     │  │ (Timeline)   │   │
│  └─────────────┘  └──────────────┘  └──────────────┘   │
│         │                 │                 │               │
│         └─────────────────┴─────────────────┘               │
│                           │                               │
│                  ┌────────▼────────┐                      │
│                  │  State Stores   │                      │
│                  │   (Zustand)    │                      │
│                  └────────┬──────��─┘                      │
└───────────────────────────┼───────────────────────────────────┘
                            │ Tauri IPC
                            │
┌───────────────────────────▼──────────��────────────────────────┐
│                  Rust Backend (Tauri)                       │
│  ┌──────────────┐  ┌─────────────┐  ┌──────────────┐   │
│  │Context Engine│  │   MCP       │  │ Checkpoint   │   │
│  │(Turn-based) │  │  Manager    │  │ Service      │   │
│  └──────────────┘  └─────────────┘  └──────────────┘   │
│  ┌──────────────┐  ┌─────────────┐  ┌──────────────┐   │
│  │Undo/Redo    │  │  Services   │  │ Database     │   │
│  │(Per-file)   │  │  (Thread,   │  │ (SQLite)     │   │
│  │              │  │   Token)    │  │              │   │
│  └──────────────┘  └─────────────┘  └──────────────┘   │
│         │                │                 │               │
│         └────────────────┴─────────────────┘               │
│                           │                               │
│         ┌─────────────────▼─────────────────┐              │
│         │        External Integrations        │              │
│         │  MCP Servers | Semantic Search   │              │
│         │  Git | Web Search | CLI         │              │
│         └──────────────────────────────────┘              │
└─────────────────────────────────────────────────────────────────┘
```

### Provider Presets System

The provider system uses a **centralized preset configuration** located in `src/services/providers/provider-presets.ts`. This eliminates scattered provider-specific checks throughout the codebase.

#### Provider Preset Structure

```typescript
interface ProviderPreset {
  id: string;
  name: string;
  baseFormat: 'openai' | 'anthropic';  // API format
  chatEndpoint: string;                 // '/chat/completions' or '/messages'
  authType: 'bearer' | 'x-api-key';
  authHeader: string;
  thinkingConfig?: {
    requestParam?: Record<string, unknown>;  // e.g., { thinking: { type: 'enabled' } }
    responseField?: 'reasoning_content' | 'thinking';
    usesContentBlocks?: boolean;
  };
  defaultParams?: Record<string, unknown>;   // e.g., { tool_stream: true }
  requiredHeaders?: Record<string, string>;  // e.g., { 'anthropic-version': '2023-06-01' }
  skipTemperature?: (model: string) => boolean;
  includeStreamOptions?: boolean;
  defaultContextWindow: number;
  defaultMaxOutput: number;
}
```

#### Available Presets

| Provider | Base Format | Auth | Thinking | Special Params |
|----------|-------------|------|----------|----------------|
| `glm` | openai | Bearer | `{ thinking: { type: 'enabled' } }` -> `reasoning_content` | `tool_stream: true` |
| `deepseek` | openai | Bearer | `{ thinking: { type: 'enabled' } }` -> `reasoning_content` | Skip temp for reasoner |
| `openai` | openai | Bearer | N/A | `stream_options` |
| `anthropic` | anthropic | x-api-key | Native thinking blocks | `anthropic-version` header |
| `minimax` | anthropic | x-api-key | Native thinking blocks | `anthropic-version` header |
| `custom` | openai | Bearer | Via customParams | None |

#### Provider Routing

```typescript
// In src/services/providers/index.ts
function createProvider(config: ProviderConfig): IProvider {
  const type = config.providerType || detectProviderType(config.baseUrl, config.model);
  const preset = getProviderPreset(type);

  if (preset.baseFormat === 'anthropic') {
    return new AnthropicProvider(config);
  }
  return new OpenAIProvider(config);
}
```

### Context Engine (Turn-Based Conversation Management)

The Context Engine is a Rust-based system that manages conversation state in turns/rounds rather than a flat message list. This enables smart context budgeting, automatic summarization, and efficient message building.

**Architecture:** `src-tauri/src/context/`

```
context/
  mod.rs          - Module exports
  types.rs        - Turn, ContextState, TurnSummary types
  manager.rs      - ContextEngine (main logic)
  builder.rs      - Message building with token budget
  commands.rs     - Tauri commands (context_add_user_message, etc.)
```

**Key Features:**
- **Turn Structure:** Each user message + AI response + tool calls = one turn
- **Smart Message Building:** Builds API messages from turns with token budget awareness
- **Automatic Summarization:** Detects when context is at 80%+, triggers summarization
- **Tool Result Truncation:** Caps tool results at 500 lines to save context
- **Context Estimation:** Tracks used tokens vs context window

**Tauri Commands:**
- `context_add_user_message` - Add user message with IDE context
- `context_add_assistant_response` - Add AI response with thinking
- `context_add_tool_call` - Record tool call
- `context_add_tool_result` - Record tool result (with error flag)
- `context_finalize_turn` - Mark turn as complete
- `context_build_messages` - Build API messages from turns
- `context_build_request_messages` - Build request-specific messages
- `context_get_state` - Get context state (usage, turns, etc.)
- `context_needs_summarization` - Check if summarization needed
- `context_get_turn_to_summarize` - Get turn to summarize
- `context_set_turn_summary` - Store turn summary
- `context_get_summarization_prompt` - Get prompt for summarization
- `context_clear_thread` - Reset context for thread
- `context_init_from_thread` - Load from DB thread data
- `context_get_turns` - Get all turns
- `context_update_settings` - Update context settings
- `context_estimate_request_tokens` - Estimate token count

**Frontend Integration:**
- `useContextStore` - Manages context state in Zustand
- `AgentService` - Uses Context Engine for all conversations
- `context-builder.ts` - Legacy, being replaced by Rust engine

### MCP (Model Context Protocol) Integration

Aurora includes full MCP client support for connecting to external MCP servers (databases, APIs, custom tools).

**Architecture:** `src-tauri/src/mcp/`

```
mcp/
  mod.rs          - Module exports
  types.rs        - McpServerConfig, McpToolInfo, McpServerState
  config.rs       - McpConfig (JSON file persistence)
  manager.rs      - McpManager (connection lifecycle, tool execution)
  commands.rs     - Tauri commands
```

**Supported Transports:**
- **stdio:** Spawn process, communicate via JSON-RPC over stdin/stdout
- **SSE:** Connect via Server-Sent Events, POST endpoint for messages

**Key Features:**
- **Auto-connect:** Servers with `autoStart: true` connect on app launch
- **Tool Registration:** MCP tools automatically integrated into agent tool registry
- **Prefix Naming:** MCP tools prefixed with `mcp_{serverId}_{toolName}`
- **Resource Listing:** Lists server resources (optional, some servers don't support)
- **Auto-approval:** Per-server `autoApprove` setting for skipping user confirmation

**Frontend Integration:**
- `useMcpStore` - Manages server states in Zustand
- `McpSettingsTab.tsx` - UI for managing MCP servers
- `mcp-tools.ts` - Converts MCP tools to Aurora tool format
- `getMcpToolsSummary()` - Adds MCP tools to system prompt

**MCP Tool Execution Flow:**
```
User Request -> Agent calls mcp_* tool -> parseMcpToolName() ->
executeMcpTool() -> useMcpStore.callTool() -> Rust McpManager.call_tool() ->
MCP Server (stdio/SSE) -> Return result -> Format as tool result
```

### State Management (Zustand Stores)

Located in `src/store/`:

| Store | Purpose | Key Features |
|-------|---------|--------------|
| `useSettingsStore` | Global app settings, LLM providers, model selection. Persists to SQLite. Model format: `\"providerId:model\"` | Provider management, tool approval, thinking toggle |
| `useChatStore` | Chat messages, loading state, tool approval workflow | Multi-window sync via Rust SharedChatState |
| `useThreadStore` | Conversation thread management, persists to `.aurora/threads/` | Thread creation, message CRUD, usage tracking |
| `useEditorStore` | Monaco editor tabs, active tab, file content caching | Multi-tab, language detection |
| `useWorkspaceStore` | File explorer, root path, file tree, filesystem watcher | Git integration, auto-refresh |
| `useUiStore` | Theme, modal states, chat panel visibility, agent mode | Layout management, UI toggles |
| `useDragStore` | Drag-drop state for file operations | File/folder drag-drop |
| `useTaskStore` | Task/todo list management (UI display) | Agent mode tasks |
| `useTerminalStore` | Integrated terminal sessions | Multi-session PTY terminals |
| `useContextStore` | Context window usage tracking, turn management | Rust Context Engine sync |
| `useAuditStore` | Tool execution audit log | Timeline, risk tracking |
| `useSemanticStore` | Semantic search settings, indexes, search state | Per-workspace indexing |
| `useThemeStore` | Custom theme management | Import/export, active theme |
| `usePendingChangesStore` | Pending file changes before approval | Pre-edit preview |
| `useCheckpointStore` | Checkpoint state, creation, restore operations | Git-based snapshots |
| `useUndoRedoStore` | Per-file undo/redo state | Stack-based history |
| **`useGitStore`** | Git repository state | Branches, commits, status, diff |
| **`useMcpStore`** | MCP server management | Connection lifecycle, tools |

### Database Persistence (SQLite)

**Database Location:**
- Windows: `%APPDATA%\com.aurora.agent\aurora.db`
- macOS: `~/Library/Application Support/com.aurora.agent/aurora.db`
- Linux: `~/.config/com.aurora.agent/aurora.db`

**Schema Version:** 10

**Architecture:** `src-tauri/src/db/`

```
db/
  mod.rs          - Database manager, exposes repositories
  connection.rs   - SQLite connection with WAL mode
  schema.rs       - Table definitions (version 8)
  migrations.rs   - Version-based migration system (v1-v10)
  models.rs       - Rust structs
  repositories/
    settings.rs   - LLM providers, app settings, tool settings
    workspace.rs  - Workspace state (includes checkpoint_enabled per workspace)
    editor.rs     - Editor state per file
    explorer.rs   - File explorer state
    threads.rs    - Chat threads with token/context usage
    themes.rs     - Custom themes
    semantic.rs   - Semantic search indexes and settings
    checkpoints.rs - Checkpoint metadata storage
```

**Key Tables:**
- `llm_providers` - Provider configs (21 columns including customHeaders, customParams as JSON)
- `app_settings` - Key-value settings store
- `tool_settings` - Per-tool approval modes
- `workspace_state` - Includes `checkpoint_enabled` column for per-workspace checkpoint toggle
- `editor_state`, `explorer_state`
- `threads` - Chat history with token usage, turn-based structure
- `custom_themes` - User-imported themes
- `semantic_indexes` - Per-workspace semantic search indexes with exclusions
- `semantic_settings` - Global semantic search settings (model path, enabled, etc.)
- `checkpoints` - Checkpoint metadata (id, message_id, thread_id, workspace_path, created_at)

### Agent Service

Located in `src/services/agent-service.ts`:

- Orchestrates AI conversation with tool execution
- **Uses Rust Context Engine** for turn-based message management
- Conversation loop: LLM -> Tool Calls -> Execution -> Response
- Max 25 tool iterations per request
- Streaming callbacks: `onToken`, `onThinking`, `onToolCall`, `onToolExecution`, `onUsage`, `onComplete`
- **MCP Tool Integration:** MCP tools automatically included in available tools
- **Auto-Approval:** Respects per-tool and per-MCP server approval settings

**Flow:**
```
User Input -> ChatPanel -> context-builder.ts -> agent.setProvider(config)
-> agent.chat() -> Context Engine (build messages) -> Provider.streamChat()
-> Tool Execution (built-in + MCP) -> Response
-> Context Engine (finalize turn) -> Store
```

### Tool System

Located in `src/tools/`:

```
tools/
  definitions/
    file-tools.ts      - File operations
    shell-tools.ts     - Shell command execution
    workspace-tools.ts - Workspace navigation
    editor-tools.ts    - Editor operations
    search-tools.ts    - Semantic search (aurora_search)
    todo-tools.ts      - Task management
    risk-levels-enhanced.ts - Tool risk categorization
  executors/
    file-executors-enhanced.ts
    shell-executors.ts
    workspace-executors.ts
    editor-executors.ts
    search-executors.ts
    todo-executors.ts
  registry.ts          - Central tool registration
  operation-log.ts     - Tool execution logging
```

**Available Tools:**

| Category | Tools |
|----------|-------|
| **File** | `file_read`, `file_write`, `file_patch`, `file_create`, `file_delete`, `file_exists`, `file_search`, `grep`, `multi_file_read` |
| **Workspace** | `workspace_tree`, `folder_create`, `folder_delete`, `workspace_info` |
| **Shell** | `shell_execute`, `shell_spawn`, `shell_kill`, `shell_list_processes` |
| **Editor** | `editor_open_file`, `editor_get_active_file`, `editor_get_selection`, `editor_insert_text`, `editor_get_open_tabs`, `editor_close_tab` |
| **Search** | `aurora_search` (semantic code search with filters), `auroro_websearch` (web search + page fetch) |
| **Tasks** | `todo_write` (task list management) |
| **MCP** | `mcp_*` (dynamic, from connected servers) |

**Tool Risk Levels:**
- **High:** `shell_*`, `file_delete`, `folder_delete`, `shell_spawn`, `shell_kill`
- **Medium:** `file_write`, `file_create`, `file_patch`, `folder_create`, `shell_execute`
- **Low:** All others (read-only operations)

### Checkpoint System

Aurora includes a checkpoint system that captures workspace file state on every user message, allowing users to restore to any previous point.

**How It Works:**
- Uses a **shadow Git repository** separate from the user's actual Git repo
- Shadow repo stored in app data: `%APPDATA%\com.aurora.agent\checkpoints\{workspace_hash}\`
- Configured with `core.worktree` pointing to actual workspace
- Each user message creates a Git commit in the shadow repo
- Uses **git CLI** for all operations (like kilocode's simple-git approach)
- Restore uses `git clean -fd` + `git reset --hard` to restore files

**Why Git CLI instead of git2 crate:**
The checkpoint system uses git CLI (via `std::process::Command`) instead of the git2 Rust crate because git2's `index.add_all()` doesn't properly work with external worktrees. When `core.worktree` points to a separate directory, git2's index operations often fail to traverse the workspace files correctly.

**Architecture:**

```
Frontend (TypeScript)                    Backend (Rust)
-----------------------                  ---------------
useCheckpointStore                  ->   checkpoints.rs commands
  - enabled (per workspace)              - checkpoint_init
  - checkpoints Map<messageId, CP>       - checkpoint_create
  - createCheckpoint()                   - checkpoint_restore
  - restoreToCheckpoint()                - checkpoint_list
  - loadCheckpointsForThread()           - checkpoint_get_enabled
                                         - checkpoint_set_enabled
checkpointService                   ->   CheckpointService (Rust)
  - createCheckpoint()                   - Shadow git repo management
  - restoreCheckpoint()                  - git CLI operations
  - listCheckpoints()
  - isEnabled() / setEnabled()
```

**Key Files:**
- `src-tauri/src/checkpoints/mod.rs` - Module exports
- `src-tauri/src/checkpoints/service.rs` - Git CLI operations (create, restore)
- `src-tauri/src/checkpoints/types.rs` - Checkpoint struct, errors
- `src-tauri/src/commands/checkpoints.rs` - Tauri commands
- `src-tauri/src/db/repositories/checkpoints.rs` - Database storage
- `src/services/checkpoint.ts` - Frontend service
- `src/store/useCheckpointStore.ts` - Zustand store
- `src/components/chat/CheckpointIndicator.tsx` - UI component

**Database Schema (checkpoints table):**
```sql
CREATE TABLE checkpoints (
  id TEXT PRIMARY KEY,           -- Git commit hash
  message_id TEXT NOT NULL,      -- Associated message
  thread_id TEXT NOT NULL,       -- Thread this belongs to
  workspace_path TEXT NOT NULL,  -- Workspace path
  created_at TEXT NOT NULL       -- ISO timestamp
);
```

**Per-Workspace Enable/Disable:**
- Stored in `workspace_state.checkpoint_enabled` column
- Defaults to `true` for new workspaces
- Toggle in Settings > General tab
- Persisted per workspace path

**UI Behavior:**
- Checkpoint icon appears on user messages (hover to see)
- Click shows "Restore to this point?" confirmation
- On restore:
  1. Files restored to checkpoint state via `git reset --hard`
  2. Untracked files removed via `git clean -fd`
  3. Messages after checkpoint deleted from UI/DB
  4. Checkpoint message content put back in input box
  5. File explorer refreshed

**Multi-Thread Behavior:**
- Shadow repo is per WORKSPACE, not per thread
- Git history is linear across all threads in same workspace
- Each thread only sees its OWN checkpoints in UI
- Restore works correctly (uses specific commit ID)
- Caveat: File state is shared - restoring in Thread 1 affects files seen by Thread 2

**Safety:**
- User's actual `.git` directory is excluded from tracking
- Sanitizes git environment variables (GIT_DIR, GIT_WORK_TREE, etc.) to prevent interference
- Common directories excluded: node_modules, dist, build, .idea, .vscode, etc.

### Undo/Redo System

Aurora includes a per-file undo/redo system for tracking programmatic changes (AI edits, tool operations).

**How It Works:**
- Each file has its own independent undo/redo stack (max 100 entries per file)
- Changes are recorded when AI tools modify files (`file_write`, `file_create`)
- User can undo/redo using Ctrl+Z / Ctrl+Y (or Cmd+Z / Cmd+Y on macOS)
- Complementary to Monaco Editor's built-in keystroke-level undo/redo

**Architecture:**

```
Frontend (TypeScript)                    Backend (Rust)
-----------------------                  ---------------
useUndoRedoStore                    ->   undo_redo.rs commands
  - fileStates Map<path, state>         - undo_init_file
  - recordChange()                      - undo_record_change
  - undo()                              - undo_file / undo_file_and_save
  - redo()                              - redo_file / redo_file_and_save
                                        - undo_get_state
undoRedoService                     ->   UndoRedoService (Rust)
  - initFile()                          - Per-file undo stack management
  - recordChange()                      - Simple stack-based history
  - undo() / redo()
```

**Key Files:**
- `src-tauri/src/undo_redo/mod.rs` - Module exports
- `src-tauri/src/undo_redo/service.rs` - Stack-based undo/redo service
- `src-tauri/src/undo_redo/types.rs` - FileChange, FileUndoState types
- `src-tauri/src/commands/undo_redo.rs` - Tauri commands
- `src/services/undo-redo.ts` - Frontend service
- `src/store/useUndoRedoStore.ts` - Zustand store
- `src/hooks/useUndoRedoShortcuts.ts` - Keyboard shortcut handler

**Integration with AI Tools:**
- `file_write` and `file_create` executors automatically record changes
- Changes are recorded with source = "ai_tool" for tracking
- Original content is captured before write for proper undo

**Keyboard Shortcuts:**
- `Ctrl+Z` / `Cmd+Z`: Undo last AI change
- `Ctrl+Y` / `Cmd+Y` / `Ctrl+Shift+Z`: Redo last undone change

### Semantic Search System

Aurora includes a powerful semantic code search engine powered by `aurora-semantic` v1.2.1.

**Features:**
- AI-powered semantic search using ONNX embeddings (Jina Code 1.5B recommended)
- Hybrid search mode: combines lexical (keywords) + semantic (meaning)
- GPU acceleration support (CUDA, DirectML, CoreML, TensorRT)
- Per-workspace indexing with workspace-specific exclusions
- Filtering by language, chunk type, path patterns, symbol names, directories

**Architecture:**

```
Frontend (TypeScript)                    Backend (Rust)
-----------------------                  ---------------
useSemanticStore                    ->   semantic.rs commands
  - settings                             - get_semantic_settings
  - currentIndex                         - save_semantic_settings
  - allIndexes                           - start_semantic_indexing
  - indexProgress                        - semantic_search
  - search()                             - update_workspace_exclusions

semanticService                     ->   aurora-semantic crate
  - getSettings()                        - Engine (singleton, cached)
  - startIndexing()                      - WorkspaceConfig
  - search()                             - SearchQuery + SearchFilter
  - updateWorkspaceExclusions()
```

**Storage Locations:**
- Settings: SQLite database (`semantic_settings` table)
- Index metadata: SQLite database (`semantic_indexes` table with per-workspace exclusions)
- Index files: User app data directory (`%APPDATA%/aurora_agent/semantic/` on Windows)

**Settings Tab:** `src/components/modals/SemanticSettingsTab.tsx`
- Model path configuration (with explicit save button - no auto-save on keystroke)
- Enable/disable toggle
- Search mode selection (hybrid/lexical/semantic)
- Weight sliders (debounced save after 500ms)
- Global ignored patterns and directories
- Workspace-specific exclusions (stored per-workspace in `semantic_indexes`)

### Git Integration

Aurora includes full Git integration for managing repositories within the workspace.

**Architecture:** `src-tauri/src/commands/git.rs`

**Available Commands:**
- `git_is_repository` - Check if workspace is a Git repo
- `git_get_status` - Get current status (modified, untracked, staged files)
- `git_get_branches` - List all branches
- `git_get_commits` - Get commit history
- `git_current_branch` - Get current branch name
- `git_stage_file` - Stage a file
- `git_unstage_file` - Unstage a file
- `git_stage_all` - Stage all changes
- `git_unstage_all` - Unstage all changes
- `git_discard_changes` - Discard changes to a file
- `git_commit` - Create commit with message
- `git_checkout` - Checkout branch or commit
- `git_create_branch` - Create new branch
- `git_pull` - Pull from remote
- `git_push` - Push to remote
- `git_get_diff` - Get diff for file or changeset
- `git_get_file_versions` - Get file history

**Frontend Components:**
- `GitPanel.tsx` - Main Git sidebar panel
- `GitBranchSelector.tsx` - Branch selection dropdown
- `GitCommitInput.tsx` - Commit message input
- `GitDiffModal.tsx` - Diff viewer modal
- `GitFileItem.tsx` - File change item in status list
- `useGitStore` - Zustand store for Git state

### Web Search Integration

Aurora includes native web search capabilities via the `aurora_websearch` SDK (DuckDuckGo backend).

**Architecture:** `src-tauri/src/commands/mod.rs`

**Available Commands:**
- `aurora_websearch` - Unified search/fetch command

**Modes:**
- **search:** Provide a query to search the web. Returns titles, URLs, snippets.
- **fetch:** Provide a url to fetch and extract clean text content from a web page.

**Features:**
- Powered by DuckDuckGo
- Clean text extraction from web pages
- Search result titles, URLs, snippets
- Page fetching with content extraction
- Configurable region and safe search settings

### Agent Mode

Agent Mode is a full-screen chat interface optimized for complex, multi-step tasks.

**Architecture:** `src/components/agent/AgentModeLayout.tsx`

**Key Features:**
- Full-screen chat with centered content
- **Timeline-based message display** (content, thinking, tools)
- File changes panel on the right (collapsible)
- Thread history sidebar
- Context usage indicator with summarization status
- New chat button (Ctrl+H for history)
- Exit to regular editor mode (Esc)

**Components:**
- `AgentModeLayout.tsx` - Main layout with PanelGroup
- `AgentInputArea.tsx` - Input area with file attachments
- `AgentChatMessage.tsx` - Message display with timeline
- `AgentToolCard.tsx` - Tool execution card
- `AgentChangesTree.tsx` - File changes panel

**Timeline Events:**
Each message contains a timeline of events:
- `thinking` - AI reasoning (from `reasoning_content` or `thinking` blocks)
- `content` - Response content
- `tool` - Tool call execution (with status: pending, executing, complete, rejected, cancelled)

**Keyboard Shortcuts:**
- `Esc` - Exit agent mode
- `Ctrl+H` - Open thread history

### CLI Integration

Aurora supports CLI commands for launching from terminal.

**Architecture:** `src-tauri/src/cli.rs`

**Available Commands:**
```bash
# Install CLI (symlink aurora to PATH)
aurora --install-cli

# Uninstall CLI
aurora --uninstall-cli

# Open Aurora with workspace
aurora <path/to/workspace>

# Open Aurora with specific file
aurora <path/to/file>

# Detach mode (frees terminal immediately)
aurora <path> &
```

**Features:**
- Single-instance detection (pass args to existing instance)
- Detached process spawning (terminal freed immediately)
- Auto-detect workspace vs file
- Cross-platform installation (Windows: `%APPDATA%\com.aurora.agent\aurora.exe`, Unix: `~/.local/bin/aurora`)

### OpenAI Native Provider

The OpenAI Native provider uses raw HTTP streaming to support extended thinking fields not exposed by the async-openai crate.

**Architecture:** `src-tauri/src/commands/openai_native.rs`

**Features:**
- Raw HTTP streaming via `reqwest`
- Supports `reasoning_content` (DeepSeek, GLM) and `reasoning` (LM Studio local models)
- Custom body parameters via `extra_body` (e.g., `reasoning_effort`)
- Stream options for usage tracking
- SSE event parsing with buffering

**Tauri Commands:**
- `openai_native_stream` - Streaming chat completion
- `openai_native_chat` - Non-streaming chat completion

**Emit Events:**
- `openai-native-chunk-{requestId}` - Streaming content chunks
- `openai-native-usage-{requestId}` - Token usage info
- `openai-native-error-{requestId}` - Error events

### Browser Preview

Aurora includes a browser preview panel for viewing web content within the IDE.

**Current Implementation:** iframe-based
- Uses standard `<iframe>` element
- Limited to same-origin or X-Frame-Options: allowframeorigin
- No native inspector (use browser DevTools with F12)

**Future Plans:**
- Native WebView with Tauri's webview API
- Full DevTools integration
- Script injection for element inspection
- Enhanced navigation controls

**Tauri Commands:** `src-tauri/src/commands/browser.rs` (currently placeholders)

**Frontend Component:** `src/components/editor/BrowserTab.tsx`

### Component Architecture

**Layout:** `src/components/layout/MainLayout.tsx`
- Three-panel layout: Explorer (18%) | Editor (57%) | Chat (25%)
- Custom title bar with window controls
- Detachable chat window
- Activity bar for mode switching

**Key Components:**

| Component | Purpose |
|-----------|---------|
| `ChatPanel` | Chat interface with message history, thread sidebar |
| `ChatInput` | Input with model selector, thinking toggle, file mentions |
| `ChatMessages` | Message display with timeline |
| `ChatMessage` | Individual message with tool cards |
| `EditorPanel` | Monaco editor with tabs |
| `FileExplorer` | File tree with context menu, drag-drop |
| `Terminal` | Integrated terminal with multiple sessions (PTY-based) |
| `GitPanel` | Git status, branches, commits, diff viewer |
| `SettingsPanel` | Settings modal with tabs (Providers, MCP, Semantic Search, Appearance, Tools, General) |
| `McpSettingsTab` | MCP server management |
| `SemanticSettingsTab` | Semantic search configuration |
| `TaskList` | Todo/task display panel |
| `SearchPanel` | Quick file search (Cmd/Ctrl+P) |
| `QuickOpenModal` | Quick file/command picker |
| `OnboardingModal` | First-run setup wizard |
| `AuditTimeline` | Tool execution history viewer |

### Theme System

Aurora uses a CSS variable-based theme system for easy customization.

**Theme Architecture:**
- CSS variables in format `--aurora-{category}-{token}`
- Categories: `common`, `chat`, `editor`, `explorer`, `git`, `title-bar`
- Tokens: `primary`, `background`, `foreground`, `border`, `muted-foreground`, etc.

**Theme Storage:**
- Built-in themes: `src/themes/` directory
- Custom themes: Stored in SQLite database (`custom_themes` table)
- Active theme ID: Stored in `app_settings`

**Theme Components:**
- `ThemeSettingsTab.tsx` - Theme selection and import/export
- `ThemePanel.tsx` - Theme preview editor
- `ThemeDropdown.tsx` - Quick theme switcher in status bar

**Example Themes:**
- `aurora-dark-complete.json` - Full dark theme
- `aurora-light-complete.json` - Light theme
- `aurora-modern-dark-v2.json` - Modern dark variant
- `CarbonForest.json` - Green-tinged forest theme
- `midnight-slate.json` - Midnight blue theme
- `toxic-green.json` - Neon green hacker theme

### Token Counting

Aurora includes multiple token counting methods for different providers.

**Architecture:** `src-tauri/src/services/token_service.rs`

**Tauri Commands:**
- `count_tokens` - Count tokens for text using specified model encoding
- `count_chat_tokens` - Count tokens for chat messages
- `count_messages_tokens` - Count tokens for API message array
- `detect_model_encoding` - Detect tokenizer encoding for model
- `estimate_tokens_quick` - Fast character-based estimation (1 token ≈ 4 chars)
- `truncate_to_tokens` - Truncate text to fit token budget

**Supported Encodings:**
- `cl100k_base` - OpenAI GPT-4, GPT-3.5-turbo
- `o200k_base` - OpenAI GPT-4-turbo, GPT-4o
- `p50k_base` - OpenAI code-davinci-002
- `r50k_base` - OpenAI older models
- `Codex-3` - Anthropic Codex 3

**Frontend Integration:** `src/services/token-service.ts`
- Quick estimation for UI (no backend call)
- Accurate counting via Tauri commands
- Model-specific encoding detection

### Thinking Mode Integration

The thinking toggle in `ChatInput.tsx`:
- Shows enabled/disabled based on `providerSupportsThinking`
- User's `thinkingEnabled` preference stored in settings
- Actual request uses: `userThinkingEnabled && providerSupportsThinking`

```typescript
// ChatInput.tsx - Toggle is disabled if provider doesn't support thinking
const providerSupportsThinking = llmConfig?.supportsThinking ?? false;

// ChatPanel.tsx - Combines user preference with provider capability
const thinkingEnabled = userThinkingEnabled && (llmConfig?.supportsThinking ?? false);
```

**Reasoning Content Fields:**
- `reasoning_content` - DeepSeek, GLM (OpenAI-style)
- `thinking` - Anthropic Codex (content block)
- `reasoning` - LM Studio local models

## File Structure

### Services (`src/services/`)

| File | Purpose |
|------|---------|
| `agent-service.ts` | AI conversation orchestration with Context Engine |
| `context-builder.ts` | Cursor-style IDE context gathering (legacy, being replaced) |
| `thread-converter.ts` | UI -> API message format conversion |
| `token-service.ts` | Token counting service |
| `database.ts` | Frontend database API |
| `semantic.ts` | Semantic search service (frontend) |
| `theme-service.ts` | Custom theme loading and management |
| `syntax-validator.ts` | Code syntax validation |
| `multi-file-service.ts` | Multi-file read operations |
| `mcp-tools.ts` | MCP tool integration |

### Providers (`src/services/providers/`)

| File | Purpose |
|------|---------|
| `provider-presets.ts` | **Centralized provider configurations** |
| `types.ts` | Type definitions (Message, ProviderConfig, etc.) |
| `base-provider.ts` | Abstract base with HTTP, token counting |
| `openai-provider.ts` | OpenAI, DeepSeek, GLM implementation |
| `anthropic-provider.ts` | Codex, MiniMax implementation |
| `token-counter.ts` | Character-based token estimation |
| `context-manager.ts` | Context overflow handling (legacy) |
| `index.ts` | Provider factory and registry |

### Rust Commands (`src-tauri/src/commands/`)

| Module | Commands |
|--------|-----------|
| `mod.rs` | File operations, batch ops, CLI install |
| `settings.rs` | Providers, app settings, tool approval |
| `chat.rs` | State sync for multi-window |
| `threads.rs` | Thread CRUD, per-message operations, legacy APIs |
| `state.rs` | Workspace, editor, explorer state persistence |
| `semantic.rs` | Semantic search settings, indexing, search |
| `themes.rs` | Theme CRUD, active theme |
| `git.rs` | Git operations (status, commits, branches, diff) |
| `browser.rs` | Browser preview (iframe mode, placeholders for native) |
| `openai_native.rs` | Raw HTTP streaming for extended thinking |
| `tokens.rs` | Token counting, encoding detection |
| `checkpoints.rs` | Checkpoint lifecycle (Git CLI) |
| `undo_redo.rs` | Per-file undo/redo (stack-based) |
| `llm.rs` | HTTP proxy for LLM streaming (CORS bypass) |
| `mcp/commands.rs` | MCP server management, tool execution |

### Rust Services (`src-tauri/src/services/`)

| Module | Purpose |
|--------|---------|
| `thread_service.rs` | Thread state management (per-message persistence) |
| `token_service.rs` | Token counting with tiktoken-rs |
| `api_converter.rs` | Format conversion (UI ↔ API ↔ Rust) |

## Important Patterns

### Adding a New Provider

1. **Add preset** in `src/services/providers/provider-presets.ts`:
```typescript
newprovider: {
  id: 'newprovider',
  name: 'New Provider',
  baseFormat: 'openai',  // or 'anthropic'
  chatEndpoint: '/chat/completions',
  authType: 'bearer',
  authHeader: 'Authorization',
  thinkingConfig: { ... },  // if supported
  defaultParams: { ... },   // provider-specific params
  defaultContextWindow: 128000,
  defaultMaxOutput: 8192,
}
```

2. **Add to PRESET_PROVIDERS** in `src/store/useSettingsStore.ts` if it should be a built-in option.

### Custom Headers/Params Flow

1. User configures in Settings -> stored in `llm_providers` table as JSON
2. `getLLMConfig()` returns config with `customHeaders` and `customParams`
3. Provider's `buildHeaders()` merges: `preset headers + customHeaders`
4. Provider's `buildRequestBody()` applies: `preset params, then customParams override`

### Provider-Specific Behaviors (Centralized in Presets)

All provider quirks are defined in presets:
- **GLM**: `tool_stream: true`, thinking via `{ thinking: { type: 'enabled' } }`
- **DeepSeek**: Skip temperature for reasoner models
- **Anthropic/MiniMax**: Use `x-api-key` header, `anthropic-version` required
- **Custom**: No assumptions, user configures via customParams

### Context Management with Context Engine

```typescript
// AgentService automatically uses Rust Context Engine
const agent = getAgentService();
agent.setThreadId(threadId);

// Each turn is managed by Context Engine
await agent.chat(userMessage, callbacks, tools, ideContext);

// Context state is available
const state = await agent.getContextState();
// { threadId, totalTurns, summarizedTurns, usedTokens, contextWindow, ... }
```

### MCP Tool Integration

```typescript
// MCP tools are automatically available to the agent
const mcpTools = getMcpToolDefinitions();
// Returns ToolDefinition[] prefixed with 'mcp_{serverId}_{toolName}'

// Execute MCP tool (same as built-in tools)
const result = await executeMcpTool('mcp_mcp_server1_db_info', {});
// Returns formatted result content

// Display name for UI
const displayName = getToolDisplayName('mcp_mcp_server1_db_info');
// Returns: "Server Name: db_info"
```

### Semantic Search Usage

```typescript
// From tool executor (search-executors.ts)
const results = await semanticService.search(workspacePath, query, {
  limit: 10,
  mode: 'hybrid',
  languages: ['typescript'],
  chunkTypes: ['function', 'class'],
  directories: ['src/'],
  excludeDirectories: ['node_modules'],
});

// Results include: filePath, content, score, language, chunkType, symbolName, startLine, endLine
```

### Workspace-Specific Exclusions

Exclusions (excluded files/directories) are stored per-workspace in `semantic_indexes` table, not in global settings:

```typescript
// SemanticIndex includes:
interface SemanticIndex {
  id: string;
  workspacePath: string;
  excludedFiles: string[];      // Per-workspace
  excludedDirectories: string[]; // Per-workspace
  // ...
}

// Update via:
await semanticService.updateWorkspaceExclusions(workspacePath, excludedFiles, excludedDirectories);
```

### Checkpoint Integration

```typescript
// In chat/send handler
const userMessage = { id: 'msg-1', content: '...', timestamp: Date.now() };
addMessageToThread(userMessage);

// Create checkpoint for user message
if (rootPath && threadId) {
  await useCheckpointStore.getState().createCheckpoint(userMessage.id, threadId);
}

// Restore from checkpoint
await useCheckpointStore.getState().restoreToCheckpoint(checkpointId);
// - Restores files to snapshot state
// - Deletes messages after checkpoint
// - Refreshes file explorer
```

### Undo/Redo Integration

```typescript
// Automatically recorded by file_write and file_create executors
// Manual recording:
useUndoRedoStore.getState().recordChange(filePath, {
  content: oldContent,
  newContent: newContent,
  source: 'ai_tool',
});

// Undo/Redo via keyboard shortcuts or API
await useUndoRedoStore.getState().undo(filePath);
await useUndoRedoStore.getState().redo(filePath);
```

## Performance Considerations

### Settings Dialog Optimization

The semantic settings tab uses several optimizations to prevent UI freezing:

1. **Model path**: Explicit save button (no auto-save on keystroke)
2. **Weight sliders**: Debounced save (500ms after user stops dragging)
3. **Text inputs**: Debounced save (1s idle) or save on blur
4. **Model validation**: Lightweight filesystem check only (no ONNX model loading)
5. **ONNX model loading**: Only happens when indexing starts, not during settings configuration

### Semantic Search Engine

- Engine is cached as singleton (not recreated per search)
- Index files stored in user app data (not workspace)
- Workspace-specific exclusions stored in database
- GPU acceleration when available (CUDA, DirectML, CoreML, TensorRT)

### File Operations

- **Multi-file reads**: `multi_file_read` parallelizes reads (10-100x faster)
- **Batch operations**: `read_files_batch` command for bulk reads
- **File cache**: In-memory cache with LRU eviction
- **FS watcher**: Debounced events to prevent excessive UI updates

## VS Code-Inspired Design

- Color hierarchy: titlebar (darkest) -> tabs -> sidebar -> editor (lightest)
- Integrated terminal with PowerShell/Bash profiles (PTY-based)
- File explorer with expand/collapse, context menu, drag-drop
- Monaco editor with syntax highlighting
- Detachable chat window
- Custom theme support (import VS Code themes)
- Git integration (status, branches, commits, diff viewer)
- Quick open (Cmd/Ctrl+P)
- Multi-cursor editing
- Split view (planned)

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl/Cmd+P` | Quick open |
| `Ctrl/Cmd+H` | Chat history (Agent Mode) |
| `Ctrl/Cmd+Shift+P` | Command palette (planned) |
| `Ctrl/Cmd+S` | Save file |
| `Ctrl/Cmd+Z` | Undo |
| `Ctrl/Cmd+Y` / `Ctrl/Cmd+Shift+Z` | Redo |
| `Ctrl/Cmd+W` | Close tab |
| `Ctrl/Cmd+T` | New tab |
| `Ctrl/Cmd+B` | Toggle sidebar |
| `Ctrl/Cmd+J` | Toggle terminal |
| `Ctrl/Cmd+K` | Focus chat |
| `Esc` | Close modal / Exit Agent Mode |

## Development Notes

### Running Tests

```bash
# Run all tests
pnpm test

# Run tests in watch mode
pnpm test:watch

# Run with coverage
pnpm test:coverage
```

### Building for Production

```bash
# Build optimized production bundle
pnpm tauri:build

# Outputs:
# - src-tauri/target/release/bundle/
#   - Windows: .msi, .nsis installer
#   - macOS: .dmg, .app
#   - Linux: .AppImage, .deb
```

### Code Style

- Use `pnpm lint` before committing
- Follow ESLint rules in `eslint.config.js`
- TypeScript strict mode enabled
- Use 2-space indentation for TypeScript/React
- Use 4-space indentation for Rust

### Contributing

1. Create feature branch from `main`
2. Make changes with clear commit messages
3. Run tests and linting
4. Submit pull request with description
5. Ensure all new features have tests

### Known Issues

- Git checkpoints don't work with submodules
- MCP SSE connections may timeout with slow servers
- Semantic search indexing can take time for large codebases
- Browser preview limited to iframe (no native WebView yet)

### Future Roadmap

- [ ] Native WebView browser preview
- [ ] Split view for editor
- [ ] Remote development (SSH)
- [ ] Debug adapter integration
- [ ] Extensions marketplace
- [ ] Collaboration features (real-time)
- [ ] AI code review (pull request analysis)
- [ ] Automated testing
- [ ] Docker integration
- [ ] Kubernetes manifests
