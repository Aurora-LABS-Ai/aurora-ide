# Aurora Agent Frontend — Architecture

## Table of Contents
1. [Project Overview](#project-overview)
2. [Tech Stack](#tech-stack)
3. [Directory Structure](#directory-structure)
4. [Core Components](#core-components)
5. [Data Flow](#data-flow)
6. [API Structure](#api-structure)
7. [External Dependencies](#external-dependencies)
8. [Entry Points & Bootstrapping](#entry-points--bootstrapping)

## Project Overview
Aurora is a desktop-first AI pair-programming environment built with React, Vite, and Tauri. The frontend mimics a modern IDE with chat-driven automation, embedded editors, and workspace management, while the Rust-based Tauri core exposes filesystem, shell, and persistence capabilities. The agent layer orchestrates LLM-powered conversations with controllable tool execution for safe automation of development workflows.

## Tech Stack
- **Languages:** TypeScript/React (UI), Rust (Tauri backend)
- **Frameworks & Runtimes:** Vite, Tauri 2.x, Zustand for state, TailwindCSS for design tokens, react-resizable-panels for layout
- **AI/LLM:** Pluggable OpenAI-compatible providers (DeepSeek, GLM, custom) via `LLMProvider`
- **Persistence:** SQLite (through Tauri + rusqlite) accessed by `databaseService`
- **Build Tooling:** pnpm, TypeScript project references (`tsconfig.app.json`, `tsconfig.node.json`), ESLint 9
- **UI Libraries:** Lucide icons, Monaco editor wrapper, react-markdown, react-resizable-panels

## Directory Structure
```
├── src
│   ├── components
│   │   ├── chat           # Conversations, thread history, tool approval UI
│   │   ├── editor         # Tab bar + Monaco editor integration
│   │   ├── explorer       # Workspace tree & filesystem interactions
│   │   ├── layout         # Title bar, status bar, master layout
│   │   ├── modals         # Settings, audit, tool approval dialogs
│   │   ├── terminal       # Inline terminal surface
│   │   └── ui             # Shared primitives
│   ├── hooks              # Cross-window sync, workspace bootstrap helpers
│   ├── lib                # Tauri bridge + window sync helpers
│   ├── services           # Agent orchestration, LLM provider, persistence
│   ├── store              # Zustand stores for UI/chat/editor/workspace
│   ├── tools              # Tool definitions, registry, executors
│   ├── types              # Shared TS types (tabs, DB state, tool shapes)
│   ├── App.tsx            # Runtime shell, route-based detached chat handling
│   └── main.tsx           # Vite bootstrap
├── src-tauri
│   ├── src                # Rust commands exposed to frontend (DB, FS, shell)
│   ├── tauri.conf.json    # Windowing + bundling configuration
│   └── Cargo.(toml|lock)  # Rust crate metadata
├── public                 # Static assets loaded by Vite
├── DOCS                   # Generated documentation (this folder)
└── config files           # package.json, tailwind.config.js, tsconfig.*, etc.
```

## Core Components
### Layout & Shell
- **`App.tsx`**: Detects detached chat routes, restores workspace state, toggles theme, and globally disables default context menus.
- **`MainLayout`**: Builds IDE chrome with `react-resizable-panels`, hosts Explorer, Editor, Chat, Terminal, and overlays (Settings, Audit, Tool approval).

### Workspace & Editor
- **`useWorkspaceStore`**: Coordinates root path selection, directory reads, expanded folder state, and persistence via Tauri invocations.
- **`useEditorStore`**: Manages open tabs, active tab, dirty tracking, font size, and saves/loads workspace layouts through `databaseService`.
- **`components/editor`**: `TabBar` + `CodeEditor` (Monaco integration) reflecting Zustand state.

### Chat & Agent Loop
- **`ChatPanel`**: Primary conversational surface; streams tokens, thinking traces, and tool events; orchestrates tool approvals and timeline visualizations.
- **`useChatStore` / `useThreadStore`**: Persist threads, pending approvals, and per-message timelines.
- **`services/agent-service.ts`**: Core orchestrator that loops through LLM responses, executes registered tools, and enforces approval policies.
- **`services/llm-provider.ts`**: OpenAI-compatible streaming client with provider-specific tuning (DeepSeek, GLM, generic) and tool streaming support.
- **`tools/`**: JSON-schema tool definitions, registry, and executors bridging to filesystem, shell, search, etc.

### Persistence & Integration
- **`services/database.ts`**: Bridges to Rust commands (`invoke`) for workspace state, explorer state, editor positions, provider configs, and tool approvals.
- **`lib/tauri.ts`**: Thin wrappers for filesystem, shell, dialog, clipboard, and workspace helper commands.
- **`src-tauri`**: Rust implementation providing the actual command handlers, SQLite layer (rusqlite), and plugin wiring (filesystem, dialog, clipboard, etc.).

## Data Flow
1. **Bootstrap**: `main.tsx` mounts `App`. `useWorkspaceBootstrap` restores the last workspace through the database, while `useEditorStore` pulls saved tabs/panel sizes.
2. **State Synchronization**: UI state is centralized in multiple Zustand stores. `useWindowStateSync` mirrors critical pieces between main and detached chat windows via `windowSync` helpers.
3. **Chat Loop**:
   - User input enters `ChatPanel`, which ensures a thread exists and calls `getAgentService().chat`.
   - `AgentService` sends messages to `LLMProvider`, streams tokens and tool calls back to `ChatPanel`.
   - Tool calls go through `toolRegistry`, optionally triggering approval modals. Executors perform filesystem/shell/database actions via Tauri APIs.
   - Tool results feed back into the conversation history, eventually producing a final assistant response.
4. **Persistence**: Workspace layouts, explorer favorites, and settings are saved through `databaseService` to SQLite (rusqlite on the Rust side). Editor changes trigger save operations to keep state consistent between sessions.
5. **UI Rendering**: React components subscribe to the relevant store slices (e.g., `useUiStore` for theme/chat visibility, `useTerminalStore` for panel toggles) and re-render when actions mutate the store.

## API Structure
- **Frontend (TypeScript) APIs**:
  - `databaseService.invoke*` functions map to Tauri commands (`save_workspace_state`, `get_app_settings`, etc.).
  - `LLMProvider.chatCompletion/streamChatCompletion` hit `{baseUrl}/chat/completions` endpoints compatible with OpenAI.
  - `toolRegistry` exposes `executeToolCall`, `requiresApproval`, and definition queries for the agent runtime.
- **Rust/Tauri Commands** (high level):
  - Filesystem: `read_directory`, `read_file_content`, `write_file_content`, `create_folder`, etc.
  - System/shell: `execute_command`, `get_system_info`.
  - Persistence: `save_workspace_state`, `get_workspace_state`, `get_editor_state`, `save_explorer_state`, provider CRUD, tool settings.
- **Agent Tools**: Implemented as OpenAI function call schemas (e.g., file operations, search, command execution). Each maps to a TypeScript executor that wraps Tauri commands for actual side effects.

## External Dependencies
- **LLM providers**: Any OpenAI-compatible API (configurable base URL/model). Supports DeepSeek, GLM, Z.AI, or custom endpoints with optional thinking/tool stream parameters.
- **Tauri Plugins**: Clipboard manager, dialog, filesystem, OS, process, shell.
- **SQLite**: Persisted via `rusqlite` bundled with Tauri.
- **Monaco Editor**: Embedded via `@monaco-editor/react` for code editing.
- **Date Utilities**: `date-fns` for timestamps in timelines/history.

## Entry Points & Bootstrapping
1. **`main.tsx`** mounts `<App />` into `#root` with React StrictMode.
2. **`App.tsx`** determines whether the window represents the primary IDE or a detached chat. It restores workspace/editor state, syncs theme to `document.documentElement`, and disables the default context menu.
3. **`MainLayout`** composes the explorer/editor/chat panels with resizable boundaries and registers modal overlays.
4. **`useWorkspaceBootstrap`** runs once inside Tauri to hydrate the workspace path from SQLite, enabling the explorer and editor stores to fetch directory structures and tabs immediately.
5. **`registerAllExecutors`** is triggered from `ChatPanel` on mount to ensure tool handlers exist before any agent interactions.

This layered architecture cleanly separates UI rendering, state management, agent orchestration, and native integrations—making the system easier to extend with new tools, providers, or surfaces (e.g., more panels or detached windows).
