# Architecture

AI-powered agentic code editor built with Tauri (Rust backend + React frontend). Provides a VS Code-like interface with an AI assistant that executes tools to manipulate files, run commands, navigate workspaces, perform semantic code search, integrate MCP servers, and manage Git repositories.

**Version:** 1.5.0

---

## Table of Contents

- [1. Project Overview](#1-project-overview)
- [2. Tech Stack](#2-tech-stack)
- [3. Directory Tree](#3-directory-tree)
- [4. Core Classes & Modules](#4-core-classes--modules)
- [5. Dependency Graph](#5-dependency-graph)
- [6. Data Flow](#6-data-flow)
- [7. External Integrations](#7-external-integrations)

---

## 1. Project Overview

Aurora is a desktop IDE that combines traditional code editing with AI assistance. It features a Monaco-based editor, multi-turn AI conversations with tool calling, semantic code search using ONNX embeddings, MCP server integration, Git integration, and a terminal. The architecture uses a Rust backend for heavy operations (file I/O, AI streaming, database) and a React frontend for UI.

---

## 2. Tech Stack

| Layer | Technology | Version | Purpose |
|-------|------------|---------|---------|
| Language | TypeScript | 5.9.3 | Frontend code |
| Language | Rust | 1.85+ | Backend code |
| Framework | React | 18.3.1 | UI framework |
| Runtime | Tauri | 2.9.x | Desktop app shell |
| Build Tool | Vite | 7.2.4 | Frontend bundler |
| Editor | Monaco Editor | 0.55.1 | Code editing |
| State | Zustand | 5.0.9 | State management |
| Styling | Tailwind CSS | 3.4.17 | CSS framework |
| Database | SQLite | rusqlite | State persistence |
| Terminal | xterm.js | 6.0.0 | Integrated terminal |
| Icons | Lucide React | 0.562.0 | Icon library |

### Provider Presets

| Provider | ID | Auth | Format | Features |
|----------|-----|------|--------|----------|
| OpenAI | `openai` | Bearer | OpenAI | Standard |
| Anthropic | `anthropic` | x-api-key | Anthropic | Thinking mode |
| **Fireworks** | `fireworks` | Bearer | OpenAI | Account sync, CLI integration, usage tracking |
| GLM / Z.AI | `glm` | Bearer | OpenAI | Preserved thinking (200k context) |
| DeepSeek | `deepseek` | Bearer | OpenAI | Reasoner mode (64k context) |
| MiniMax M2.1 | `minimax` | x-api-key | Anthropic | Native thinking blocks (200k context) |
| Ollama | `ollama` | None | OpenAI | Local inference |
| LM Studio | `lmstudio` | None | OpenAI | Local inference |

---

## 3. Directory Tree

```
src/                          # Frontend React code
├── components/               # React components
│   ├── agent/               # AI agent UI components
│   ├── chat/                # Chat panel components
│   ├── editor/              # Monaco editor wrapper
│   ├── explorer/            # File explorer
│   ├── git/                 # Git integration UI
│   ├── layout/              # Layout components
│   ├── modals/              # Modal dialogs
│   └── ui/                  # Shared UI primitives
├── hooks/                   # Custom React hooks
├── services/                # Business logic services
│   ├── providers/           # LLM provider implementations
│   ├── agent-service.ts     # AI agent orchestration
│   └── thread-service.ts    # Message persistence
├── store/                   # Zustand state stores
├── tools/                   # AI tool system
│   ├── definitions/         # Tool schemas
│   └── executors/           # Tool implementations
├── types/                   # TypeScript type definitions
└── themes/                  # Built-in theme files

src-tauri/src/               # Rust backend code
├── commands/                # Tauri command handlers
├── context/                 # Turn-based context engine
├── db/                      # Database layer
│   ├── migrations/          # Schema migrations
│   └── repositories/        # Data access
├── mcp/                     # MCP client implementation
├── services/                # Rust services
├── checkpoints/             # File state snapshots
└── undo_redo/               # Per-file undo/redo
```

---

## 4. Core Classes & Modules

### AgentService (`src/services/agent-service.ts`)

**Exports:** Named: `AgentService`, `getAgentService`, `initAgentService`

**Depends on:** `IProvider`, `AgentToolRunner`, `toolRegistry`, `getMcpToolDefinitions`

**Constructor:** `new AgentService(config?: AgentConfig)`

**Key Methods:**

| Method | Signature | Purpose |
|--------|-----------|---------|
| `chat` | `(message: string, callbacks: AgentCallbacks, tools?: ToolDefinition[]): Promise<AgentResponse>` | Main chat method with tool loop |
| `getContextState` | `(): Promise<ContextState \| null>` | Get current context usage |
| `clearContext` | `(): Promise<void>` | Clear thread context |
| `setProvider` | `(config: ProviderConfig): void` | Update LLM provider |
| `updateConfig` | `(config: Partial<AgentConfig>): void` | Update service configuration |
| `isActive` | `(): boolean` | Check if agent is running |
| `setThreadId` | `(threadId: string): void` | Set current thread ID |

### ProviderRegistry (`src/services/providers/index.ts`)

**Exports:** Named: `providerRegistry`, `createProvider`, `initProvider`

**Key Methods:**

| Method | Signature | Purpose |
|--------|-----------|---------|
| `register` | `(config: ProviderConfig): IProvider` | Register new provider |
| `get` | `(id: string): IProvider \| undefined` | Get provider by ID |
| `getCurrent` | `(): IProvider \| null` | Get active provider |
| `getIds` | `(): string[]` | Get all registered provider IDs |
| `has` | `(id: string): boolean` | Check if provider exists |
| `remove` | `(id: string): boolean` | Remove a provider |
| `setCurrent` | `(id: string): boolean` | Set active provider |
| `clear` | `(): void` | Clear all providers |

**Additional Exports:** `createProvider()`, `getProvider()`, `initProvider()`, `isProviderInitialized()`, `updateProvider()`, `DEFAULT_CONTEXT_WINDOWS`, `getDefaultContextWindow()`, `getPresetContextWindow()`, `getPresetMaxOutput()`

### useEditorStore (`src/store/useEditorStore.ts`)

**Exports:** Named: `useEditorStore`

**State:**

| Property | Type | Purpose |
|----------|------|---------|
| `tabs` | `Tab[]` | Open editor tabs |
| `activeTabId` | `string \| null` | Currently active tab |
| `fontSize` | `number` | Editor font size |

**Tab Properties:** `id`, `path`, `filename`, `content`, `isDirty`, `isLargeFile` (>100KB), `isMediumFile` (>50KB), `isLoading`, `isDeleted`, `language`, `type` ('file' | 'browser')

**Actions:** `openFile`, `closeTab`, `setActiveTab`, `updateTabContent`, `saveTabToDisk`, `restoreWorkspace`, `saveWorkspace`, `openBrowserTab`, `updateBrowserTab`, `reloadTabContent`, `markTabAsDeleted`, `setFontSize`, `setPanelSizes`, `setWorkspacePath`

### Context Engine (`src-tauri/src/context/`)

**Module:** Rust-based turn-based conversation management

**Types:** `Turn`, `ToolCallRound`, `ContextState`

**Tauri Commands:** `context_add_user_message`, `context_add_assistant_response`, `context_build_messages`, `context_build_request_messages`, `context_finalize_turn`, `context_add_tool_call`, `context_add_tool_result`, `context_get_state`, `context_needs_summarization`, `context_clear_thread`, `context_estimate_request_tokens`, `context_get_turns`, `context_init_from_thread`, `context_update_settings`

### AgentToolRunner (`src/services/agent-tool-runner.ts`)

**Exports:** Named: `AgentToolRunner`

**Constructor:** `new AgentToolRunner(options: AgentToolRunnerOptions)`

**Key Methods:**

| Method | Signature | Purpose |
|--------|-----------|---------|
| `executeToolCalls` | `(toolCalls: ToolCallRequest[]): Promise<ToolExecutionBatch>` | Execute multiple tool calls |

### ToolRegistry (`src/tools/registry.ts`)

**Exports:** Named: `toolRegistry` (singleton), `ToolRegistry` (class)

**Key Methods:**

| Method | Signature | Purpose |
|--------|-----------|---------|
| `registerDefinition` | `(definition: ToolDefinition): void` | Register tool schema |
| `registerExecutor` | `(name: string, executor: ToolExecutor): void` | Register implementation |
| `executeToolCall` | `(toolCall: ToolCallRequest, preParsedArgs?): Promise<ToolCallResult>` | Execute a tool |
| `getToolDefinitions` | `(): ToolDefinition[]` | Get all tool schemas |
| `requiresApproval` | `(name: string): boolean` | Check if tool needs approval |
| `getRiskLevel` | `(name: string): 'low' \| 'medium' \| 'high'` | Get tool risk level |

### databaseService (`src/services/database.ts`)

**Exports:** Named: `databaseService` (singleton), `DatabaseService` (class)

**Purpose:** SQLite persistence layer via Tauri commands

**Key Methods:** Provider CRUD, tool settings, workspace state, editor state, explorer state

### FireworksService (`src/services/fireworks.ts`)

**Exports:** Named functions: `detectFireworksCli`, `exportFireworksUsage`, `fetchFireworksOverview`

**Types:** `FireworksCliStatus`, `FireworksOverview`, `FireworksUsageSummary`

**Purpose:** Fireworks API integration and CLI usage export

### Zustand State Stores

| Store | File | Purpose |
|-------|------|---------|
| `useSettingsStore` | `src/store/useSettingsStore.ts` | LLM providers, UI settings |
| `useChatStore` | `src/store/useChatStore.ts` | Chat messages, loading state |
| `useThreadStore` | `src/store/useThreadStore.ts` | Thread persistence |
| `useEditorStore` | `src/store/useEditorStore.ts` | Tabs, workspace |
| `useWorkspaceStore` | `src/store/useWorkspaceStore.ts` | File explorer |
| `useMcpStore` | `src/store/useMcpStore.ts` | MCP server connections |
| `useCheckpointStore` | `src/store/useCheckpointStore.ts` | File snapshots |
| `useContextStore` | `src/store/useContextStore.ts` | Token usage tracking |
| `useGitStore` | `src/store/useGitStore.ts` | Git integration |
| `useTaskStore` | `src/store/useTaskStore.ts` | Todo/task management |
| `useSemanticStore` | `src/store/useSemanticStore.ts` | Semantic search |
| `useAuditStore` | `src/store/useAuditStore.ts` | Audit timeline |
| `usePendingChangesStore` | `src/store/usePendingChangesStore.ts` | Pending file changes |
| `useUndoRedoStore` | `src/store/useUndoRedoStore.ts` | Per-file undo/redo |
| `useTerminalStore` | `src/store/useTerminalStore.ts` | Terminal state |
| `useUiStore` | `src/store/useUiStore.ts` | UI state |
| `useDragStore` | `src/store/useDragStore.ts` | Drag/drop operations |

### FireworksSettingsTab (`src/components/modals/FireworksSettingsTab.tsx`)

**Exports:** Named: `FireworksSettingsTab`

**Purpose:** Fireworks provider configuration panel with account sync and usage tracking

**Features:** API key management, account ID config, account metadata sync, CLI (`firectl`) detection, 30-day usage metrics, model catalog management

**Key State:** `overview` (account metadata), `usageSummary` (30-day usage), `cliStatus` (CLI availability)

---

## 5. Dependency Graph

```
┌─────────────────────────────────────────────────────────────────┐
│                    Frontend (React/TS)                          │
│  ┌─────────────┐  ┌──────────────┐  ┌──────────────┐             │
│  │ Agent Mode  │  │ Editor Panel │  │ Chat Panel   │             │
│  │ (Full-chat) │  │ (Monaco)     │  │ (Timeline)   │             │
│  └─────────────┘  └──────────────┘  └──────────────┘             │
│         │                 │                 │                   │
│         └─────────────────┴─────────────────┘                   │
│                           │                                     │
│                  ┌────────▼────────┐                           │
│                  │  State Stores   │                           │
│                  │   (Zustand)     │                           │
│                  └────────┬────────┘                           │
└───────────────────────────┼─────────────────────────────────────┘
                            │ Tauri IPC
                            │
┌───────────────────────────▼─────────────────────────────────────┐
│                  Rust Backend (Tauri)                           │
│  ┌──────────────┐  ┌─────────────┐  ┌──────────────┐           │
│  │Context Engine│  │   MCP       │  │ Checkpoint   │           │
│  │(Turn-based)  │  │  Manager    │  │ Service      │           │
│  └──────────────┘  └─────────────┘  └──────────────┘           │
│  ┌──────────────┐  ┌─────────────┐  ┌──────────────┐           │
│  │Undo/Redo     │  │  Services   │  │ Database     │           │
│  │(Per-file)    │  │  (Thread,   │  │ (SQLite)     │           │
│  │              │  │   Token)    │  │              │           │
│  └──────────────┘  └─────────────┘  └──────────────┘           │
└─────────────────────────────────────────────────────────────────┘
```

---

## 6. Data Flow

### AI Chat Request Flow

1. **User sends message** → `AgentService.chat()`
2. **Add user message** → `invoke("context_add_user_message")`
3. **Build context** → `invoke("context_build_messages")` returns message history
4. **Stream from LLM** → `provider.streamChat()` with callbacks
5. **Record assistant response** → `invoke("context_add_assistant_response")`
6. **Execute tools** → `AgentToolRunner.executeToolCalls()`
7. **Finalize turn** → `invoke("context_finalize_turn")`

### File Save Flow

1. **User presses Ctrl+S** → `useEditorStore.saveTabToDisk()`
2. **Write to disk** → `writeFileContent()` Tauri command
3. **Mark clean** → Update `isDirty: false` in store
4. **Record checkpoint** → `invoke("checkpoint_create")` (async)

---

## 7. External Integrations

### LLM Providers

| Provider | Auth | Endpoint | Notes |
|----------|------|----------|-------|
| OpenAI | `Authorization: Bearer {key}` | `https://api.openai.com/v1/chat/completions` | Standard OpenAI API |
| Anthropic | `x-api-key: {key}` | `https://api.anthropic.com/v1/messages` | Thinking mode via `thinking` blocks |
| **Fireworks** | `Authorization: Bearer {key}` | `https://api.fireworks.ai/inference/v1/chat/completions` | Account sync, CLI (`firectl`) usage export, model catalog |
| GLM / Z.AI | `Authorization: Bearer {key}` | `https://api.z.ai/api/coding/paas/v4/chat/completions` | Preserved thinking with `clear_thinking: false` |
| DeepSeek | `Authorization: Bearer {key}` | `https://api.deepseek.com/v1/chat/completions` | Reasoner mode, 64k context |
| MiniMax | `x-api-key: {key}` | `https://api.minimax.io/anthropic/v1/messages` | Native thinking blocks, Anthropic-compatible |
| Ollama | None | `http://localhost:11434/v1/chat/completions` | Local inference |
| LM Studio | None | `http://localhost:1234/v1/chat/completions` | Local inference |

### MCP Servers
