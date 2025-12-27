# Aurora Agent Tools vs Cursor Tools: Comparison & Examples

This document compares the two tooling systems in this workspace:
1. **Aurora Agent Tools** - Tools available to the AI agent running inside Aurora
2. **Cursor Tools** - Tools available to Claude (the AI assistant) in Cursor IDE

---

## Table of Contents

- [Overview](#overview)
- [Architecture Comparison](#architecture-comparison)
- [Execution Flow](#execution-flow)
- [Side-by-Side Examples](#side-by-side-examples)
- [Use Cases](#use-cases)
- [Key Differences Summary](#key-differences-summary)

---

## Overview

### Aurora Agent Tools

**Purpose:** Tools that the AI agent (running inside the Aurora application) can use to interact with the user's workspace.

**Characteristics:**
- 29 tools total across 4 categories (File, Workspace, Shell, Editor)
- Defined as OpenAI-compatible function definitions
- Executed by the agent service in an iterative conversation loop
- Results are fed back to the LLM for the next iteration
- User approval system for risky operations (high/medium risk tools)
- Tools are sent to the LLM as part of the API request
- Maximum 25 tool iterations per user message

**Location in Codebase:**
- Definitions: `src/tools/definitions/`
- Executors: `src/tools/executors/`
- Registry: `src/tools/registry.ts`
- Agent Service: `src/services/agent-service.ts`

### Cursor Tools

**Purpose:** Tools that Claude (the AI assistant in Cursor IDE) uses to help you work with your codebase.

**Characteristics:**
- Built into Cursor IDE
- Direct execution by Claude (no approval needed)
- Used for reading, writing, searching, and analyzing code
- Results are used by Claude to provide assistance
- No iteration limit or conversation loop
- Tools are part of Claude's capabilities, not sent to an LLM

**Location:**
- Built into Cursor IDE (not part of this codebase)
- Documented in `cursor-tools.md`

---

## Architecture Comparison

### Aurora Agent Tools Architecture

```
User Message
    ↓
Agent Service (agent-service.ts)
    ↓
LLM Provider (llm-provider.ts)
    ↓
[Tools sent to LLM as function definitions]
    ↓
LLM Response (with tool_calls)
    ↓
Tool Registry (registry.ts)
    ↓
Tool Executor (executors/*.ts)
    ↓
Tauri Commands (Rust backend)
    ↓
File System / System Operations
    ↓
Result returned to LLM
    ↓
Next iteration (up to 25 times)
```

**Key Components:**
- `ToolRegistry`: Central registry managing tool definitions and executors
- `AgentService`: Orchestrates the conversation loop with tool execution
- `LLMProvider`: Sends tools to LLM and handles streaming responses
- Tool Executors: Implementations that call Tauri commands

### Cursor Tools Architecture

```
User Query to Claude
    ↓
Claude decides which tool to use
    ↓
Direct tool execution
    ↓
File System / Codebase
    ↓
Result returned to Claude
    ↓
Claude uses result to help user
```

**Key Characteristics:**
- No intermediate service layer
- Direct execution by Claude
- No approval workflow
- No conversation loop (single execution per tool call)

---

## Execution Flow

### Aurora Agent Tools Flow

**Example: User asks "Create a new component called Button"**

1. **User sends message** → `AgentService.chat()`
2. **Agent Service builds request** with:
   - System prompt
   - Conversation history
   - User message
   - **All 29 tool definitions** (sent to LLM)
3. **LLM receives request** and decides to call `file_create` tool
4. **LLM returns response** with `tool_calls` array:
   ```json
   {
     "tool_calls": [{
       "id": "call_123",
       "type": "function",
       "function": {
         "name": "file_create",
         "arguments": "{\"path\": \"src/components/Button.tsx\", \"content\": \"...\"}"
       }
     }]
   }
   ```
5. **Agent Service checks approval**:
   - Risk level: `file_create` = "medium" risk
   - User settings: Check if auto-approve or requires approval
   - If approval needed → Show modal to user
6. **If approved** → `ToolRegistry.executeToolCall()`
7. **Executor runs** → Calls Tauri command → Creates file
8. **Result returned** to LLM as tool message:
   ```json
   {
     "role": "tool",
     "tool_call_id": "call_123",
     "content": "{\"success\": true, \"message\": \"File created: src/components/Button.tsx\"}"
   }
   ```
9. **LLM receives result** and generates final response
10. **Process repeats** if LLM needs more tools (up to 25 iterations)

### Cursor Tools Flow

**Example: User asks "Create a new component called Button"**

1. **User asks Claude** → "Create a new component called Button"
2. **Claude decides** to use `write` tool
3. **Claude executes directly**:
   ```typescript
   write({
     file_path: "src/components/Button.tsx",
     contents: "export const Button = () => { return <button>Click</button>; };"
   })
   ```
4. **File is created** immediately
5. **Claude responds** to user with confirmation
6. **No approval needed** - execution is immediate

---

## Side-by-Side Examples

### Example 1: Reading a File

#### Aurora Agent Tool

**Tool Definition:**
```typescript
// src/tools/definitions/file-tools.ts
export const fileReadTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'file_read',
    description: 'Read the entire content of a file at the specified path.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'The full path of the file to read (e.g., "src/App.tsx")',
        },
      },
      required: ['path'],
    },
  },
};
```

**Executor:**
```typescript
// src/tools/executors/file-executors.ts
const fileReadExecutor = async (args: Record<string, any>): Promise<string> => {
  const fullPath = resolvePath(args.path);
  const content = await readFileContent(fullPath); // Tauri command
  return JSON.stringify({
    success: true,
    path: args.path,
    fullPath,
    content,
    lines: content.split("\n").length,
  });
};
```

**How LLM calls it:**
```json
{
  "tool_calls": [{
    "id": "call_abc",
    "type": "function",
    "function": {
      "name": "file_read",
      "arguments": "{\"path\": \"src/App.tsx\"}"
    }
  }]
}
```

**Result returned to LLM:**
```json
{
  "role": "tool",
  "tool_call_id": "call_abc",
  "content": "{\"success\": true, \"path\": \"src/App.tsx\", \"content\": \"...\", \"lines\": 50}"
}
```

#### Cursor Tool

**Tool Definition:**
```typescript
// Built into Cursor IDE
read_file({
  target_file: "src/App.tsx"
})
```

**How Claude calls it:**
- Direct function call, no JSON serialization
- Returns file content with line numbers: `1|import React...`

**Key Differences:**
- Aurora: JSON string format, includes metadata (success, lines, etc.)
- Cursor: Direct content with line numbers, simpler format
- Aurora: Goes through Tauri command layer
- Cursor: Direct file system access

---

### Example 2: Writing a File

#### Aurora Agent Tool

**Tool Definition:**
```typescript
export const fileWriteTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'file_write',
    description: 'Write content to a file, completely replacing its existing content.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'The full path of the file to write' },
        content: { type: 'string', description: 'The complete content to write' },
      },
      required: ['path', 'content'],
    },
  },
};
```

**Execution Flow:**
1. LLM decides to call `file_write`
2. Agent Service checks approval (high risk → requires approval)
3. User approves via modal
4. Executor runs → Tauri command → File written
5. Result returned to LLM
6. LLM confirms completion

**Approval Modal:**
```typescript
// User sees modal asking:
// "The agent wants to execute: file_write"
// Arguments: { path: "src/App.tsx", content: "..." }
// [Approve] [Reject]
```

#### Cursor Tool

**Tool Definition:**
```typescript
write({
  file_path: "src/App.tsx",
  contents: "import React from 'react';..."
})
```

**Execution Flow:**
1. Claude decides to write file
2. **Immediate execution** (no approval)
3. File written
4. Claude confirms to user

**Key Differences:**
- Aurora: Requires user approval for high-risk operations
- Cursor: Immediate execution, no approval workflow
- Aurora: Approval can be configured per tool
- Cursor: All operations are immediate

---

### Example 3: Searching Code

#### Aurora Agent Tool

**Tool Definition:**
```typescript
export const workspaceGrepTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'workspace_grep',
    description: 'Search for a pattern across all files in the workspace.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'The search pattern (supports regex)' },
        path: { type: 'string', description: 'Starting directory' },
        file_pattern: { type: 'string', description: 'Glob pattern to filter files' },
        max_results: { type: 'number', default: 50 },
      },
      required: ['pattern'],
    },
  },
};
```

**How it works:**
- LLM calls `workspace_grep` with pattern
- Executor searches files via Tauri commands
- Returns JSON with matches
- LLM uses results to answer user

**Example Call:**
```json
{
  "function": {
    "name": "workspace_grep",
    "arguments": "{\"pattern\": \"useState\", \"file_pattern\": \"*.tsx\"}"
  }
}
```

#### Cursor Tool

**Tools Available:**
1. `grep` - Regex-based search
2. `codebase_search` - Semantic search

**Example:**
```typescript
// Exact search
grep({ 
  pattern: "useState",
  type: "tsx"
})

// Semantic search
codebase_search({
  query: "Where is state management implemented?",
  target_directories: ["src/store"]
})
```

**Key Differences:**
- Aurora: Single `workspace_grep` tool (regex-based)
- Cursor: Two tools (`grep` for exact, `codebase_search` for semantic)
- Aurora: Results in JSON format
- Cursor: Results in readable format with context

---

### Example 4: Executing Shell Commands

#### Aurora Agent Tool

**Tool Definition:**
```typescript
export const shellExecuteTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'shell_execute',
    description: 'Execute a shell command in the workspace directory.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        cwd: { type: 'string' },
        timeout: { type: 'number', default: 30000 },
      },
      required: ['command'],
    },
  },
};
```

**Execution Flow:**
1. LLM decides to run command (e.g., `pnpm install`)
2. **High risk** → Requires user approval
3. User sees modal: "Execute: pnpm install"
4. If approved → Executor runs via Tauri
5. Command output returned to LLM
6. LLM interprets results and responds

**Terminal Integration:**
- Results also displayed in Aurora's terminal UI
- Background processes tracked
- Process management available

#### Cursor Tool

**Tool Definition:**
```typescript
run_terminal_cmd({
  command: "pnpm install",
  is_background: false
})
```

**Execution Flow:**
1. Claude decides to run command
2. **Immediate execution** (no approval)
3. Command runs in workspace terminal
4. Output returned to Claude
5. Claude uses output to help user

**Key Differences:**
- Aurora: Requires approval for shell commands (high risk)
- Cursor: Immediate execution
- Aurora: Integrated with terminal UI
- Cursor: Runs in Cursor's terminal

---

### Example 5: Complex Multi-Step Operation

#### Aurora Agent Tool Flow

**User asks: "Refactor the Button component to use TypeScript"**

**Iteration 1:**
```json
LLM Response: {
  "tool_calls": [{
    "function": { "name": "file_read", "arguments": "{\"path\": \"src/components/Button.jsx\"}" }
  }]
}
```

**Iteration 2:**
```json
LLM Response: {
  "tool_calls": [{
    "function": { "name": "file_write", "arguments": "{\"path\": \"src/components/Button.tsx\", \"content\": \"...\"}" }
  }]
}
```
→ **User approval required** (high risk)

**Iteration 3:**
```json
LLM Response: {
  "tool_calls": [{
    "function": { "name": "file_delete", "arguments": "{\"path\": \"src/components/Button.jsx\"}" }
  }]
}
```
→ **User approval required** (high risk)

**Iteration 4:**
```json
LLM Response: {
  "content": "I've successfully refactored the Button component to TypeScript..."
}
```

**Total:** 4 iterations, 2 approvals needed

#### Cursor Tool Flow

**User asks: "Refactor the Button component to use TypeScript"**

**Step 1:** Claude reads the file
```typescript
read_file({ target_file: "src/components/Button.jsx" })
```

**Step 2:** Claude creates TypeScript version
```typescript
write({
  file_path: "src/components/Button.tsx",
  contents: "// TypeScript version..."
})
```

**Step 3:** Claude deletes old file
```typescript
delete_file({ target_file: "src/components/Button.jsx" })
```

**Step 4:** Claude responds to user

**Total:** 3 tool calls, 0 approvals needed

**Key Differences:**
- Aurora: Iterative loop with LLM deciding each step
- Cursor: Claude plans and executes all steps directly
- Aurora: User sees each tool call and approves
- Cursor: User sees final result

---

## Use Cases

### When to Use Aurora Agent Tools

**Best For:**
1. **Autonomous AI Agent** - When you want an AI that can work independently
2. **User Control** - When you want approval for risky operations
3. **Iterative Problem Solving** - When the AI needs to explore and iterate
4. **Complex Multi-Step Tasks** - When the AI needs to plan and execute multiple steps
5. **Production Environments** - When safety and approval are critical

**Example Scenarios:**
- "Refactor the entire codebase to use TypeScript"
- "Set up a new project structure"
- "Fix all linting errors in the project"
- "Migrate from one framework to another"

### When to Use Cursor Tools

**Best For:**
1. **Direct Assistance** - When you want immediate help with code
2. **Quick Edits** - When you need fast file operations
3. **Code Analysis** - When you need to understand existing code
4. **Learning** - When you want explanations and examples
5. **Development Speed** - When you want to move fast without approvals

**Example Scenarios:**
- "Show me how useState is used in this file"
- "Add error handling to this function"
- "Explain what this code does"
- "Create a simple utility function"

---

## Key Differences Summary

| Aspect | Aurora Agent Tools | Cursor Tools |
|--------|-------------------|--------------|
| **Purpose** | AI agent inside Aurora app | Claude assistant in Cursor IDE |
| **Execution** | Via Agent Service → LLM → Registry → Executor | Direct execution by Claude |
| **Approval** | Required for high/medium risk tools | Not required |
| **Format** | OpenAI function calling format | Direct function calls |
| **Results** | JSON strings returned to LLM | Direct results to Claude |
| **Iteration** | Up to 25 iterations per message | Single execution per call |
| **User Control** | Per-tool approval settings | No approval workflow |
| **Risk Levels** | Low/Medium/High classification | No risk classification |
| **Tool Count** | 29 tools (4 categories) | ~10+ tools (various) |
| **Integration** | Integrated with Aurora UI (terminal, editor) | Integrated with Cursor IDE |
| **Conversation Loop** | Yes - results feed back to LLM | No - single execution |
| **Planning** | LLM plans and executes iteratively | Claude plans and executes directly |
| **Visibility** | User sees tool calls and approvals | User sees final results |

---

## Code Examples

### Aurora: Complete Tool Call Lifecycle

```typescript
// 1. Tool Definition (sent to LLM)
const tool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'file_write',
    description: 'Write content to a file',
    parameters: { /* ... */ }
  }
};

// 2. LLM Response (with tool call)
const llmResponse = {
  tool_calls: [{
    id: 'call_123',
    function: {
      name: 'file_write',
      arguments: JSON.stringify({ path: 'test.ts', content: '...' })
    }
  }]
};

// 3. Approval Check
const requiresApproval = toolRegistry.requiresApproval('file_write'); // true (high risk)
if (requiresApproval) {
  const approved = await callbacks.onToolApprovalRequired(toolCall);
}

// 4. Execution
const result = await toolRegistry.executeToolCall(toolCall);
// Returns: { tool_call_id: 'call_123', role: 'tool', content: '{"success": true}' }

// 5. Result added to conversation
messages.push({
  role: 'tool',
  tool_call_id: 'call_123',
  content: result.content
});

// 6. LLM receives result and continues
```

### Cursor: Direct Tool Execution

```typescript
// 1. Claude decides to use tool
// 2. Direct execution
const fileContent = read_file({ target_file: 'src/App.tsx' });

// 3. Claude uses result immediately
// File content is available for Claude to analyze and respond

// 4. If needed, Claude can make more tool calls
write({
  file_path: 'src/App.tsx',
  contents: modifiedContent
});

// 5. Claude responds to user
```

---

## Architecture Diagrams

### Aurora Agent Tools Flow

```
┌─────────────┐
│ User Input  │
└──────┬──────┘
       │
       ▼
┌─────────────────┐
│ Agent Service   │
│ (agent-service) │
└──────┬──────────┘
       │
       ▼
┌─────────────────┐      ┌──────────────────┐
│ LLM Provider    │─────▶│ LLM API          │
│ (llm-provider)  │      │ (with tools)     │
└──────┬──────────┘      └────────┬─────────┘
       │                            │
       │                            ▼
       │                    ┌──────────────┐
       │                    │ Tool Calls   │
       │                    │ Response     │
       │                    └──────┬───────┘
       │                           │
       ▼                           ▼
┌─────────────────┐      ┌─────────────────┐
│ Approval Check  │      │ Tool Registry   │
│ (if needed)     │      │ (registry.ts)   │
└──────┬──────────┘      └──────┬──────────┘
       │                         │
       │                         ▼
       │                 ┌─────────────────┐
       │                 │ Tool Executor   │
       │                 │ (executors/*)    │
       │                 └──────┬──────────┘
       │                         │
       │                         ▼
       │                 ┌─────────────────┐
       │                 │ Tauri Commands  │
       │                 │ (Rust backend)  │
       │                 └──────┬──────────┘
       │                         │
       │                         ▼
       │                 ┌─────────────────┐
       │                 │ File System     │
       │                 └─────────────────┘
       │                         │
       └─────────────────────────┘
                 │
                 ▼
         ┌───────────────┐
         │ Result to LLM │
         │ (next iter)    │
         └───────────────┘
```

### Cursor Tools Flow

```
┌─────────────┐
│ User Query  │
└──────┬──────┘
       │
       ▼
┌─────────────┐
│   Claude    │
│  (decides)  │
└──────┬──────┘
       │
       ▼
┌─────────────┐
│ Tool Call   │
│ (direct)    │
└──────┬──────┘
       │
       ▼
┌─────────────┐
│ File System │
│ / Codebase  │
└──────┬──────┘
       │
       ▼
┌─────────────┐
│   Result    │
└──────┬──────┘
       │
       ▼
┌─────────────┐
│   Claude    │
│ (responds)  │
└─────────────┘
```

---

## Conclusion

**Aurora Agent Tools** are designed for an **autonomous AI agent** that works iteratively with user oversight. They provide safety through approval workflows and enable complex multi-step operations.

**Cursor Tools** are designed for **direct AI assistance** where speed and immediacy are prioritized. They enable quick code operations without approval workflows.

Both systems serve different purposes:
- **Aurora**: Production-ready AI agent with safety controls
- **Cursor**: Development assistant for rapid iteration

Understanding both systems helps you leverage the right tool for the right job!

