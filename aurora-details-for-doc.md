# Aurora Code Editor - Complete Feature Documentation

## Product Overview

Aurora is a modern, AI-powered agentic code editor that combines the familiar interface of VS Code with an integrated AI assistant capable of executing tools to manipulate files, run commands, navigate workspaces, and perform semantic code search. Built with Tauri (Rust backend + React frontend), Aurora provides a seamless development experience with advanced AI capabilities.

## Core Features

### 🎯 AI Assistant & Tool Execution
- **Conversational AI Interface**: Chat with AI assistant that understands natural language
- **Tool Execution**: AI can execute up to 25 tool iterations per request
- **Streaming Responses**: Real-time streaming of AI responses with thinking visualization
- **Context Awareness**: Intelligent context gathering from open files, workspace structure, and project rules
- **Multi-Modal Input**: Support for file attachments (@filename syntax) and contextual information

### 📝 Advanced Code Editor
- **Monaco Editor Integration**: Professional code editing with syntax highlighting
- **Multi-Tab Interface**: Support for multiple open files with tab management
- **Auto-Save Options**: Configurable auto-save (off, after delay, on focus change, on window change)
- **Font Size Control**: Adjustable font sizes (12px, 14px, 16px, 18px)
- **Line Wrapping**: Configurable word wrapping in editors and previews
- **Syntax Validation**: Real-time TypeScript/JavaScript error detection

### 🔍 Intelligent Search & Discovery

#### Semantic Code Search
- **AI-Powered Search**: Uses Jina Code 1.5B embeddings for semantic understanding
- **Multiple Search Modes**:
  - **Hybrid**: Combines lexical (keywords) + semantic (meaning) - recommended
  - **Lexical**: Fast keyword-based search
  - **Semantic**: Pure AI embedding search for conceptual queries
- **Advanced Filtering**:
  - **Languages**: Filter by programming language (rust, python, typescript, javascript, go, java, c, cpp)
  - **Code Types**: Filter by structure (function, class, struct, enum, interface, module, imports, constant, typedef, implementation, block, comment)
  - **Path Patterns**: Glob patterns for file filtering (e.g., `**/src/**`, `*.ts`)
  - **Symbol Names**: Filter by function/class names (partial match, case-insensitive)
  - **Directory Scoping**: Search within or exclude specific directories
- **GPU Acceleration**: Support for CUDA, DirectML, and CoreML acceleration
- **Per-Workspace Indexing**: Separate semantic indexes for each workspace with custom exclusions

#### Traditional Search
- **File Name Search**: Fuzzy search through workspace files
- **Content Search**: Full-text search with regex support
- **Case Sensitivity**: Optional case-sensitive matching
- **Result Highlighting**: Visual highlighting of search matches

### 🖥️ Integrated Terminal
- **PTY-Based Terminal**: Native pseudoterminal support with persistent sessions
- **Multiple Shell Profiles**:
  - **PowerShell** (Windows)
  - **Bash** (Linux/macOS)
  - **Command Prompt** (Windows fallback)
- **Session Management**: Multiple terminal sessions with independent processes
- **Background Process Support**: Long-running processes (dev servers, watch tasks)
- **Process Monitoring**: List, kill, and manage background processes

### 📁 Advanced File Management

#### File Operations
- **Full CRUD Operations**: Create, read, write, patch, delete files
- **Batch Operations**: Multi-file read operations (10-100x faster)
- **Smart Content Limiting**: Intelligent file content truncation for large files
- **Search & Replace**: Exact string replacement with context awareness
- **Directory Operations**: Create/delete folders recursively

#### Workspace Navigation
- **Tree View**: Hierarchical file explorer with expand/collapse
- **Drag & Drop**: File and folder drag-drop operations
- **Context Menus**: Right-click menus with relevant actions
- **Hidden File Support**: Optional display of hidden files and directories
- **File Filtering**: Real-time filtering of workspace contents

### 🔧 Development Workflow Tools

#### Git Integration
- **Repository Management**: Initialize, status tracking, commit operations
- **Staging Control**: Stage/unstage individual files or all changes
- **Branch Operations**: Branch switching, pull, push operations
- **Change Visualization**: Visual diff display with staged/unstaged categorization
- **Conflict Resolution**: Visual indicators for merge conflicts

#### Task Management
- **AI-Generated Task Lists**: AI creates structured task lists for complex operations
- **Progress Tracking**: Visual progress indicators with completion states
- **Task States**: Pending, in-progress, completed, cancelled
- **Smart Completion**: Automatic task completion detection
- **Compact Display**: Space-efficient task list with animated transitions

### 🌐 LLM Provider Support

#### Built-in Providers
- **OpenAI**: GPT-4, GPT-3.5 Turbo, o1 models
- **Anthropic**: Claude 3.5 Sonnet, Claude 3 Opus/Haiku
- **DeepSeek**: DeepSeek Chat and Reasoner models
- **GLM**: GLM-4.7, GLM-4.6 with Preserved Thinking
- **MiniMax**: M2.1 model with Anthropic-compatible API
- **LM Studio**: Local Ollama/LM Studio integration with reasoning support

#### Advanced Provider Features
- **Thinking Mode**: Native reasoning/thinking display for compatible models
- **Custom Providers**: Add any OpenAI/Anthropic-compatible API
- **Provider-Specific Tuning**: Model-specific parameter handling
- **Context Window Management**: Automatic context overflow handling
- **Token Estimation**: Character-based token counting with usage tracking
- **Auto-Temperature Adjustment**: Automatic temperature skipping for reasoning models

### 🔌 MCP (Model Context Protocol) Integration
- **Server Management**: Connect to MCP servers via stdio or SSE
- **Dynamic Tool Discovery**: Automatic tool discovery from connected servers
- **Tool Execution**: Seamless execution of MCP-provided tools
- **Auto-Approval**: Configurable auto-approval for trusted MCP tools
- **Server Lifecycle**: Auto-start, manual start/stop of MCP servers

### 🎨 Theme & Customization

#### Built-in Themes
- **Dark Theme**: Professional dark theme with VS Code-inspired colors
- **Light Theme**: Clean light theme for extended coding sessions
- **High Contrast**: Accessibility-focused high contrast theme
- **Custom Themes**: Import and manage custom VS Code themes

#### Theme Architecture
- **CSS Variables**: Centralized theme system using CSS custom properties
- **Component Categories**: editor, sidebar, chat, terminal, statusBar, titleBar, common
- **Theme Import**: Support for VS Code theme format (.json)
- **Live Preview**: Real-time theme switching and preview

### 🔒 Security & Audit

#### Tool Approval System
- **Risk-Based Approval**: Tools categorized by risk level (safe, medium, dangerous)
- **Per-Tool Settings**: Individual approval modes (auto, always ask, deny)
- **Batch Approval**: Approve multiple tool calls at once
- **Context-Aware Prompts**: Detailed prompts showing tool parameters and effects

#### Audit Timeline
- **Execution Logging**: Complete log of all tool executions
- **Visual Timeline**: Chronological display with status indicators
- **Performance Metrics**: Execution time and success/failure tracking
- **Error Details**: Detailed error information for failed operations
- **Search & Filter**: Filter audit logs by tool type, status, time range

### 💾 Data Persistence & State Management

#### Database Storage
- **SQLite Backend**: Robust local database for all application state
- **Schema Versioning**: Automatic migration system (current: v8)
- **Cross-Platform**: Consistent storage across Windows, macOS, Linux

#### State Management (Zustand)
- **13 Specialized Stores**:
  - `useSettingsStore`: Global settings, LLM providers, tool configurations
  - `useChatStore`: Chat messages, loading states, approval workflows
  - `useThreadStore`: Conversation thread management with token usage
  - `useEditorStore`: Monaco editor tabs, active tab, file caching
  - `useWorkspaceStore`: File explorer, root path, file tree, watchers
  - `useUiStore`: Theme, modal states, chat panel visibility
  - `useDragStore`: Drag-drop operation state
  - `useTaskStore`: Task/todo list management
  - `useTerminalStore`: Terminal sessions and configurations
  - `useContextStore`: Context window usage tracking
  - `useAuditStore`: Tool execution audit logging
  - `useSemanticStore`: Semantic search settings and indexes
  - `useThemeStore`: Custom theme management and import
  - `usePendingChangesStore`: Pending file changes before approval

### 🏗️ Architecture & Performance

#### Technology Stack
- **Frontend**: React 18.3.1 + TypeScript, Vite 7.2.4, Monaco Editor
- **Backend**: Tauri 2.x with Rust, SQLite database
- **UI Framework**: Tailwind CSS with custom theme system
- **State Management**: Zustand for predictable state updates
- **Terminal**: xterm.js with native PTY support

#### Performance Optimizations
- **Lazy Loading**: Components loaded on demand
- **Memoization**: React.memo and useMemo for expensive operations
- **Virtualization**: Efficient rendering for large file trees
- **Background Processing**: Non-blocking operations with progress tracking
- **Memory Management**: Proper cleanup of resources and event listeners

#### Context Management
- **Intelligent Context Building**: Cursor-style structured context gathering
- **Token Estimation**: Real-time token usage tracking
- **Context Overflow Handling**: Automatic truncation when approaching limits
- **Usage Analytics**: Detailed token consumption reporting

### 🔧 Developer Experience Features

#### Keyboard Shortcuts
- **Global Shortcuts**: Cmd/Ctrl+B for sidebar toggle
- **Editor Shortcuts**: Standard Monaco editor shortcuts
- **Custom Shortcuts**: Configurable keybindings for common operations

#### Window Management
- **Detachable Chat**: Chat panel can be detached to separate window
- **Window State Sync**: State synchronization across windows
- **Cross-Window Communication**: Seamless data sharing between main and detached windows

#### File Watching
- **Real-time Updates**: Automatic file system change detection
- **Efficient Watching**: Minimal resource usage with smart filtering
- **Change Notifications**: Visual indicators for file modifications

### 📊 Monitoring & Diagnostics

#### System Information
- **OS Detection**: Platform-specific behavior adaptation
- **System Resources**: Memory and CPU usage monitoring
- **Performance Metrics**: Operation timing and resource consumption

#### Error Handling
- **Graceful Degradation**: Fallback behavior for failed operations
- **Detailed Error Messages**: Comprehensive error reporting
- **Recovery Mechanisms**: Automatic retry for transient failures

#### Debug Tools
- **Console Logging**: Structured logging with severity levels
- **Performance Profiling**: Built-in performance monitoring
- **State Inspection**: Development tools for state debugging

### 🚀 Advanced Features

#### Multi-Platform Support
- **Windows**: PowerShell integration, native file operations
- **macOS**: Bash integration, native system APIs
- **Linux**: Bash integration, full system compatibility

#### Extensibility
- **Plugin Architecture**: MCP protocol for third-party extensions
- **Custom Tools**: Framework for adding new AI tools
- **Theme System**: Easy theme creation and sharing
- **Provider Extensions**: Support for new LLM providers

#### Collaboration Features
- **Thread Management**: Conversation threads with persistence
- **Context Sharing**: Share workspace context with AI
- **Session Continuity**: Resume conversations across sessions

---

## Tool Categories & Capabilities

### File Tools
- `file_create`: Create new files with optional initial content
- `file_read`: Read entire file content
- `file_write`: Completely replace file content
- `search_replace`: Exact string replacement with context validation
- `file_delete`: Delete files permanently
- `grep`: Regex search across codebase with advanced filtering
- `multi_file_read`: Parallel reading of multiple files (up to 10x faster)

### Shell Tools
- `shell_execute`: Run shell commands with timeout and output capture
- `shell_spawn`: Start background processes (dev servers, watchers)
- `shell_kill`: Terminate running background processes
- `shell_list_processes`: Monitor all active background processes

### Workspace Tools
- `workspace_tree`: Generate hierarchical directory structure
- `folder_create`: Create directories recursively
- `folder_delete`: Remove directories and contents

### Editor Tools
- `editor_open_file`: Open files in editor with optional line navigation
- `read_lints`: Display Monaco editor diagnostics and errors

### Search Tools
- `aurora_search`: AI-powered semantic code search with advanced filtering

### Task Tools
- `todo_write`: Create and manage structured task lists for complex operations

---

## Configuration Options

### Provider Configuration
- **Base URL**: Custom API endpoints
- **API Keys**: Secure key management with visibility toggles
- **Context Windows**: Model-specific context limits (up to 200k tokens)
- **Max Output Tokens**: Response length control
- **Thinking Mode**: Enable/disable reasoning display
- **Custom Models**: Add multiple models per provider

### Semantic Search Settings
- **Model Selection**: Choose embedding model (Jina Code 1.5B recommended)
- **Search Mode**: Hybrid, lexical, or semantic modes
- **Weight Tuning**: Adjustable lexical vs semantic weight balance
- **GPU Acceleration**: Enable CUDA/DirectML/CoreML acceleration
- **Workspace Exclusions**: Per-workspace file/directory exclusions
- **Global Filters**: Language, path pattern, and content type filters

### Tool Settings
- **Risk Levels**: Safe, medium, dangerous categorization
- **Approval Modes**: Auto-approve, always ask, deny per tool
- **Batch Operations**: Approve multiple tools simultaneously
- **Custom Approvals**: MCP server-specific approval settings

### Appearance Settings
- **Theme Selection**: Built-in and custom theme support
- **Font Size**: 12px to 18px adjustable sizing
- **UI Layout**: Customizable panel sizes and layouts
- **Color Customization**: Full theme token system

### General Settings
- **Auto-Save**: Configurable save triggers
- **Line Wrapping**: Editor and preview wrapping control
- **Startup Behavior**: Workspace restoration and initialization

---

## MCP Server Integration

### Supported Protocols
- **stdio**: Standard input/output communication
- **SSE (Server-Sent Events)**: HTTP-based streaming communication

### Server Management
- **Auto-Start**: Automatic server startup with Aurora
- **Manual Control**: Start/stop servers on demand
- **Environment Variables**: Custom environment configuration
- **Argument Passing**: Flexible command-line argument support

### Tool Integration
- **Dynamic Discovery**: Automatic tool registration from servers
- **Type Safety**: Full TypeScript integration for MCP tools
- **Error Handling**: Robust error recovery for MCP operations
- **Performance Monitoring**: Execution timing and success tracking

---

## Performance Characteristics

### Search Performance
- **Semantic Indexing**: Per-workspace with incremental updates
- **Query Speed**: Sub-second responses for typical queries
- **GPU Acceleration**: 3-5x speedup on supported hardware
- **Memory Efficiency**: Optimized for large codebases

### Editor Performance
- **Large File Handling**: Efficient rendering of files up to 10MB+
- **Multi-Tab Support**: Smooth switching between dozens of tabs
- **Real-time Validation**: Non-blocking syntax checking
- **Memory Management**: Automatic cleanup of unused resources

### Terminal Performance
- **PTY Efficiency**: Native pseudoterminal performance
- **Session Persistence**: Zero overhead for background sessions
- **Process Monitoring**: Lightweight process tracking
- **Resource Optimization**: Minimal memory footprint

---

## Security Model

### Tool Execution Security
- **Approval Gates**: All dangerous operations require explicit approval
- **Context Validation**: Parameter validation before execution
- **Operation Limits**: Built-in safeguards against destructive operations
- **Audit Trail**: Complete logging of all operations

### Data Protection
- **Local Storage**: All data stored locally, no cloud dependencies
- **API Key Security**: Encrypted storage with visibility controls
- **Workspace Isolation**: Per-workspace data segregation
- **Clean Uninstall**: Complete data removal on uninstallation

---

## Development Roadmap

### Planned Features
- **Collaborative Editing**: Real-time collaborative coding sessions
- **Plugin Marketplace**: Community plugin ecosystem
- **Advanced AI Features**: Code generation, refactoring suggestions
- **Integration APIs**: REST APIs for third-party integrations
- **Mobile Support**: iOS/Android companion apps

### Technical Improvements
- **Performance Optimization**: Further speed improvements for large projects
- **Memory Optimization**: Reduced memory usage for extended sessions
- **Accessibility**: Enhanced screen reader and keyboard navigation support
- **Internationalization**: Multi-language interface support

---

This comprehensive documentation covers all major features and capabilities of the Aurora code editor. Each feature is designed to enhance the development workflow while maintaining the familiar VS Code-like interface that developers expect.
