# Architecture Overview

## Project Overview

**Aurora** is an AI-powered agentic code editor built with Tauri, providing a VS Code-like interface with an integrated AI assistant that can execute tools to manipulate files, run commands, and navigate workspaces.

The application combines a modern React frontend with a Rust backend, offering a desktop-native experience with web technologies.

## Tech Stack

### Frontend
- **React 18.3.1** + **TypeScript** - Component-based UI framework
- **Vite 7.2.4** - Fast build tool and development server
- **Monaco Editor** - Code editing component (same as VS Code)
- **Zustand 5.0.9** - Lightweight state management
- **Tailwind CSS** - Utility-first CSS framework with VS Code-inspired theming
- **react-resizable-panels** - Layout management for resizable panels

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
- **react-syntax-highlighter** - Code syntax highlighting
- **uuid** - Unique identifier generation

## Theming Architecture

### Comprehensive Theme System Overview
Aurora implements a sophisticated VS Code-style theme system that enforces theme token usage across all components. **All components must use theme tokens - hardcoded colors, styles, or Tailwind classes are strictly prohibited.** The system supports 50+ color tokens across 7 categories with full runtime theme switching, Monaco editor integration, and cross-window synchronization.

### Theme Token Categories (7 Categories, 50+ Tokens)

#### 1. Editor Tokens (`editor.*`)
Code editing area colors including background, foreground, syntax highlighting, selection, cursor, line numbers, and advanced features like bracket matching and find highlighting.

#### 2. Sidebar Tokens (`sidebar.*`)
File explorer and panel colors including background, foreground, borders, hover states, selection, and section headers.

#### 3. Chat Tokens (`chat.*`)
Chat interface colors for user/assistant messages, input fields, thinking states, tool calls, and code blocks.

#### 4. Terminal Tokens (`terminal.*`)
Integrated terminal colors including ANSI color palette (16 standard + 16 bright colors) and terminal-specific UI elements.

#### 5. Status Bar Tokens (`statusBar.*`)
Bottom status bar colors for background, foreground, borders, and interactive elements.

#### 6. Title Bar Tokens (`titleBar.*`)
Window title bar colors including background, foreground, borders, and button hover states.

#### 7. Common Tokens (`common.*`)
Shared semantic colors for primary, secondary, success, warning, error, info, borders, shadows, overlays, and scrollbars.

### Theme File Structure
Themes are defined as JSON files with comprehensive validation and partial definition support:

```json
{
  "name": "Aurora Dark",
  "author": "Aurora Team",
  "version": "1.0.0",
  "type": "dark",
  "description": "Default dark theme",
  "colors": {
    "editor": {
      "background": "#0d0d0d",
      "foreground": "#e4e4e7",
      "cursor": "#10b981"
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
    },
    {
      "scope": ["keyword", "storage"],
      "settings": { "foreground": "#569CD6", "fontStyle": "bold" }
    }
  ]
}
```

### Theme Service (`src/services/theme-service.ts`)
A comprehensive singleton service handling:

#### Validation Engine
- **Color validation**: Supports hex (#RGB, #RRGGBB, #RGBA, #RRGGBBAA), rgb(), rgba() formats
- **Theme file validation**: Required metadata fields, color format validation, semantic versioning
- **Token color rule validation**: TextMate scope validation and color format checking

#### Base Theme System
- **Built-in dark/light themes** with complete 50+ token definitions
- **Partial theme support**: Theme files can define only changed tokens, falling back to base themes
- **Deep merging**: Recursive merging of partial theme definitions with base themes

#### CSS Variable Injection
- **CSS variable generation**: Converts tokens to `--aurora-{category}-{token}` format
- **Runtime injection**: Dynamically updates document root CSS variables
- **CamelCase to kebab-case conversion**: `primaryHover` → `--aurora-common-primary-hover`

#### Monaco Editor Integration
- **Theme conversion**: Transforms Aurora themes to Monaco editor theme format
- **Syntax highlighting**: Applies token color rules for code colorization
- **Theme registration**: Registers themes with Monaco for immediate application

### Theme Store (`src/store/useThemeStore.ts`)
Zustand-based state management for theme operations:

#### Theme Management
- **Theme loading**: Initializes built-in and custom themes from database
- **Theme switching**: Runtime theme changes with CSS variable injection
- **Theme import/export**: JSON theme file handling with validation
- **Theme persistence**: SQLite database storage for custom themes

#### Cross-Window Synchronization
- **localStorage sync**: Fast theme switching across open windows
- **Database persistence**: Settings storage for theme preferences
- **Storage event listeners**: Automatic theme updates when other windows change themes

### Critical Rules for Component Development
❌ **NEVER use hardcoded colors or styles:**
```typescript
// FORBIDDEN - Hardcoded values
<div style={{ backgroundColor: '#1e1e1e', color: '#ffffff' }} />
<div className="bg-gray-800 text-white hover:bg-gray-700" />
const styles = { container: { background: '#252526' } };
```

✅ **ALWAYS use theme tokens via CSS variables:**
```typescript
// CORRECT - CSS variable usage (recommended)
<div className="bg-[var(--aurora-editor-background)] text-[var(--aurora-editor-foreground)]" />

// CORRECT - JavaScript access
import { useTheme } from '../hooks/useTheme';
const theme = useTheme();
<div style={{
  backgroundColor: theme.colors.editor.background,
  color: theme.colors.editor.foreground
}} />
```

### Theme Hook (`src/hooks/useTheme.ts`)
```typescript
export function useTheme() {
  const activeTheme = useThemeStore(state => state.getActiveTheme());
  return {
    colors: activeTheme.colors,
    tokenColors: activeTheme.tokenColors,
    // Helper methods for common patterns
    getEditorTokens: () => activeTheme.colors.editor,
    getCommonTokens: () => activeTheme.colors.common,
  };
}
```

### Theme Persistence Architecture
- **SQLite database**: Custom themes stored with JSON serialization
- **Built-in themes**: Hardcoded in theme service, always available
- **Theme versioning**: Semantic versioning support for compatibility
- **Duplicate handling**: Name/author-based theme updates instead of creation

### Theme Development Workflow
1. **Define theme JSON** with required metadata and partial color definitions
2. **Validate theme** using theme service validation (automatic in import)
3. **Test theme** via Settings → Appearance → Import Theme
4. **Verify components** render correctly across all UI elements
5. **Check accessibility** with multiple contrast ratios
6. **Document token usage** for any new color categories

### Runtime Theme Application
When a theme is applied:
1. **CSS variables injected** into document root (`:root`)
2. **Monaco theme registered** and applied to all editors
3. **Data attributes set** for CSS selector targeting (`data-theme`, `data-theme-id`)
4. **Tailwind compatibility** via `.dark` class toggle
5. **Cross-window sync** via localStorage events

### Theme Testing Requirements
- **Multi-theme testing**: Validate with dark, light, and custom themes
- **Component isolation**: Test components independently with theme switching
- **Accessibility validation**: Ensure sufficient contrast ratios
- **Cross-window sync**: Verify theme changes propagate correctly
- **Performance testing**: Theme switching should be instantaneous

## Directory Structure

```
aurora-agent-frontend/
├── .aurora/              # Application data directory
├── DOCS/                 # Project documentation
├── dist/                 # Build output
├── example-themes/       # Theme examples
├── models-provider-docs/ # LLM provider documentation
├── node_modules/         # Dependencies
├── public/               # Static assets
├── src/                  # Frontend source code
│   ├── assets/           # Frontend assets
│   ├── components/       # React components
│   ├── hooks/            # Custom React hooks
│   ├── lib/              # Utility libraries
│   ├── services/         # Business logic services
│   ├── store/            # Zustand state stores
│   ├── themes/           # Theme definitions
│   ├── tools/            # AI tool definitions and executors
│   ├── types/            # TypeScript type definitions
│   ├── App.tsx           # Main application component
│   └── main.tsx          # Application entry point
├── src-tauri/            # Tauri/Rust backend
│   ├── src/
│   │   ├── commands/     # Tauri command handlers
│   │   ├── db/           # Database layer
│   │   └── lib.rs        # Tauri application setup
│   ├── tauri.conf.json   # Tauri configuration
│   └── Cargo.toml        # Rust dependencies
└── package.json          # Node.js dependencies and scripts
```

## Core Components

### Frontend Architecture

#### State Management (Zustand Stores)
The application uses six specialized Zustand stores located in `src/store/`:

1. **useSettingsStore** (`src/store/useSettingsStore.ts`)
   - Global app settings and LLM provider configurations
   - Persists to localStorage with versioning
   - Manages provider selection, tool approval settings, editor preferences

2. **useChatStore** (`src/store/useChatStore.ts`)
   - Chat messages and loading states
   - Tool approval workflow state management

3. **useThreadStore** (`src/store/useThreadStore.ts`)
   - Conversation thread management and persistence
   - Auto-saves threads to `.aurora/threads/{threadId}.json`

4. **useEditorStore** (`src/store/useEditorStore.ts`)
   - Code editor tabs and file content management
   - Cursor position, scroll offset, and folding state tracking

5. **useWorkspaceStore** (`src/store/useWorkspaceStore.ts`)
   - File explorer tree structure and navigation
   - Workspace root path management

6. **useUiStore** (`src/store/useUiStore.ts`)
   - UI state management (themes, modals, panel visibility)
   - Detached chat window state synchronization

#### Component Architecture
Located in `src/components/`:

- **layout/MainLayout.tsx** - Three-panel layout (Explorer | Editor | Chat)
- **ChatPanel** - Chat interface with message history and input
- **EditorPanel** - Monaco editor with tab management
- **FileExplorer** - File tree with expand/collapse functionality

### Backend Architecture (Rust/Tauri)

#### Database Persistence System
Located in `src-tauri/src/db/`:

```
db/
├── mod.rs              # Database manager and repository access
├── connection.rs       # SQLite connection with WAL mode and performance tuning
├── error.rs            # DbError enum for error handling
├── schema.rs           # Table definitions and schema versioning
├── migrations.rs       # Version-based migration system
├── models.rs           # Rust structs for data models
└── repositories/       # Repository pattern implementation
    ├── workspace.rs    # WorkspaceRepository (CRUD for workspace state)
    ├── editor.rs       # EditorRepository (CRUD for editor state per file)
    └── explorer.rs     # ExplorerRepository (CRUD for file explorer state)
```

**Database Tables:**
- `workspace_state` - Open tabs, panel sizes per workspace
- `editor_state` - Cursor position, scroll offset, folded regions per file
- `explorer_state` - Expanded folders, selected file per workspace
- `threads` - Chat threads with messages (future use)
- `settings` - Key-value settings storage
- `schema_version` - Database version tracking

**Database Location:**
- Windows: `%APPDATA%\com.aurora.agent\aurora.db`
- macOS: `~/Library/Application Support/com.aurora.agent/aurora.db`
- Linux: `~/.config/com.aurora.agent/aurora.db`

#### Tauri Commands
Located in `src-tauri/src/commands/`:

**File System Commands** (`commands/mod.rs`):
- `read_directory` - List directory contents (filters node_modules, target, dist)
- `read_file_content` - Read file to string
- `write_file_content` - Write string to file (creates parent directories)
- `execute_command` - Execute shell command
- `create_file` / `create_folder` / `delete_path` / `rename_path`

**State Persistence Commands** (`commands/state.rs`):
- `save_workspace_state` / `get_workspace_state`
- `save_editor_state` / `get_editor_state`
- `save_explorer_state` / `get_explorer_state`

### Tool System Architecture

Located in `src/tools/`:

#### Tool Definitions (`definitions/`)
- `file-tools.ts` - File operations (read, write, create, delete)
- `shell-tools.ts` - Shell command execution
- `workspace-tools.ts` - Workspace navigation and search
- `editor-tools.ts` - Editor operations (open files, tabs)

#### Tool Executors (`executors/`)
- Each tool has a risk level: low (auto-approve), medium/high (requires approval)
- Tools are executed via Tauri commands

#### Tool Registry (`registry.ts`)
- Central tool registry and management
- Tool discovery and validation

### LLM Provider System

#### Service Layer (`src/services/llm-provider.ts`)
- Singleton pattern for provider instance management
- Supports multiple providers: OpenAI, DeepSeek, GLM, Anthropic, custom
- Provider-specific handling for different APIs
- Streaming SSE (Server-Sent Events) implementation

#### Agent Service (`src/services/agent-service.ts`)
- Orchestrates AI conversation with tool execution
- Conversation loop: LLM → Tool Calls → Execution → Response
- Max 25 tool iterations per request
- Tool approval workflow integration

## Data Flow

```
User Action → Component Event Handler → Zustand Store Action → Tauri Command → Rust Backend → Result → Store Update → Component Re-render
```

### Application Flow Examples

1. **File Opening:**
   ```
   FileExplorer Click → useWorkspaceStore.openFile → Tauri read_file_content → File Content → useEditorStore.addTab → EditorPanel Update
   ```

2. **AI Tool Execution:**
   ```
   Chat Input → AgentService.processMessage → LLM API Call → Tool Calls → Tool Approval Modal → Tauri Command → Tool Result → Chat Update
   ```

3. **Settings Change:**
   ```
   Settings Modal → useSettingsStore.updateProvider → DatabaseService.save → SQLite Update → UI Re-render
   ```

## External Dependencies and Integrations

### LLM Providers
- **GLM (Z.AI)** - Primary provider with thinking mode support
- **DeepSeek** - Cost-effective alternative with reasoning content
- **OpenAI** - Standard OpenAI API compatibility
- **Anthropic** - Claude API integration
- **Custom Providers** - Extensible provider system

### Third-Party Services
- **SQLite** - Local state persistence
- **Monaco Editor** - Code editing engine
- **Tauri Plugins** - Desktop integration (file system, shell, dialogs)

## Entry Points

### Frontend
- **Main Application**: `src/main.tsx` → `src/App.tsx` → `MainLayout`
- **Detached Chat Window**: `/chat-detached` route → `DetachedChatWindow`

### Backend
- **Tauri Application**: `src-tauri/src/lib.rs` → Tauri app setup with plugins
- **Database Initialization**: SQLite database setup and migration on app start

## Unique Features

1. **Detachable Chat Window** - Chat can open in separate Tauri window with cross-window state sync
2. **Timeline Event System** - Sequential tracking of AI response components for granular display
3. **Multi-Provider LLM Support** - Preset + custom providers with explicit provider type handling
4. **Thinking Mode** - Provider-specific thinking content handling
5. **VS Code-Inspired Design** - Color hierarchy and familiar interface patterns
6. **Tool Approval System** - Granular control over AI tool execution with per-tool settings
