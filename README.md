# Aurora AI-Powered Code Editor

<div align="center">

**A next-generation AI-powered code editor built with Tauri**

[![Version](https://img.shields.io/badge/version-0.1.2-blue)](https://github.com/Aurora-LABS-Ai/aurora-ide)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![Tauri](https://img.shields.io/badge/Tauri-2.x-orange)](https://tauri.app)
[![React](https://img.shields.io/badge/React-18.3.1-cyan)](https://reactjs.org)

</div>

---

## Overview

**Aurora** is a cutting-edge AI-powered agentic code editor built with Tauri (Rust backend + React frontend). It provides a VS Code-like interface with an integrated AI assistant that can execute tools to manipulate files, run commands, navigate workspaces, and much more.

### Key Features

- **AI Agent Assistant** - Integrated AI that can execute 25+ tools to help you code
- **Advanced Theming** - 50+ theme tokens across 7 categories with VS Code-style themes
- **MCP Protocol Support** - Extensible tool system via Model Context Protocol servers
- **Git Integration** - Full Git operations within the editor
- **Checkpoint/Restore** - Workspace state snapshots and restoration
- **Semantic Search** - AI-powered code search using embeddings
- **Undo/Redo System** - Full undo/redo support with keyboard shortcuts
- **Detachable Chat** - Chat can open in separate window with state sync
- **Multi-Provider LLM** - Support for OpenAI, DeepSeek, GLM, Anthropic, and custom providers
- **Persistent State** - SQLite-based state persistence across sessions
- **Rust-Backed Services** - High-performance thread persistence and token counting
- **Cross-Platform** - Windows, macOS, and Linux support

---

## Technology Stack

### Frontend
- **React 18.3.1** + **TypeScript** - Component-based UI framework
- **Vite 7.2.4** - Fast build tool and development server
- **Monaco Editor** - Code editing component (same as VS Code)
- **Zustand 5.0.9** - Lightweight state management (18 specialized stores)
- **Tailwind CSS** - Utility-first CSS framework with VS Code-inspired theming
- **react-resizable-panels** - Layout management for resizable panels
- **@xterm/xterm** - Integrated terminal with full ANSI support

### Backend (Rust)
- **Tauri 2.x** - Desktop application framework
- **rusqlite** - SQLite database for state persistence
- **Tokio** - Async runtime
- **Tauri plugins**: fs, shell, dialog, process, os, clipboard-manager, pty

### Key Dependencies
- **@anthropic-ai/sdk** - Anthropic API integration
- **@monaco-editor/react** - Monaco editor React wrapper
- **@tauri-apps/api** - Tauri frontend API
- **date-fns** - Date/time utilities
- **framer-motion** - UI animations
- **lucide-react** - Icon library
- **react-markdown** - Markdown rendering
- **shiki** - Syntax highlighting
- **mermaid** - Diagram rendering

---

## Development

### Prerequisites

- **Node.js** 18+ and **pnpm** package manager
- **Rust** toolchain (latest stable)
- **Tauri CLI**: `pnpm install -g @tauri-apps/cli`

### Installation

```bash
# Clone the repository
git clone https://github.com/Aurora-LABS-Ai/aurora-ide.git
cd aurora

# Install dependencies
pnpm install

# Install Tauri CLI (if not already installed)
pnpm install -g @tauri-apps/cli
```

### Development Commands

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

# Run tests in watch mode
pnpm test:watch

# Generate test coverage report
pnpm test:coverage
```

### Project Structure

```
aurora/
├── .aurora/                  # Application data directory
├── DOCS/                     # Comprehensive project documentation
│   ├── 01-ARCHITECTURE.md    # Architecture overview
│   ├── 02-CODE-STYLE-PATTERNS.md  # Code conventions
│   ├── 03-EXPANSION-GUIDE.md # Development workflow guide
│   └── theme-dev.md          # Theme development guide
├── example-themes/           # Theme examples (20+ themes)
├── models-provider-docs/     # LLM provider documentation
├── public/                   # Static assets
├── src/                      # Frontend source code
│   ├── assets/               # Frontend assets
│   ├── components/           # React components (66 components)
│   │   ├── agent/           # Agent-related components
│   │   ├── chat/            # Chat interface components
│   │   ├── editor/          # Editor components
│   │   ├── explorer/        # File explorer components
│   │   ├── git/             # Git operation components
│   │   ├── layout/          # Layout components
│   │   ├── modals/          # Modal dialogs
│   │   ├── search/          # Search components
│   │   ├── terminal/        # Terminal components
│   │   ├── theme/           # Theme components
│   │   └── ui/              # Reusable UI components
│   ├── hooks/               # Custom React hooks (13 hooks)
│   ├── lib/                 # Utility libraries
│   ├── services/            # Business logic services (25+ services)
│   │   ├── providers/       # LLM provider implementations
│   ├── store/               # Zustand state stores (18 stores)
│   ├── themes/              # Built-in theme definitions
│   ├── tools/               # AI tool definitions and executors
│   │   ├── definitions/     # Tool schemas (8 categories)
│   │   ├── executors/       # Tool implementations
│   │   └── utils/           # Tool utilities
│   ├── types/               # TypeScript type definitions
│   ├── App.tsx              # Main application component
│   └── main.tsx             # Application entry point
├── src-tauri/               # Tauri/Rust backend
│   ├── src/
│   │   ├── commands/        # Tauri command handlers
│   │   ├── db/              # Database layer
│   │   │   ├── repositories/ # Repository pattern implementations
│   │   │   └── ...
│   │   └── lib.rs           # Tauri application setup
│   ├── tauri.conf.json      # Tauri configuration
│   └── Cargo.toml           # Rust dependencies
└── package.json             # Node.js dependencies and scripts
```

---

## Architecture

### State Management (18 Specialized Stores)

Aurora uses a comprehensive Zustand-based state management system with 18 specialized stores:

1. **useSettingsStore** - Global app settings and LLM provider configurations
2. **useChatStore** - Chat messages and tool approval workflow
3. **useThreadStore** - Conversation thread management with Rust-backed persistence
4. **useEditorStore** - Code editor tabs, cursor, scroll, folding state
5. **useWorkspaceStore** - File explorer tree and workspace root
6. **useUiStore** - UI state, modals, panel visibility, theme sync
7. **useThemeStore** - Theme loading, switching, import/export
8. **useGitStore** - Git repository state and operations
9. **useMcpStore** - MCP server management and tool discovery
10. **useCheckpointStore** - Checkpoint creation and restoration
11. **useSemanticStore** - Semantic search and vector operations
12. **useContextStore** - Context building and token usage tracking
13. **useTerminalStore** - Terminal state and command history
14. **useTaskStore** - Task and todo management
15. **useAuditStore** - Audit logging and operation tracking
16. **usePendingChangesStore** - Pending file changes tracking
17. **useUndoRedoStore** - Undo/redo history and state snapshots
18. **useDragStore** - Drag and drop state

### Theming System

Aurora implements a sophisticated VS Code-style theme system with:

- **50+ theme tokens** across 7 categories (editor, sidebar, chat, terminal, status bar, title bar, common)
- **Mandatory theme token usage** - No hardcoded colors or styles allowed
- **Built-in themes** - Dark and light base themes with full token definitions
- **Custom theme support** - Import/export themes with validation
- **Monaco editor integration** - Seamless syntax highlighting
- **Cross-window sync** - Theme changes propagate across all windows

### Database Persistence

SQLite-based state persistence with repository pattern:

**Tables:**
- `workspace_state` - Open tabs, panel sizes per workspace
- `editor_state` - Cursor position, scroll offset, folded regions per file
- `explorer_state` - Expanded folders, selected file per workspace
- `threads` - Chat threads with messages
- `settings` - Key-value settings storage
- `schema_version` - Database version tracking

**Location:**
- Windows: `%APPDATA%\com.aurora.agent\aurora.db`
- macOS: `~/Library/Application Support/com.aurora.agent/aurora.db`
- Linux: `~/.config/com.aurora.agent/aurora.db`

### Tool System (23 Tools)

Aurora's AI assistant can execute 23 tools across 8 categories:

**File Tools:** Read, write, create, delete files and folders
**Shell Tools:** Execute shell commands, spawn background processes
**Workspace Tools:** Navigate workspace, search files, get tree structure
**Editor Tools:** Open files, manage tabs, read lints
**MCP Tools:** Execute MCP server tools and resources
**Git Tools:** Commit, stage, checkout, branch operations
**Semantic Tools:** AI-powered semantic code search
**Agent Tools:** Task management, context operations

### Service Layer (25+ Services)

**Core Services:**
- `agent-service.ts` - AI agent orchestration
- `llm-provider.ts` - LLM provider abstraction
- `database.ts` - Database service
- `theme-service.ts` - Theme validation and management

**Feature Services:**
- `git.ts` - Git operations
- `checkpoint.ts` - Checkpoint/restore operations
- `mcp-tools.ts` - MCP server management
- `semantic.ts` - Semantic search
- `context-builder.ts` - Context building for AI
- `thread-service.ts` - Thread persistence (Rust-backed)
- `token-service.ts` - Token counting (Rust-backed tiktoken)
- `undo-redo.ts` - Undo/redo operations
- `multi-file-service.ts` - Multi-file operations
- `syntax-validator.ts` - Syntax validation

---

## Features Deep Dive

### MCP (Model Context Protocol) Support

Aurora supports the Model Context Protocol for extensible tool integration:

- **Server Management** - Add, remove, connect, disconnect MCP servers
- **Tool Discovery** - Automatic tool discovery from connected servers
- **Tool Execution** - Call MCP tools through unified interface
- **Resource Access** - Access MCP resources (files, databases)
- **Configuration** - JSON-based server configuration

### Git Integration

Full Git operations within the editor:

- **Repository Detection** - Auto-detect Git repositories
- **Branch Management** - List, create, checkout, switch branches
- **Commit Operations** - Stage files, create commits, view diff
- **Remote Operations** - Pull, push to remotes
- **Status Tracking** - Track modified, staged, untracked files
- **Commit History** - View recent commits

### Checkpoint/Restore System

Workspace state snapshots and restoration:

- **Checkpoint Creation** - Automatic checkpoints on user messages
- **Restore Operations** - Restore to any previous checkpoint
- **Workspace Checkpoints** - Per-workspace checkpoint management
- **Thread Association** - Checkpoints linked to specific threads

### Semantic Search

AI-powered code search using embeddings:

- **Vector Search** - Semantic code search using embeddings
- **Context Building** - Build context for AI from workspace
- **Code Understanding** - Understand code structure and relationships
- **Smart Suggestions** - Provide relevant code suggestions

### Undo/Redo System

Full undo/redo support with keyboard shortcuts:

- **State Snapshots** - Capture application state
- **Undo/Redo Stack** - Manage undo/redo history
- **Keyboard Shortcuts** - Ctrl+Z/Ctrl+Shift+Z support

---

## LLM Provider Support

Aurora supports multiple LLM providers with a unified interface:

### Built-in Providers

- **GLM (Z.AI)** - Primary provider with thinking mode support
- **DeepSeek** - Cost-effective alternative with reasoning content
- **OpenAI** - Standard OpenAI API compatibility
- **Anthropic** - Claude API integration

### Custom Providers

- Full support for custom OpenAI-compatible providers
- Custom headers and parameters
- Provider type handling (deepseek, glm, openai, anthropic)
- Context window and max output token configuration

### Thinking Mode

- Provider-specific thinking content handling
- DeepSeek uses `reasoning_content` field
- GLM supports full thinking mode
- Visual thinking indicators in chat

---

## Configuration

### Settings

Aurora stores settings in localStorage with versioning:

- **LLM Provider** - Provider selection, API keys, model configuration
- **Editor Settings** - Font size, font family, tab size, word wrap
- **Tool Approval** - Per-tool approval settings (auto-approve vs manual)
- **Theme** - Theme selection and custom theme management
- **UI Preferences** - Panel layout, chat panel visibility
- **Autosave** - Autosave triggers and interval

### MCP Server Configuration

MCP servers can be configured in the Settings modal:

```json
{
  "name": "Example Server",
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-example"],
  "env": {}
}
```

### Theme Customization

Themes can be imported/exported via the Settings modal:

```json
{
  "name": "My Theme",
  "author": "Your Name",
  "version": "1.0.0",
  "type": "dark",
  "description": "My custom theme",
  "colors": {
    "editor": {
      "background": "#0d0d0d",
      "foreground": "#e4e4e7"
    },
    "sidebar": {
      "background": "#111111",
      "foreground": "#a1a1aa"
    },
    "common": {
      "primary": "#10b981",
      "error": "#ef4444"
    }
  },
  "tokenColors": [
    {
      "scope": "comment",
      "settings": { "foreground": "#6A9955" }
    }
  ]
}
```

---

## Documentation

For comprehensive documentation, see the `DOCS/` directory:

- **[01-ARCHITECTURE.md](DOCS/01-ARCHITECTURE.md)** - Detailed architecture overview
- **[02-CODE-STYLE-PATTERNS.md](DOCS/02-CODE-STYLE-PATTERNS.md)** - Code conventions
- **[03-EXPANSION-GUIDE.md](DOCS/03-EXPANSION-GUIDE.md)** - Development workflow guide
- **[theme-dev.md](DOCS/theme-dev.md)** - Theme development guide

---

## Contributing

Contributions are welcome! Please read the [EXPANSION GUIDE](DOCS/03-EXPANSION-GUIDE.md) for details on:

- Getting started and environment setup
- Adding new features, components, and modules
- Code style patterns and theming rules
- Testing procedures and requirements
- Build and deployment processes

### Code Style Guidelines

- **Naming Conventions**: camelCase for variables/functions, PascalCase for components/types
- **Theme Tokens**: All components must use theme tokens (no hardcoded colors/styles)
- **State Management**: Always update via Zustand store actions
- **Error Handling**: Proper error handling with user-friendly messages
- **Testing**: Write tests for new features

---

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

---

## Acknowledgments

- **Tauri** - Desktop application framework
- **Monaco Editor** - Code editing component by Microsoft
- **React** - UI framework
- **Zustand** - State management
- **Tailwind CSS** - Styling

---

<div align="center">

**Built with ❤️ by the Aurora Team**

[Website](https://aurora.dev) • [Documentation](DOCS/) • [Issues](https://github.com/Aurora-LABS-Ai/aurora-ide/issues)

</div>
