# CLAUDE.md

**Aurora IDE v1.0.0** - AI-powered agentic code editor. React frontend + Tauri (Rust) backend.

## Development Commands

```bash
pnpm tauri:dev      # Tauri + Vite dev server
pnpm dev            # Frontend only (localhost:5173)
pnpm tauri:build    # Production build
pnpm build          # Frontend build only
pnpm test           # Run tests
```

## Architecture

```
Frontend (React/TS)          Tauri IPC          Rust Backend (Tauri 2.x)
├─ Agent/Chat Panels    ←────────────────→   ├─ Context Engine (turn-based)
├─ Monaco Editor                               ├─ MCP Manager (rmcp v0.1)
├─ File Explorer                               ├─ Checkpoint Service
├─ Terminal (PTY)                              ├─ Undo/Redo Service
├─ Git Panel                                   ├─ Semantic Search (aurora-semantic)
├─ Browser WebView                             ├─ SQLite Database (rusqlite)
└─ Zustand Stores (15+)                        └─ Token Service (tiktoken-rs)
```

## State Management (Zustand)

**Store Files:** `src/store/use{Name}Store.ts`

| Store | Key State |
|-------|-----------|
| `useSettingsStore` | LLM providers, model selection, tool approval, UI prefs |
| `useChatStore` | Messages, loading, pending approval, input content |
| `useThreadStore` | Thread CRUD, persistence via `threadService` |
| `useEditorStore` | Monaco tabs, file content cache, workspace restore |
| `useWorkspaceStore` | File explorer, Git status, fs watcher |
| `useContextStore` | Context window usage, syncs with Rust engine |
| `useCheckpointStore` | Git-based checkpoints per message |
| `useUndoRedoStore` | Per-file undo/redo stacks |
| `useMcpStore` | MCP server connections, tool caching |
| `useSemanticStore` | Semantic search settings, index status |
| `useGitStore` | Git state, branches, commits |
| `useThemeStore` | Active theme, custom themes |
| `useTaskStore` | Task list from `todo_write` tool |
| `useTerminalStore` | PTY terminal sessions |
| `usePendingChangesStore` | Pending file changes tracking |

## Database Schema (SQLite, v11)

**Location:** `%APPDATA%/com.aurora.agent/aurora.db`

| Table | Columns |
|-------|---------|
| `workspace_state` | workspace_path, open_tabs (JSON), panel_sizes (JSON), last_opened_at, checkpoint_enabled |
| `editor_state` | file_path, cursor_line, cursor_col, scroll_offset, folded_regions (JSON) |
| `explorer_state` | workspace_path, expanded_folders (JSON), selected_file |
| `threads` | id, title, summary, messages (JSON), token_usage (JSON), context_usage (JSON), created_at, updated_at |
| `llm_providers` | id, name, nickname, base_url, api_key, model, context_window, max_output_tokens, supports_thinking, supports_tool_stream, enabled, is_custom, custom_models (JSON), model_aliases (JSON), custom_headers (JSON), custom_params (JSON), provider_type, default_temperature, default_max_tokens, requires_api_key, sort_order, created_at, updated_at |
| `tool_settings` | tool_name, approval_mode ('auto'\|'always_ask'\|'deny'), updated_at |
| `custom_themes` | id, name, author, version, type, colors (JSON), token_colors (JSON) |
| `semantic_indexes` | id, workspace_path, document_count, chunk_count, status, excluded_files (JSON), excluded_directories (JSON) |
| `semantic_settings` | model_path, enabled, auto_index, ignored_patterns (JSON), ignored_directories (JSON), excluded_files, excluded_directories, max_file_size, search_mode, lexical_weight, semantic_weight |
| `checkpoints` | id (commit hash), message_id, thread_id, workspace_path, created_at |
| `app_settings` | key, value, updated_at |

## Provider System

**Presets:** `src/services/providers/provider-presets.ts`

| Provider | Format | Auth | Thinking Config |
|----------|--------|------|-----------------|
| `fireworks` | openai | Bearer | `reasoning_effort: 'medium'` → `reasoning_content` |
| `glm` | openai | Bearer | `thinking: {type: 'enabled', clear_thinking: false}` → `reasoning_content` |
| `deepseek` | openai | Bearer | `thinking: {type: 'enabled'}` → `reasoning_content`, skips temp for reasoner |
| `anthropic` | anthropic | x-api-key | Native content blocks → `thinking` |
| `minimax` | anthropic | x-api-key | Native content blocks → `thinking` |
| `openai` | openai | Bearer | No native thinking |
| `lmstudio` | openai | Bearer | `reasoning_effort: 'high'`, uses native Rust HTTP |
| `ollama` | openai | Bearer | No thinking, uses native Rust HTTP |
| `custom` | openai | Bearer | User-defined via customParams |

**Interface:** `src/services/providers/types.ts`

```typescript
interface ProviderConfig {
  id, name, baseUrl, apiKey, model, maxOutputTokens, contextWindow
  supportsThinking, supportsToolStream, providerType
  customHeaders?, customParams?, defaultTemperature?, defaultMaxTokens?
}

interface IProvider {
  streamChat(params, callbacks): Promise<AssistantMessage>
  chat(params): Promise<AssistantMessage>
  cancelRequest(): void
}
```

**Creation:** `createProvider(config)` → detects type → gets preset → returns `OpenAIProvider` or `AnthropicProvider`

## Context Engine (Rust)

**Location:** `src-tauri/src/context/`

Turn-based conversation management:

- **Turn:** User message + all assistant responses/tool calls
- **ToolCallRound:** One assistant response + tool calls + results
- **Summarization:** Triggers at 80% usage, keeps last 2 turns full
- **Tool truncation:** Max 4000 chars per result

**Commands:**
```rust
context_add_user_message(threadId, content, ideContext, contextWindow, maxOutput)
context_add_assistant_response(threadId, content, thinking)
context_add_tool_call(threadId, toolCallId, name, arguments)
context_add_tool_result(threadId, toolCallId, content, isError)
context_finalize_turn(threadId)
context_build_messages(threadId, systemPrompt, tokenBudget) -> ApiMessage[]
context_get_state(threadId, contextWindow, maxOutput) -> ContextState
context_needs_summarization(threadId) -> bool
context_clear_thread(threadId)
```

## MCP Integration

**Rust:** `src-tauri/src/mcp/` (rmcp v0.1)
- Transports: stdio (child process), SSE (HTTP events)
- Auto-connect servers with `autoStart: true`
- Tool prefix: `mcp_{serverId}_{toolName}`

**Frontend:** `src/services/mcp-tools.ts`
- `getMcpToolDefinitions()` → converts MCP tools to provider format
- `executeMcpTool(name, args)` → calls via `McpManager.call_tool()`
- `shouldAutoApproveMcpTool(name)` → checks server `autoApprove` setting

## Tool System

**Definitions:** `src/tools/definitions/`

| Category | Tools |
|----------|-------|
| **File** | `file_read`, `file_write`, `file_patch`, `file_create`, `file_delete`, `file_exists`, `grep`, `multi_file_read`, `search_replace`, `multi_search_replace` |
| **Workspace** | `workspace_tree`, `folder_create`, `folder_delete` |
| **Shell** | `shell_execute`, `shell_spawn`, `shell_kill`, `shell_list_processes` |
| **Editor** | `editor_open_file`, `read_lints` |
| **Search** | `aurora_search` (semantic), `auroro_websearch` (web/fetch) |
| **Todo** | `todo_write` |

**Risk Levels:** `src/tools/definitions/risk-levels-enhanced.ts`
- High: `shell_*`, `file_delete`, `folder_delete`
- Medium: `file_write`, `file_create`, `file_patch`, `folder_create`, `editor_open_file`
- Low: Read-only tools

**Approval Modes:**
- `auto` - Execute without approval
- `always_ask` - Require user approval
- `deny` - Reject immediately

## Agent Service

**Location:** `src/services/agent-service.ts`

```typescript
class AgentService {
  chat(userMessage, callbacks, tools?, ideContext?, promptContext?): Promise<AgentResponse>
  getContextState(): Promise<ContextState>
  clearContext(): Promise<void>
  setThreadId(threadId): void
  setProvider(config): void
  stop(): void
}
```

**Max Iterations:** 25 tool calls per request
**Timeout:** 5 minutes per tool execution

## Checkpoint System

**Rust:** `src-tauri/src/checkpoints/`

Git-based workspace snapshots:
- Shadow repo in app data with `core.worktree` pointing to workspace
- Creates commit on each user message
- Restore: `git clean -fd` + `git reset --hard <commit>`
- Uses **git CLI** (not git2 crate - worktree issues)

**Commands:**
```rust
checkpoint_init(workspacePath)
checkpoint_create(workspacePath, messageId, threadId) -> commitHash
checkpoint_restore(checkpointId)
checkpoint_list(threadId) -> Checkpoint[]
checkpoint_set_enabled(workspacePath, enabled)
```

## Undo/Redo System

**Rust:** `src-tauri/src/undo_redo/`

Per-file history:
- Max 100 entries per file
- Auto-recorded by `file_write`, `file_create`
- Shortcuts: `Ctrl+Z` (undo), `Ctrl+Y` (redo)

**Commands:**
```rust
undo_init_file(filePath, initialContent)
undo_record_change(filePath, change)
undo_file(filePath) -> UndoResult
redo_file(filePath) -> RedoResult
undo_file_and_save(filePath), redo_file_and_save(filePath)
```

## Semantic Search

**Rust:** `aurora-semantic` v1.2.1 (ONNX embeddings)
- Model: Jina Code 1.5B recommended
- Modes: `hybrid` (default), `lexical`, `semantic`
- GPU: CUDA, DirectML, CoreML, TensorRT
- Index storage: App data directory

**Commands:**
```rust
semantic_search(query, workspacePath, limit?, mode?, languages?, chunkTypes?, directories?) -> SearchResult[]
start_semantic_indexing(workspacePath)
update_workspace_exclusions(workspacePath, files[], dirs[])
```

## Git Integration

**Commands:** `src-tauri/src/commands/git.rs`

```rust
git_is_repository(path) -> bool
git_get_status(path) -> FileStatus[]
git_get_branches(path) -> Branch[]
git_get_commits(path, limit?) -> Commit[]
git_stage_file(path, file), git_unstage_file(path, file)
git_commit(path, message), git_checkout(path, branch)
git_pull(path), git_push(path)
git_get_diff(path, file?) -> string
```

## Browser WebView

**Commands:** `src-tauri/src/commands/browser.rs`

```rust
create_browser_webview(label, url, windowLabel)
browser_navigate(label, url)
browser_eval(label, script)
browser_activate_inspector(label), browser_deactivate_inspector(label)
browser_clear_selection(label)
close_browser_webview(label)
```

## CLI Integration

**Commands:** `src-tauri/src/cli.rs`

```rust
install_aurora_cli()      # Adds 'aurora' to PATH
uninstall_aurora_cli()
install_aurora_context_menu()  # Windows right-click menu
```

CLI args support: `aurora .` opens workspace, `aurora file.ts` opens file.

## Key Files

```
src/
  components/
    agent/          # Agent mode UI (AgentModeLayout, AgentChatMessage, etc)
    chat/           # Chat panel (ChatPanel, ChatMessage, ChatInput)
    editor/         # Monaco editor wrapper
    explorer/       # File tree
    git/            # Git panel
    settings/       # Settings UI
  services/
    providers/      # Provider implementations
    agent-service.ts
    agent-prompt.ts # System prompt composition
    skills.ts       # Skill loading
    thread-service.ts  # Rust-backed thread persistence
    token-service.ts   # Rust-backed token counting
  tools/
    definitions/    # Tool schemas
    executors/      # Tool implementations
  store/           # Zustand stores
  lib/
    tauri.ts        # Tauri IPC helpers
    file-cache.ts   # File reading cache
    monaco-ref.ts   # Monaco instance access
  themes/           # Built-in theme JSONs
  types/
    index.ts        # Core types (Message, Tab, etc)
    database.ts     # DB model types

src-tauri/
  src/
    commands/       # Tauri command handlers
    context/        # Context engine (Rust)
    checkpoints/    # Checkpoint service
    undo_redo/      # Undo/redo service
    mcp/            # MCP client
    db/             # SQLite layer
    services/       # Rust services
```

## Constants

```typescript
// File size thresholds (src/store/useEditorStore.ts)
LARGE_FILE_THRESHOLD = 100 * 1024   // 100KB - plaintext mode
MEDIUM_FILE_THRESHOLD = 50 * 1024   // 50KB - reduced features

// Tool limits (src/services/agent-service.ts)
MAX_TOOL_ITERATIONS = 25
TOOL_TIMEOUT_MS = 5 * 60 * 1000     // 5 minutes

// Context engine (src-tauri/src/context/types.rs)
MAX_TOOL_RESULT_LENGTH = 4000       // chars
RECENT_TURNS_FULL_CONTENT = 2       // turns
SUMMARIZATION_THRESHOLD = 80.0      // percentage
MAX_SUMMARY_LENGTH = 500            // chars
```

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl/Cmd+P` | Quick open |
| `Ctrl/Cmd+H` | Chat history (Agent Mode) |
| `Ctrl/Cmd+S` | Save file |
| `Ctrl/Cmd+Z` | Undo |
| `Ctrl/Cmd+Y` | Redo |
| `Ctrl/Cmd+W` | Close tab |
| `Ctrl/Cmd+J` | Toggle terminal |
| `Ctrl/Cmd+K` | Focus chat |
| `Esc` | Close modal / Exit Agent Mode |

## Notes

- Use `pnpm` as package manager
- Version: 1.0.0 (from package.json and Cargo.toml)
- SQLite schema version: 11
- Rust features: `cuda` (default), `directml`, `coreml`, `cpu-only`
