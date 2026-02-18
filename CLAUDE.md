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
pnpm build
```

**Note:** Use `pnpm` as the package manager for this project.

## Project Overview

Aurora is an AI-powered agentic code editor built with Tauri (Rust backend + React frontend). It provides a VS Code-like interface with an AI assistant that can execute tools to manipulate files, run commands, navigate workspaces, and perform semantic code search.

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
- tauri-plugin-pty (integrated terminal)
- tauri-plugin-process, tauri-plugin-os, tauri-plugin-clipboard-manager
- rusqlite (SQLite database for state persistence)
- aurora-semantic v1.2.1 (semantic code search with ONNX embeddings)
- Tokio (async runtime)

## Architecture

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

### State Management (Zustand Stores)

Located in `src/store/`:

| Store | Purpose |
|-------|---------|
| `useSettingsStore` | Global app settings, LLM providers, model selection. Persists to SQLite. Model format: `"providerId:model"` |
| `useChatStore` | Chat messages, loading state, tool approval workflow |
| `useThreadStore` | Conversation thread management, persists to `.aurora/threads/` |
| `useEditorStore` | Monaco editor tabs, active tab, file content caching |
| `useWorkspaceStore` | File explorer, root path, file tree, filesystem watcher |
| `useUiStore` | Theme, modal states, chat panel visibility |
| `useDragStore` | Drag-drop state for file operations |
| `useTaskStore` | Task/todo list management (UI display) |
| `useTerminalStore` | Integrated terminal sessions |
| `useContextStore` | Context window usage tracking |
| `useAuditStore` | Tool execution audit log |
| `useSemanticStore` | Semantic search settings, indexes, search state |
| `useThemeStore` | Custom theme management |
| `usePendingChangesStore` | Pending file changes before approval |
| `useCheckpointStore` | Checkpoint state, creation, restore operations |

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
- `threads` - Chat history with token usage
- `custom_themes` - User-imported themes
- `semantic_indexes` - Per-workspace semantic search indexes with exclusions
- `semantic_settings` - Global semantic search settings (model path, enabled, etc.)
- `checkpoints` - Checkpoint metadata (id, message_id, thread_id, workspace_path, created_at)

### Agent Service

Located in `src/services/agent-service.ts`:

- Orchestrates AI conversation with tool execution
- Conversation loop: LLM -> Tool Calls -> Execution -> Response
- Max 25 tool iterations per request
- Streaming callbacks: `onToken`, `onThinking`, `onToolCall`, `onToolExecution`, `onUsage`, `onComplete`

**Flow:**
```
User Input -> ChatPanel -> context-builder.ts -> agent.setProvider(config)
-> agent.chat() -> Provider.streamChat() -> Tool Execution -> Response
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
| **Search** | `aurora_search` (semantic code search with filters) |
| **Tasks** | `todo_write` (task list management) |

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
- GPU acceleration support (CUDA, DirectML, CoreML)
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

### Component Architecture

**Layout:** `src/components/layout/MainLayout.tsx`
- Three-panel layout: Explorer (18%) | Editor (57%) | Chat (25%)
- Custom title bar with window controls
- Detachable chat window

**Key Components:**

| Component | Purpose |
|-----------|---------|
| `ChatPanel` | Chat interface with message history, thread sidebar |
| `ChatInput` | Input with model selector, thinking toggle, file mentions |
| `ChatHistory` | Message display with markdown rendering |
| `EditorPanel` | Monaco editor with tabs |
| `FileExplorer` | File tree with context menu, drag-drop |
| `Terminal` | Integrated terminal with multiple sessions (PTY-based) |
| `SettingsPanel` | Settings modal with tabs (Providers, Semantic Search, Appearance, Tools, General) |
| `SemanticSettingsTab` | Semantic search configuration |
| `TaskList` | Todo/task display panel |

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

## File Structure

### Services (`src/services/`)

| File | Purpose |
|------|---------|
| `agent-service.ts` | AI conversation orchestration |
| `context-builder.ts` | Cursor-style IDE context gathering |
| `thread-converter.ts` | UI -> API message format conversion |
| `token-estimator.ts` | Character-based token estimation |
| `database.ts` | Frontend database API |
| `semantic.ts` | Semantic search service (frontend) |
| `theme-service.ts` | Custom theme loading and management |
| `syntax-validator.ts` | Code syntax validation |
| `multi-file-service.ts` | Multi-file read operations |

### Providers (`src/services/providers/`)

| File | Purpose |
|------|---------|
| `provider-presets.ts` | **Centralized provider configurations** |
| `types.ts` | Type definitions (Message, ProviderConfig, etc.) |
| `base-provider.ts` | Abstract base with HTTP, token counting |
| `openai-provider.ts` | OpenAI, DeepSeek, GLM implementation |
| `anthropic-provider.ts` | Claude, MiniMax implementation |
| `token-counter.ts` | Character-based token estimation |
| `context-manager.ts` | Context overflow handling |
| `index.ts` | Provider factory and registry |

### Key UI Components

| File | Purpose |
|------|---------|
| `components/chat/ChatPanel.tsx` | Main chat orchestration |
| `components/chat/ChatInput.tsx` | Input with model/thinking controls |
| `components/chat/ChatHistory.tsx` | Message display |
| `components/modals/SettingsPanel.tsx` | Settings modal |
| `components/modals/SemanticSettingsTab.tsx` | Semantic search settings |
| `components/terminal/Terminal.tsx` | Integrated terminal |
| `components/tasks/TaskList.tsx` | Todo list display |

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

### Context Management

```typescript
// Token estimation before each request
const totalTokens = systemPromptTokens + historyTokens + newMessageTokens + toolsTokens;

// Context state tracking
const contextState = {
  usedTokens,
  contextWindow,
  percentage,
  isNearLimit: percentage >= 80,
  isOverLimit: usedTokens > allowedTokens,
};

// Automatic truncation at 50% when over limit
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

## Rust Backend Commands

**File Operations:** `src-tauri/src/commands/mod.rs`
- `read_directory`, `read_file_content`, `write_file_content`
- `create_file`, `create_folder`, `delete_path`, `rename_path`, `copy_path`
- `execute_command`, `get_system_info`
- `start_fs_watcher`, `stop_fs_watcher`

**Settings:** `src-tauri/src/commands/settings.rs`
- `get_all_providers`, `save_provider`, `delete_provider`
- `get_app_settings`, `save_app_settings`
- `set_tool_approval`, `get_all_tool_settings`

**LLM Streaming:** `src-tauri/src/commands/llm.rs`
- `llm_request` - Non-streaming HTTP request
- `llm_stream_request` - Streaming with Tauri events

**Semantic Search:** `src-tauri/src/commands/semantic.rs`
- `get_semantic_settings`, `save_semantic_settings`, `set_semantic_model_path`
- `validate_semantic_model_path`, `get_semantic_model_info`
- `get_all_semantic_indexes`, `get_semantic_index`, `get_semantic_index_by_path`
- `save_semantic_index`, `delete_semantic_index`, `update_semantic_index_status`
- `update_workspace_exclusions` - Per-workspace exclusion management
- `start_semantic_indexing`, `cancel_semantic_indexing`, `is_semantic_indexing`
- `semantic_search` - Execute search with filters
- `get_semantic_data_directory`, `get_semantic_index_path`
- `get_execution_provider_info`, `get_available_gpu_features`

**Themes:** `src-tauri/src/commands/themes.rs`
- `get_all_themes`, `save_theme`, `delete_theme`
- `set_active_theme_id`, `get_active_theme_id`

**Checkpoints:** `src-tauri/src/commands/checkpoints.rs`
- `checkpoint_init` - Initialize checkpoint service on app startup
- `checkpoint_create` - Create checkpoint for user message
- `checkpoint_restore` - Restore workspace to checkpoint state
- `checkpoint_list` - Get all checkpoints for a thread
- `checkpoint_get_by_message` - Get checkpoint by message ID
- `checkpoint_delete_thread` - Delete all checkpoints for a thread
- `checkpoint_is_initialized` - Check if checkpoint service is ready
- `checkpoint_get_enabled`, `checkpoint_set_enabled` - Per-workspace toggle

## VS Code-Inspired Design

- Color hierarchy: titlebar (darkest) -> tabs -> sidebar -> editor (lightest)
- Integrated terminal with PowerShell/Bash profiles (PTY-based)
- File explorer with expand/collapse, context menu, drag-drop
- Monaco editor with syntax highlighting
- Detachable chat window
- Custom theme support (import VS Code themes)

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
- GPU acceleration when available (CUDA, DirectML, CoreML)
