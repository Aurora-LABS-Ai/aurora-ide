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
| `glm` | openai | Bearer | `{ thinking: { type: 'enabled' } }` → `reasoning_content` | `tool_stream: true` |
| `deepseek` | openai | Bearer | `{ thinking: { type: 'enabled' } }` → `reasoning_content` | Skip temp for reasoner |
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

1. **useSettingsStore** - Global app settings, LLM providers, model selection
   - Persists to SQLite database
   - Model selection format: `"providerId:model"` (e.g., `"glm:glm-4.7"`)
   - Provider config includes: `baseUrl`, `apiKey`, `model`, `contextWindow`, `maxOutputTokens`, `supportsThinking`, `customHeaders`, `customParams`, `providerType`

2. **useChatStore** - Chat messages, loading state, tool approval workflow

3. **useThreadStore** - Conversation thread management
   - Persists threads to `.aurora/threads/{threadId}.json`

4. **useEditorStore** - Monaco editor tabs, active tab, file content caching

5. **useWorkspaceStore** - File explorer, root path, file tree, filesystem watcher

6. **useUiStore** - Theme, modal states, chat panel visibility

7. **useDragStore** - Drag-drop state for file operations

8. **useTaskStore** - Task management (UI only)

9. **useTerminalStore** - Integrated terminal sessions

10. **useContextStore** - Context window usage tracking

11. **useAuditStore** - Tool execution audit log

### Database Persistence (SQLite)

**Database Location:**
- Windows: `%APPDATA%\com.aurora.agent\aurora.db`
- macOS: `~/Library/Application Support/com.aurora.agent/aurora.db`
- Linux: `~/.config/com.aurora.agent/aurora.db`

**Architecture:** `src-tauri/src/db/`

```
db/
  mod.rs          - Database manager, exposes repositories
  connection.rs   - SQLite connection with WAL mode
  schema.rs       - Table definitions (version 3)
  migrations.rs   - Version-based migration system
  models.rs       - Rust structs
  repositories/
    settings.rs   - LLM providers, app settings, tool settings
    workspace.rs  - Workspace state
    editor.rs     - Editor state per file
    explorer.rs   - File explorer state
    threads.rs    - Chat threads with token/context usage
```

**Key Tables:**
- `llm_providers` - Provider configs (21 columns including customHeaders, customParams as JSON)
- `app_settings` - Key-value settings store
- `tool_settings` - Per-tool approval modes
- `workspace_state`, `editor_state`, `explorer_state`
- `threads` - Chat history with token usage

### Agent Service

Located in `src/services/agent-service.ts`:

- Orchestrates AI conversation with tool execution
- Conversation loop: LLM → Tool Calls → Execution → Response
- Max 25 tool iterations per request
- Streaming callbacks: `onToken`, `onThinking`, `onToolCall`, `onToolExecution`, `onUsage`, `onComplete`

**Flow:**
```
User Input → ChatPanel → context-builder.ts → agent.setProvider(config)
→ agent.chat() → Provider.streamChat() → Tool Execution → Response
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
  executors/
    file-executors-enhanced.ts
    shell-executors.ts
    workspace-executors.ts
    editor-executors.ts
  registry.ts          - Central tool registration
```

**Available Tools:**
- **File:** `file_read`, `file_write`, `file_patch`, `file_create`, `file_delete`, `file_exists`, `file_search`, `grep`, `multi_file_read`
- **Workspace:** `workspace_tree`, `folder_create`, `folder_delete`, `workspace_info`
- **Shell:** `shell_execute`, `shell_spawn`, `shell_kill`, `shell_list_processes`
- **Editor:** `editor_open_file`, `editor_get_active_file`, `editor_get_selection`, `editor_insert_text`, `editor_get_open_tabs`, `editor_close_tab`

### Component Architecture

**Layout:** `src/components/layout/MainLayout.tsx`
- Three-panel layout: Explorer (18%) | Editor (57%) | Chat (25%)
- Custom title bar with window controls
- Detachable chat window

**Key Components:**
- `ChatPanel` - Chat interface with message history, thread sidebar
- `ChatInput` - Input with model selector, thinking toggle, file mentions
- `EditorPanel` - Monaco editor with tabs
- `FileExplorer` - File tree with context menu, drag-drop
- `Terminal` - Integrated terminal with multiple sessions

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
| `thread-converter.ts` | UI → API message format conversion |
| `token-estimator.ts` | Character-based token estimation |
| `database.ts` | Frontend database API |

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
| `components/terminal/Terminal.tsx` | Integrated terminal |

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

1. User configures in Settings → stored in `llm_providers` table as JSON
2. `getLLMConfig()` returns config with `customHeaders` and `customParams`
3. Provider's `buildHeaders()` merges: `preset headers + customHeaders`
4. Provider's `buildRequestBody()` applies: `preset params, then customParams override`

### Provider-Specific Behaviors (Now Centralized)

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

## VS Code-Inspired Design

- Color hierarchy: titlebar (darkest) → tabs → sidebar → editor (lightest)
- Integrated terminal with PowerShell/Bash profiles
- File explorer with expand/collapse, context menu
- Monaco editor with syntax highlighting
- Detachable chat window
