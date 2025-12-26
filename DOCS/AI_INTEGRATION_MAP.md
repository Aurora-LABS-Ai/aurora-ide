# Aurora AI Integration Architecture Map

## Overview
This document maps the entire AI integration system from prompt to execution in the Aurora Agent Frontend. The system follows a layered architecture with clear separation of concerns between UI, orchestration, tool execution, and native system integration.

## Architecture Layers

### 1. User Interface Layer
**Location**: `src/components/chat/`
**Components**:
- `ChatPanel.tsx` - Main conversational interface
- `ChatInput.tsx` - User input handling
- `ChatHistory.tsx` - Message display
- `ChatMessage.tsx` - Individual message rendering
- `ToolApprovalBanner.tsx` - Tool execution approval UI

**Responsibilities**:
- Capture user prompts
- Display streaming responses and thinking traces
- Handle tool approval workflows
- Manage conversation threads

### 2. State Management Layer
**Location**: `src/store/`
**Stores**:
- `useChatStore.ts` - Chat state and loading status
- `useThreadStore.ts` - Conversation thread persistence
- `useSettingsStore.ts` - LLM provider and tool configuration
- `useWorkspaceStore.ts` - Workspace and file system state
- `useEditorStore.ts` - Editor tab and layout state

**Responsibilities**:
- Centralized state management via Zustand
- Persistence through database service
- Cross-window state synchronization
- Configuration management

### 3. Service Orchestration Layer
**Location**: `src/services/`

#### Agent Service (`agent-service.ts`)
**Core orchestration engine** that manages:
- Conversation loop with LLM
- Tool execution workflow
- Thinking mode handling
- Iterative tool calling (up to 25 iterations)
- Error handling and recovery

**Key Methods**:
- `chat()` - Main conversation loop
- `updateConfig()` - Runtime configuration
- `stop()` - Request cancellation

#### LLM Provider (`llm-provider.ts`)
**Communication layer** for OpenAI-compatible APIs:
- Streaming chat completion via SSE
- Provider-specific optimizations (DeepSeek, GLM, generic)
- Thinking mode support
- Tool calling capabilities
- Request/response transformation

**Supported Providers**:
- DeepSeek (with thinking/reasoning models)
- GLM/Z.AI
- Generic OpenAI-compatible endpoints

### 4. Tool System Layer
**Location**: `src/tools/`

#### Tool Definitions (`definitions/`)
JSON schemas for AI model consumption:
- `file-tools.ts` - File operations (read, write, create, delete)
- `editor-tools.ts` - Editor interactions (tabs, selection)
- `shell-tools.ts` - Command execution
- `workspace-tools.ts` - Workspace management
- Each tool includes risk level assessment

#### Tool Registry (`registry.ts`)
**Central tool management**:
- Tool registration and discovery
- Risk-based approval requirements
- Execution tracking and monitoring
- Error handling and result formatting

#### Tool Executors (`executors/`)
**Implementation layer** that bridges to Tauri:
- `file-executors.ts` - File system operations
- `shell-executors.ts` - Command execution
- `workspace-executors.ts` - Workspace management
- `editor-executors.ts` - Editor interactions

### 5. Native Integration Layer
**Location**: `src-tauri/src/`

#### Rust Commands (`commands/mod.rs`)
**System-level operations**:
- File system access (read, write, delete, create)
- Shell command execution (PowerShell/Bash)
- Directory traversal and workspace management
- System information retrieval

#### Database Layer (`db/`)
**Persistence engine**:
- SQLite via rusqlite
- Workspace state storage
- Settings and provider configuration
- Thread history and message persistence
- Tool approval settings

#### Tauri Bridge (`lib/tauri.ts`)
**TypeScript wrappers** for Rust commands:
- File system operations
- Shell command execution
- Database access
- System integration

## Request Flow: From Prompt to Execution

### 1. User Input Capture
```
ChatInput.handleSend() → ChatPanel.handleSend()
```

### 2. State Preparation
```
useThreadStore.createThread() → addMessageToThread()
```

### 3. LLM Provider Initialization
```
getLLMConfig() → initLLMProvider() → LLMProvider constructor
```

### 4. Agent Service Configuration
```
getAgentService() → updateConfig() → AgentService.chat()
```

### 5. LLM Request Construction
```
AgentService.chat() → LLMProvider.streamChatCompletion()
```

### 6. Streaming Response Processing
```
LLMProvider.processStream() → Stream callbacks:
- onToken() → Content streaming
- onThinking() → Thinking traces
- onToolCall() → Tool execution requests
```

### 7. Tool Execution Workflow
```
onToolCall() → toolRegistry.executeToolCall() → Tool Executor → Tauri Command
```

### 8. Approval Flow (if required)
```
toolRegistry.requiresApproval() → onToolApprovalRequired() → ToolApprovalBanner
```

### 9. Result Integration
```
Tool result → messages array → next LLM iteration → final response
```

## Tool System Architecture

### Tool Categories and Risk Levels

#### Low Risk (Auto-approved)
- File reading operations
- Directory listing
- System information retrieval

#### Medium Risk (User approval configurable)
- File writing/creation
- Non-destructive shell commands
- Workspace operations

#### High Risk (Always requires approval)
- File deletion operations
- Destructive shell commands
- System-level modifications

### Tool Execution Pipeline

1. **Tool Call Reception**
   - Parse from LLM response
   - Validate JSON arguments
   - Create tracking record

2. **Approval Check**
   - Risk level assessment
   - User settings evaluation
   - Approval UI display (if needed)

3. **Execution**
   - Route to appropriate executor
   - Call Tauri command
   - Handle native operation

4. **Result Processing**
   - Format response
   - Update tracking record
   - Return to conversation

5. **State Synchronization**
   - Refresh file explorer
   - Update workspace state
   - Persist changes

## Configuration Management

### LLM Provider Configuration
**Stored in**: `src/store/useSettingsStore.ts`
**Persisted via**: `src-tauri/src/commands/settings.rs`

**Configuration Parameters**:
- Base URL and API key
- Model selection
- Temperature and token limits
- Provider-specific features (thinking, tool streaming)
- Custom headers and parameters

### Tool Approval Settings
**Per-tool configuration**:
- `auto` - Always approve
- `deny` - Always reject
- `always_ask` - Prompt user each time

**Global settings**:
- Default approval behavior
- Risk threshold adjustments

## Data Persistence

### Database Schema
**Tables**:
- `workspace_state` - Workspace configuration
- `editor_state` - Editor tabs and layout
- `explorer_state` - File explorer state
- `app_settings` - Application configuration
- `llm_providers` - LLM provider configurations
- `tool_settings` - Tool approval settings

### State Synchronization
**Cross-window sync** via:
- `useWindowStateSync.ts` hook
- Window message passing
- Shared database state

## Error Handling and Recovery

### Error Categories
1. **LLM Provider Errors**
   - Network failures
   - API rate limits
   - Authentication issues

2. **Tool Execution Errors**
   - File system permissions
   - Command failures
   - Invalid arguments

3. **System Errors**
   - Database connection issues
   - Tauri command failures
   - Resource constraints

### Recovery Strategies
- Automatic retry for transient failures
- Graceful degradation for missing capabilities
- User notification for approval requirements
- State rollback for failed operations

## Security Considerations

### Tool Execution Safety
- Risk-based approval system
- Command argument validation
- Path traversal protection
- Shell injection prevention

### Data Protection
- Local-only operation by default
- No data transmission to external services
- Encrypted credential storage
- User consent for file operations

## Performance Optimizations

### Streaming Architecture
- Real-time token streaming
- Incremental UI updates
- Non-blocking tool execution
- Parallel tool calls (where safe)

### Caching Strategies
- File system metadata caching
- LLM response caching
- Workspace state caching
- Tool definition caching

## Extensibility Points

### Adding New Tools
1. Define tool schema in `definitions/`
2. Implement executor in `executors/`
3. Register in `registry.ts`
4. Set risk level and approval requirements

### Adding New LLM Providers
1. Implement provider-specific logic in `llm-provider.ts`
2. Add configuration options in settings
3. Handle provider-specific response formats
4. Update provider type detection

### Adding New Tauri Commands
1. Implement Rust command in `commands/`
2. Add TypeScript wrapper in `lib/tauri.ts`
3. Register in `lib.rs` invoke_handler
4. Update database schema if needed

## Monitoring and Debugging

### Logging Points
- LLM request/response logging
- Tool execution tracking
- Error event logging
- Performance metrics

### Debug Tools
- Developer tools integration
- Timeline event visualization
- Tool execution history
- System state inspection

This architecture provides a robust, secure, and extensible foundation for AI-powered development workflows while maintaining clear separation of concerns and comprehensive error handling.
