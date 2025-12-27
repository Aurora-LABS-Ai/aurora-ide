# Shai CLI Agent Tools: Deep Dive Analysis

This document analyzes how the **Shai CLI agent** (written in Rust) implements its tool system, focusing on file read/write operations and the core architecture.

---

## Table of Contents

- [Overview](#overview)
- [Architecture](#architecture)
- [Tool System Design](#tool-system-design)
- [File System Tools](#file-system-tools)
- [Tool Execution Flow](#tool-execution-flow)
- [Permission System](#permission-system)
- [Operation Logging](#operation-logging)
- [Comparison with Aurora/Cursor](#comparison-with-auroracursor)

---

## Overview

**Shai** is a Rust-based CLI coding agent that:
- Runs in terminal (TUI mode) or headless mode
- Uses LLM providers (OpenAI-compatible) with function calling
- Implements a sophisticated tool system with permissions and operation logging
- Tracks file operations to enforce safety rules (must read before edit)

**Key Characteristics:**
- **Language**: Rust (async/await with Tokio)
- **Tool System**: Trait-based with type-safe parameters
- **Safety**: Operation logging + permission system
- **Preview Mode**: Tools can show previews before execution
- **Parallel Execution**: Multiple tools can run concurrently

---

## Architecture

### High-Level Structure

```
┌─────────────────┐
│   CLI/TUI/HTTP  │  (shai-cli, shai-http)
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│   Agent Core    │  (shai-core/src/agent/)
│   - Brain       │  (LLM interaction)
│   - Tools       │  (Tool execution)
│   - States      │  (State machine)
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│   Tool System   │  (shai-core/src/tools/)
│   - Read        │
│   - Write       │
│   - Edit        │
│   - Bash        │
│   - MCP         │
└─────────────────┘
```

### Workspace Structure

```
shai/
├── shai-core/          # Core agent logic
│   ├── agent/         # Agent orchestration
│   ├── tools/         # Tool implementations
│   ├── runners/       # Agent runners (coder, searcher, etc.)
│   └── config/        # Configuration
├── shai-cli/          # CLI interface
├── shai-llm/          # LLM provider abstraction
├── shai-http/         # HTTP server mode
└── shai-macros/       # Procedural macros for tools
```

---

## Tool System Design

### Tool Trait Hierarchy

```rust
// Base trait for tool description (name, description, schema)
pub trait ToolDescription {
    fn name(&self) -> &str;
    fn description(&self) -> &str;
    fn parameters_schema(&self) -> serde_json::Value;
}

// Main tool trait with typed parameters
#[async_trait]
pub trait Tool: ToolDescription + Send + Sync {
    type Params: DeserializeOwned + JsonSchema + Send + Sync;
    
    fn capabilities(&self) -> &'static [ToolCapability];
    
    async fn execute(&self, params: Self::Params, cancel_token: Option<CancellationToken>) -> ToolResult;
    
    async fn execute_preview(&self, params: Self::Params) -> Option<ToolResult>;
}

// Type-erased trait for dynamic dispatch
#[async_trait]
pub trait AnyTool: ToolDescription + Send + Sync {
    fn capabilities(&self) -> &[ToolCapability];
    async fn execute_json(&self, params: serde_json::Value, cancel_token: Option<CancellationToken>) -> ToolResult;
    async fn execute_preview_json(&self, params: serde_json::Value) -> Option<ToolResult>;
}
```

### Tool Capabilities

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ToolCapability {
    Read,      // File read operations
    Write,     // File write operations
    Network,   // Network operations
}
```

**Purpose:**
- Used for permission checking
- Read operations are auto-approved
- Write/Network operations require user permission

### Tool Result

```rust
pub enum ToolResult {
    Success {
        output: String,
        metadata: Option<HashMap<String, serde_json::Value>>,
    },
    Error {
        error: String,
        metadata: Option<HashMap<String, serde_json::Value>>,
    },
    Denied,  // User rejected the tool call
}
```

---

## File System Tools

### 1. Read Tool

**Location:** `shai-core/src/tools/fs/read/read.rs`

**Parameters:**
```rust
pub struct ReadToolParams {
    pub path: String,                    // File path
    pub line_start: Option<u32>,         // Start line (1-indexed)
    pub line_end: Option<u32>,          // End line (1-indexed)
    pub show_line_numbers: bool,        // Include line numbers
}
```

**Implementation:**

```rust
impl ReadTool {
    fn read_file_content(&self, params: &ReadToolParams) -> io::Result<String> {
        let file = fs::File::open(&params.path)?;
        let reader = BufReader::new(file);
        
        match (params.line_start, params.line_end) {
            // Read specific line range
            (Some(start), Some(end)) => {
                reader.lines()
                    .enumerate()
                    .filter_map(|(i, line)| {
                        let line_num = i as u32 + 1; // 1-based
                        if line_num >= start && line_num <= end {
                            Some(line.map(|l| (line_num, l)))
                        } else { None }
                    })
                    .collect()
            },
            // Read entire file
            (None, None) => {
                if params.show_line_numbers {
                    // Format with line numbers: "   1: content"
                    reader.lines()
                        .enumerate()
                        .map(|(i, line)| {
                            let line_num = i as u32 + 1;
                            line.map(|l| (line_num, l))
                        })
                        .collect()
                } else {
                    fs::read_to_string(&params.path)
                }
            },
            // ... other cases
        }
    }
    
    async fn execute(&self, params: ReadToolParams) -> ToolResult {
        // Check file exists
        if !path.exists() {
            return ToolResult::error("File does not exist");
        }
        
        // Read file
        match self.read_file_content(&params) {
            Ok(content) => {
                // Log the read operation
                self.operation_log.log_operation(
                    FsOperationType::Read, 
                    params.path.clone()
                ).await;
                
                ToolResult::Success {
                    output: content,
                    metadata: Some(meta),
                }
            },
            Err(e) => ToolResult::error(format!("Failed to read: {}", e))
        }
    }
}
```

**Key Features:**
- Line range support (read specific lines)
- Optional line numbers in output
- Logs operation to `FsOperationLog`
- Tracks which files have been read

---

### 2. Write Tool

**Location:** `shai-core/src/tools/fs/write/write.rs`

**Parameters:**
```rust
pub struct WriteToolParams {
    pub path: String,      // File path
    pub content: String,   // Complete file content
}
```

**Implementation:**

```rust
impl WriteTool {
    fn perform_write(&self, params: &WriteToolParams) -> Result<String, String> {
        let path = Path::new(&params.path);
        
        // Check if file exists
        let file_existed = path.exists();
        
        // Create parent directories if needed
        if let Some(parent) = path.parent() {
            if !parent.exists() {
                fs::create_dir_all(parent)?;
            }
        }
        
        // Write content (overwrites if exists)
        fs::write(path, &params.content)?;
        
        let action = if file_existed { "updated" } else { "created" };
        Ok(format!("Successfully {} file '{}' with {} bytes", 
                  action, params.path, params.content.len()))
    }
    
    async fn execute_preview(&self, params: WriteToolParams) -> Option<ToolResult> {
        // Show preview without writing
        Some(ToolResult::Success {
            output: params.content.clone(),
            metadata: Some(meta),
        })
    }
    
    async fn execute(&self, params: WriteToolParams) -> ToolResult {
        match self.perform_write(&params) {
            Ok(message) => {
                // Log the write operation
                self.operation_log.log_operation(
                    FsOperationType::Write, 
                    params.path.clone()
                ).await;
                
                ToolResult::Success {
                    output: format!("{}\n{}", message, params.content),
                    metadata: Some(meta),
                }
            },
            Err(e) => ToolResult::error(format!("Write failed: {}", e))
        }
    }
}
```

**Key Features:**
- Creates parent directories automatically
- Tracks if file existed (created vs updated)
- Preview mode available
- Logs operation

**Safety Rule:**
- Tool description says: "To overwrite an existing file, you must first have read it with the `read` tool"
- This is enforced by `FsOperationLog` (see below)

---

### 3. Edit Tool

**Location:** `shai-core/src/tools/fs/edit/edit.rs`

**Parameters:**
```rust
pub struct EditToolParams {
    pub path: String,           // File path
    pub old_string: String,    // Exact text to replace
    pub new_string: String,    // Replacement text
    pub replace_all: bool,     // Replace all occurrences
}
```

**Implementation:**

```rust
impl EditTool {
    pub fn perform_edit_on_content(
        &self, 
        content: &str, 
        old_string: &str, 
        new_string: &str, 
        replace_all: bool
    ) -> Result<(String, usize), String> {
        // Check if old_string exists
        if !content.contains(old_string) {
            return Err("Pattern not found in file".to_string());
        }
        
        // Perform replacement
        let (new_content, replacements) = if replace_all {
            let new_content = content.replace(old_string, new_string);
            let replacements = content.matches(old_string).count();
            (new_content, replacements)
        } else {
            let new_content = content.replacen(old_string, new_string, 1);
            (new_content, 1)
        };
        
        Ok((new_content, replacements))
    }
    
    pub fn myers_diff(&self, before: &str, after: &str) -> String {
        // Uses `similar` crate for diff algorithm
        // Generates colored diff output showing changes
        // Format: "- old line" (red), "+ new line" (green)
    }
    
    async fn execute(&self, params: EditToolParams) -> ToolResult {
        // VALIDATION: Must have read file first!
        if let Err(err) = self.operation_log.validate_edit_permission(&params.path).await {
            return ToolResult::error(err);
        }
        
        // Read file
        let content = fs::read_to_string(&params.path)?;
        
        // Perform edit
        let (new_content, replacements) = self.perform_edit_on_content(
            &content, 
            &params.old_string, 
            &params.new_string, 
            params.replace_all
        )?;
        
        // Generate diff
        let diff = self.myers_diff(&content, &new_content);
        
        // Write file
        fs::write(&params.path, &new_content)?;
        
        // Log operation
        self.operation_log.log_operation(
            FsOperationType::Edit, 
            params.path.clone()
        ).await;
        
        ToolResult::Success {
            output: diff,  // Returns diff, not full content
            metadata: Some(meta),
        }
    }
}
```

**Key Features:**
- **Requires read first**: Validates file was read before editing
- **Exact string matching**: `old_string` must match exactly (including whitespace)
- **Diff output**: Uses Myers' algorithm to show changes
- **Single or multiple**: `replace_all` flag for global replacements
- **Preview mode**: Can preview changes without applying

---

## Tool Execution Flow

### Complete Flow Diagram

```
LLM Response (with tool_calls)
    ↓
AgentCore::spawn_tools()
    ↓
For each tool_call:
    ├─→ Check if tool exists
    ├─→ Parse parameters (JSON → typed)
    ├─→ Check permissions
    │   ├─→ Read tools: Auto-approved
    │   └─→ Write/Network: Request permission
    │       ├─→ Execute preview (if available)
    │       ├─→ Send PermissionRequired event
    │       └─→ Wait for user response
    ├─→ Execute tool (with cancellation support)
    ├─→ Log operation (if file operation)
    ├─→ Add result to trace
    └─→ Emit ToolCallCompleted event
    ↓
All tools complete → Continue agent loop
```

### Code Flow

**1. Agent receives tool calls from LLM:**

```rust
// shai-core/src/agent/actions/tools.rs
impl AgentCore {
    pub async fn spawn_tools(&mut self, tool_calls: Vec<LlmToolCall>) {
        // Spawn all tools in parallel
        for tc in tool_calls {
            let handle = Self::spawn_tool_static(
                tc,
                cancel_token.clone(),
                available_tools.clone(),
                claims.clone(),
                // ...
            );
            join_handles.push(handle);
        }
        
        // Wait for all to complete
        tokio::spawn(async move {
            // Wait for all handles...
            let _ = internal_tx.send(InternalAgentEvent::ToolsCompleted { any_denied });
        });
    }
}
```

**2. Execute single tool:**

```rust
fn spawn_tool_static(...) -> JoinHandle<bool> {
    tokio::spawn(async move {
        // Find tool
        let (tool, call) = Self::tool_exist(available_tools, tc)?;
        
        // Emit ToolCallStarted event
        tx.send(AgentEvent::ToolCallStarted { ... });
        
        // Execute tool
        let result = Self::spawn_tool_exec(
            tool, 
            call.clone(),
            cancel_token,
            claims,
            // ...
        ).await;
        
        // Add to trace
        trace.write().await.push(ChatMessage::Tool {
            tool_call_id: call.tool_call_id,
            content: result.to_string()
        });
        
        // Emit ToolCallCompleted event
        tx.send(AgentEvent::ToolCallCompleted { ... });
        
        result.is_denied()
    })
}
```

**3. Permission check and execution:**

```rust
fn spawn_tool_exec(...) -> JoinHandle<ToolResult> {
    tokio::spawn(async move {
        // Check permission
        let can_run = tool.capabilities().is_empty()  
            || tool.capabilities() == &[ToolCapability::Read]  // Read auto-approved
            || claims.read().await.is_permitted(&tool.name(), &call.parameters);
        
        // Request permission if needed
        if !can_run {
            let can_run = Self::request_permission_if_needed(...).await?;
        }
        
        if !can_run {
            return ToolResult::denied();
        }
        
        // Execute tool with cancellation support
        tokio::select! {
            result = tool.execute_json(call.parameters, Some(cancel_token)) => result,
            _ = cancel_token.cancelled() => {
                ToolResult::error("cancelled by user")
            }
        }
    })
}
```

**4. Permission request:**

```rust
async fn request_permission_if_needed(...) -> Result<bool, ToolResult> {
    // Get preview
    let preview = tool.execute_preview_json(call.parameters.clone()).await;
    
    // Send permission request event
    tx.send(AgentEvent::PermissionRequired {
        request_id: req_id.clone(),
        request: PermissionRequest {
            tool_name: call.tool_name.clone(),
            call: call.clone(),
            preview,  // Show user what will happen
        }
    });
    
    // Wait for response
    loop {
        match internal_rx.recv().await {
            Ok(InternalAgentEvent::PermissionResponseReceived { request_id, response }) 
                if request_id == req_id => {
                return Ok(matches!(response, PermissionResponse::Allow | PermissionResponse::AllowAlways));
            }
            _ => continue,
        }
    }
}
```

---

## Permission System

### Claim Manager

**Location:** `shai-core/src/agent/claims.rs`

**Purpose:**
- Tracks which tools/files have been approved
- Supports "allow always" for specific tools
- Supports "sudo mode" (bypass all checks)

**Key Methods:**

```rust
pub struct ClaimManager {
    // Tracks approved operations
    claims: HashMap<String, Permission>,
    sudo: bool,
}

impl ClaimManager {
    pub fn is_permitted(&self, tool_name: &str, params: &serde_json::Value) -> bool {
        if self.sudo {
            return true;  // Sudo mode bypasses all checks
        }
        
        // Check if tool has "allow always" permission
        if let Some(Permission::AllowAlways) = self.claims.get(tool_name) {
            return true;
        }
        
        // Check specific claim for this operation
        // ...
    }
    
    pub fn sudo(&mut self) {
        self.sudo = true;
    }
    
    pub fn no_sudo(&mut self) {
        self.sudo = false;
    }
}
```

### Permission Flow

1. **Read operations**: Auto-approved (no permission needed)
2. **Write/Network operations**: 
   - Check if already permitted (claim exists)
   - If not, request permission with preview
   - User can: Allow, Deny, or Allow Always
   - Result stored in `ClaimManager`

---

## Operation Logging

### FsOperationLog

**Location:** `shai-core/src/tools/fs/operation_log.rs`

**Purpose:**
- Tracks all file system operations
- Enforces safety rule: "Must read before edit"
- Provides operation history

**Implementation:**

```rust
pub struct FsOperationLog {
    operations: RwLock<Vec<FsOperation>>,      // All operations
    read_files: RwLock<HashSet<String>>,       // Files that have been read
}

impl FsOperationLog {
    pub async fn log_operation(&self, operation_type: FsOperationType, file_path: String) {
        let operation = FsOperation {
            operation_type: operation_type.clone(),
            file_path: file_path.clone(),
            timestamp: Utc::now(),
        };
        
        operations.write().await.push(operation);
        
        // Track reads separately
        if operation_type == FsOperationType::Read {
            read_files.write().await.insert(file_path);
        }
    }
    
    pub async fn validate_edit_permission(&self, file_path: &str) -> Result<(), String> {
        if !self.has_been_read(file_path).await {
            return Err(format!(
                "Cannot edit file '{}': The file must be read first using the Read tool before it can be edited.",
                file_path
            ));
        }
        Ok(())
    }
}
```

**Safety Rule Enforcement:**

- **Edit tool** calls `validate_edit_permission()` before editing
- **Write tool** description says: "To overwrite an existing file, you must first have read it"
- This prevents accidental overwrites without context

---

## Comparison with Aurora/Cursor

### Shai vs Aurora Agent Tools

| Aspect | Shai | Aurora |
|--------|------|--------|
| **Language** | Rust | TypeScript/React |
| **Tool Definition** | Rust traits + macros | TypeScript interfaces |
| **Parameter Types** | Typed (via serde) | JSON (string) |
| **Safety** | Operation log + permissions | Risk levels + approval |
| **Preview** | Built-in preview mode | No preview |
| **Read-Before-Edit** | Enforced by operation log | Not enforced |
| **Parallel Execution** | Yes (Tokio spawn) | Sequential |
| **Cancellation** | CancellationToken support | Basic stop |

### Shai vs Cursor Tools

| Aspect | Shai | Cursor |
|--------|------|--------|
| **Execution** | Agent loop (iterative) | Direct (single call) |
| **Approval** | Permission system | No approval |
| **Preview** | Yes | No |
| **Safety** | Operation logging | No safety checks |
| **Format** | Structured ToolResult | Direct file content |

---

## Key Innovations in Shai

### 1. **Operation Logging**
- Tracks all file operations
- Enforces "read before edit" rule
- Provides audit trail

### 2. **Preview Mode**
- Tools can show what will happen before execution
- User sees diff/preview before approving
- Reduces accidental changes

### 3. **Type-Safe Tools**
- Rust traits ensure type safety
- Parameters are validated at compile time
- JSON deserialization with error handling

### 4. **Parallel Tool Execution**
- Multiple tools run concurrently
- Uses Tokio async runtime
- Faster for independent operations

### 5. **Cancellation Support**
- Tools can be cancelled mid-execution
- Uses `CancellationToken` pattern
- Graceful cleanup

### 6. **Permission Claims**
- "Allow always" for trusted tools
- Sudo mode for development
- Per-tool permission tracking

---

## Example: Complete Tool Call Lifecycle

### Scenario: "Edit src/main.rs to add a function"

**1. LLM decides to call `read` tool:**

```json
{
  "tool_calls": [{
    "id": "call_1",
    "function": {
      "name": "read",
      "arguments": "{\"path\": \"src/main.rs\", \"show_line_numbers\": true}"
    }
  }]
}
```

**2. Agent executes read:**

```rust
// Auto-approved (Read capability)
let result = read_tool.execute(params).await;
// Result: File content with line numbers
// Logged: FsOperationLog.log_operation(Read, "src/main.rs")
```

**3. LLM decides to call `edit` tool:**

```json
{
  "tool_calls": [{
    "id": "call_2",
    "function": {
      "name": "edit",
      "arguments": "{\"path\": \"src/main.rs\", \"old_string\": \"fn main() {\", \"new_string\": \"fn new_function() {\\n    // ...\\n}\\n\\nfn main() {\"}"
    }
  }]
}
```

**4. Agent checks permission:**

```rust
// Check: Has file been read?
operation_log.validate_edit_permission("src/main.rs")?; // ✓ Passes

// Check: Requires Write capability
if tool.capabilities().contains(&ToolCapability::Write) {
    // Request permission with preview
    let preview = tool.execute_preview_json(params).await;
    // Show user: diff of changes
    // User approves → Execute
}
```

**5. Execute edit:**

```rust
// Read file
let content = fs::read_to_string("src/main.rs")?;

// Perform edit
let (new_content, replacements) = edit_tool.perform_edit_on_content(
    &content,
    &params.old_string,
    &params.new_string,
    false
)?;

// Generate diff
let diff = edit_tool.myers_diff(&content, &new_content);

// Write file
fs::write("src/main.rs", &new_content)?;

// Log operation
operation_log.log_operation(Edit, "src/main.rs").await;

// Return diff to LLM
ToolResult::Success { output: diff, ... }
```

**6. Result added to conversation:**

```rust
trace.write().await.push(ChatMessage::Tool {
    tool_call_id: "call_2",
    content: diff_output
});
```

**7. LLM continues with next step...**

---

## Summary

**Shai's tool system is sophisticated because:**

1. **Type Safety**: Rust traits ensure compile-time safety
2. **Operation Logging**: Tracks operations and enforces safety rules
3. **Preview Mode**: Shows changes before applying
4. **Permission System**: Granular control with claims
5. **Parallel Execution**: Multiple tools run concurrently
6. **Cancellation**: Tools can be cancelled gracefully
7. **Diff Output**: Shows exactly what changed

**Key Design Patterns:**

- **Trait-based**: `Tool` trait for type-safe tools
- **Type Erasure**: `AnyTool` for dynamic dispatch
- **Operation Logging**: Centralized tracking of file operations
- **Permission Claims**: Cached permissions for performance
- **Event-Driven**: Tools emit events for UI updates

This architecture makes Shai both powerful and safe, with excellent developer experience!

