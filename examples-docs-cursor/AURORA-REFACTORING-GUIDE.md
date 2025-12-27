# Aurora Agent Refactoring Guide: Cursor-Style Direct Execution

This document outlines how to refactor Aurora's tooling architecture to work like Cursor tools - with direct execution, full context awareness, and operation logging.

---

## Table of Contents

- [Architecture Overview](#architecture-overview)
- [New Components](#new-components)
- [Operation Logging System](#operation-logging-system)
- [Direct Agent Mode](#direct-agent-mode)
- [Tool Execution Flow](#tool-execution-flow)
- [Code Examples](#code-examples)
- [Migration Path](#migration-path)

---

## Architecture Overview

### Current Architecture (LLM-Driven)

```
User Message
    ↓
Agent Service → LLM API (with tools)
    ↓
LLM decides tool calls
    ↓
Tool Registry → Executor → Tauri
    ↓
Result back to LLM → Next iteration
```

### New Architecture (Hybrid: Direct + LLM)

```
User Message
    ↓
┌─────────────────────────────────────┐
│  Direct Agent Mode (NEW)            │
│  - Reads files directly              │
│  - Plans complete solution           │
│  - Executes tools directly           │
│  - Full context awareness            │
└──────────────┬──────────────────────┘
               │
               ▼
┌─────────────────────────────────────┐
│  Operation Logging (NEW)            │
│  - Tracks all file operations       │
│  - Enforces read-before-edit        │
│  - Provides audit trail             │
└──────────────┬──────────────────────┘
               │
               ▼
┌─────────────────────────────────────┐
│  Tool Registry (ENHANCED)           │
│  - Direct execution mode            │
│  - Preview mode                      │
│  - Operation logging integration    │
└──────────────┬──────────────────────┘
               │
               ▼
┌─────────────────────────────────────┐
│  LLM Mode (KEPT)                    │
│  - For complex reasoning            │
│  - When user prefers LLM           │
└─────────────────────────────────────┘
```

---

## New Components

### 1. Operation Logging System

**File:** `src/tools/operation-log.ts`

```typescript
/**
 * Operation Logging System
 * Tracks all file system operations and enforces safety rules
 */

export enum FsOperationType {
  Read = 'read',
  Write = 'write',
  Edit = 'edit',
  Delete = 'delete',
  Create = 'create',
}

export interface FsOperation {
  type: FsOperationType;
  path: string;
  timestamp: number;
  metadata?: Record<string, any>;
}

export class FsOperationLog {
  private operations: FsOperation[] = [];
  private readFiles: Set<string> = new Set();
  
  /**
   * Log a file operation
   */
  logOperation(
    type: FsOperationType,
    path: string,
    metadata?: Record<string, any>
  ): void {
    const operation: FsOperation = {
      type,
      path,
      timestamp: Date.now(),
      metadata,
    };
    
    this.operations.push(operation);
    
    // Track reads separately for validation
    if (type === FsOperationType.Read) {
      this.readFiles.add(path);
    }
  }
  
  /**
   * Check if a file has been read
   */
  hasBeenRead(path: string): boolean {
    return this.readFiles.has(path);
  }
  
  /**
   * Validate that a file can be edited (must have been read first)
   */
  validateEditPermission(path: string): void {
    if (!this.hasBeenRead(path)) {
      throw new Error(
        `Cannot edit file '${path}': The file must be read first using the read tool before it can be edited.`
      );
    }
  }
  
  /**
   * Get all operations for a file
   */
  getFileOperations(path: string): FsOperation[] {
    return this.operations.filter(op => op.path === path);
  }
  
  /**
   * Get summary statistics
   */
  getSummary() {
    return {
      totalOperations: this.operations.length,
      readCount: this.operations.filter(op => op.type === FsOperationType.Read).length,
      writeCount: this.operations.filter(op => op.type === FsOperationType.Write).length,
      editCount: this.operations.filter(op => op.type === FsOperationType.Edit).length,
      uniqueFilesRead: this.readFiles.size,
    };
  }
  
  /**
   * Clear the log
   */
  clear(): void {
    this.operations = [];
    this.readFiles.clear();
  }
}

// Singleton instance
export const operationLog = new FsOperationLog();
```

---

### 2. Direct Agent Service

**File:** `src/services/direct-agent-service.ts`

```typescript
/**
 * Direct Agent Service
 * Executes tools directly with full context awareness (like Cursor)
 */

import { toolRegistry } from '../tools/registry';
import { operationLog, FsOperationType } from '../tools/operation-log';
import type { ToolCallRequest, ToolCallResult } from '../tools/types';
import { readFileContent } from '../lib/tauri';
import { codebase_search } from '../tools/utils/search';

export interface DirectAgentConfig {
  enableOperationLogging: boolean;
  requireReadBeforeEdit: boolean;
  enablePreview: boolean;
}

export class DirectAgentService {
  private config: DirectAgentConfig;
  private contextCache: Map<string, string> = new Map();
  
  constructor(config?: Partial<DirectAgentConfig>) {
    this.config = {
      enableOperationLogging: true,
      requireReadBeforeEdit: true,
      enablePreview: false,
      ...config,
    };
  }
  
  /**
   * Execute a tool call directly (like Cursor)
   */
  async executeTool(
    toolName: string,
    args: Record<string, any>
  ): Promise<ToolCallResult> {
    const tool = toolRegistry.getTool(toolName);
    
    if (!tool) {
      return {
        tool_call_id: 'direct',
        role: 'tool',
        content: JSON.stringify({ error: `Unknown tool: ${toolName}` }),
      };
    }
    
    // Validate operation if needed
    if (this.config.requireReadBeforeEdit && toolName === 'file_edit') {
      try {
        operationLog.validateEditPermission(args.path);
      } catch (error) {
        return {
          tool_call_id: 'direct',
          role: 'tool',
          content: JSON.stringify({ error: (error as Error).message }),
        };
      }
    }
    
    // Execute tool
    try {
      const result = await tool.executor(args);
      
      // Log operation
      if (this.config.enableOperationLogging) {
        this.logOperation(toolName, args, result);
      }
      
      // Cache file content for context
      if (toolName === 'file_read') {
        this.contextCache.set(args.path, result);
      }
      
      return {
        tool_call_id: 'direct',
        role: 'tool',
        content: result,
      };
    } catch (error) {
      return {
        tool_call_id: 'direct',
        role: 'tool',
        content: JSON.stringify({
          error: error instanceof Error ? error.message : String(error),
        }),
      };
    }
  }
  
  /**
   * Read multiple files simultaneously (like Cursor)
   */
  async readFiles(paths: string[]): Promise<Map<string, string>> {
    const results = new Map<string, string>();
    
    // Read all files in parallel
    const promises = paths.map(async (path) => {
      const result = await this.executeTool('file_read', { path });
      if (result.content) {
        try {
          const parsed = JSON.parse(result.content);
          results.set(path, parsed.content || result.content);
        } catch {
          results.set(path, result.content);
        }
      }
    });
    
    await Promise.all(promises);
    return results;
  }
  
  /**
   * Search codebase semantically (like Cursor)
   */
  async searchCodebase(query: string, directories?: string[]): Promise<string[]> {
    // Use codebase_search utility
    // This would need to be implemented
    return [];
  }
  
  /**
   * Plan and execute a complete refactor
   */
  async executeRefactor(
    task: string,
    onProgress?: (step: string) => void
  ): Promise<{ success: boolean; changes: string[] }> {
    const changes: string[] = [];
    
    // Step 1: Understand the task
    onProgress?.('Understanding task...');
    const relatedFiles = await this.searchCodebase(task);
    
    // Step 2: Read all related files
    onProgress?.('Reading related files...');
    const fileContents = await this.readFiles(relatedFiles);
    
    // Step 3: Plan changes
    onProgress?.('Planning changes...');
    // Analyze fileContents and plan changes
    
    // Step 4: Execute changes
    onProgress?.('Executing changes...');
    // Execute planned changes
    
    // Step 5: Verify
    onProgress?.('Verifying changes...');
    // Check for errors
    
    return { success: true, changes };
  }
  
  /**
   * Log operation
   */
  private logOperation(
    toolName: string,
    args: Record<string, any>,
    result: string
  ): void {
    const operationTypeMap: Record<string, FsOperationType> = {
      file_read: FsOperationType.Read,
      file_write: FsOperationType.Write,
      file_edit: FsOperationType.Edit,
      file_delete: FsOperationType.Delete,
      file_create: FsOperationType.Create,
    };
    
    const operationType = operationTypeMap[toolName];
    if (operationType && args.path) {
      operationLog.logOperation(operationType, args.path, {
        toolName,
        args,
        resultLength: result.length,
      });
    }
  }
  
  /**
   * Get context for a file (cached or read)
   */
  async getFileContext(path: string): Promise<string | null> {
    if (this.contextCache.has(path)) {
      return this.contextCache.get(path)!;
    }
    
    const result = await this.executeTool('file_read', { path });
    if (result.content) {
      try {
        const parsed = JSON.parse(result.content);
        const content = parsed.content || result.content;
        this.contextCache.set(path, content);
        return content;
      } catch {
        return result.content;
      }
    }
    
    return null;
  }
  
  /**
   * Clear context cache
   */
  clearCache(): void {
    this.contextCache.clear();
  }
}
```

---

### 3. Enhanced Tool Registry with Preview

**File:** `src/tools/registry.ts` (Enhanced)

```typescript
/**
 * Enhanced Tool Registry with Preview Mode
 */

import { operationLog } from './operation-log';

export interface ToolPreview {
  preview: string;
  metadata?: Record<string, any>;
}

export interface RegisteredTool {
  definition: ToolDefinition;
  executor: ToolExecutor;
  previewExecutor?: (args: Record<string, any>) => Promise<ToolPreview>;
  requiresApproval: boolean;
  riskLevel: 'low' | 'medium' | 'high';
}

class ToolRegistry {
  // ... existing code ...
  
  /**
   * Execute tool with preview support
   */
  async executeToolCallWithPreview(
    toolCall: ToolCallRequest,
    preview: boolean = false
  ): Promise<ToolCallResult | ToolPreview> {
    const tool = this.tools.get(toolCall.function.name);
    
    if (!tool) {
      return {
        tool_call_id: toolCall.id,
        role: 'tool',
        content: JSON.stringify({ error: `Unknown tool: ${toolCall.function.name}` }),
      };
    }
    
    // Parse arguments
    const args = JSON.parse(toolCall.function.arguments);
    
    // If preview mode and preview executor exists
    if (preview && tool.previewExecutor) {
      const previewResult = await tool.previewExecutor(args);
      return previewResult;
    }
    
    // Normal execution
    return this.executeToolCall(toolCall);
  }
  
  /**
   * Register a tool with preview support
   */
  registerToolWithPreview(
    name: string,
    executor: ToolExecutor,
    previewExecutor: (args: Record<string, any>) => Promise<ToolPreview>
  ): void {
    const tool = this.tools.get(name);
    if (tool) {
      tool.previewExecutor = previewExecutor;
    }
  }
}
```

---

### 4. Enhanced File Executors with Operation Logging

**File:** `src/tools/executors/file-executors.ts` (Enhanced)

```typescript
/**
 * Enhanced File Executors with Operation Logging
 */

import { operationLog, FsOperationType } from '../operation-log';
import { toolRegistry } from '../registry';

// ============================================
// FILE READ EXECUTOR (Enhanced)
// ============================================
const fileReadExecutor = async (args: Record<string, any>): Promise<string> => {
  if (!isTauri()) {
    return JSON.stringify({
      success: false,
      error: "File operations require desktop app",
    });
  }

  const fullPath = resolvePath(args.path);
  
  try {
    const content = await readFileContent(fullPath);
    
    // Log the read operation
    operationLog.logOperation(FsOperationType.Read, args.path, {
      fullPath,
      lineCount: content.split('\n').length,
      size: content.length,
    });
    
    return JSON.stringify({
      success: true,
      path: args.path,
      fullPath,
      content,
      lines: content.split('\n').length,
    });
  } catch (error) {
    return JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

// ============================================
// FILE WRITE EXECUTOR (Enhanced with Preview)
// ============================================
const fileWriteExecutor = async (args: Record<string, any>): Promise<string> => {
  if (!isTauri()) {
    return JSON.stringify({
      success: false,
      error: "File operations require desktop app",
    });
  }

  const fullPath = resolvePath(args.path);
  
  // Check if file exists (for overwrite warning)
  const fileExists = await fileExistsExecutor({ path: args.path });
  const exists = JSON.parse(fileExists).exists;
  
  // If overwriting, check if file was read first
  if (exists) {
    if (!operationLog.hasBeenRead(args.path)) {
      return JSON.stringify({
        success: false,
        error: `Cannot overwrite file '${args.path}': The file must be read first using the read tool before it can be overwritten.`,
        warning: 'This is a safety measure to prevent accidental overwrites.',
      });
    }
  }
  
  try {
    const processedContent = processEscapeSequences(args.content);
    await writeFileContent(fullPath, processedContent);
    
    // Log the write operation
    operationLog.logOperation(FsOperationType.Write, args.path, {
      fullPath,
      action: exists ? 'updated' : 'created',
      bytes: args.content.length,
      lines: processedContent.split('\n').length,
    });
    
    triggerRefresh();
    
    return JSON.stringify({
      success: true,
      message: `File ${exists ? 'updated' : 'created'}: ${args.path}`,
      path: args.path,
      fullPath,
      bytes: args.content.length,
    });
  } catch (error) {
    return JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

// Preview executor for write
const fileWritePreviewExecutor = async (
  args: Record<string, any>
): Promise<ToolPreview> => {
  const fullPath = resolvePath(args.path);
  const fileExists = await fileExistsExecutor({ path: args.path });
  const exists = JSON.parse(fileExists).exists;
  
  return {
    preview: exists
      ? `Will overwrite file: ${args.path}\n\nContent preview:\n${args.content.substring(0, 500)}${args.content.length > 500 ? '...' : ''}`
      : `Will create new file: ${args.path}\n\nContent preview:\n${args.content.substring(0, 500)}${args.content.length > 500 ? '...' : ''}`,
    metadata: {
      path: args.path,
      fullPath,
      action: exists ? 'overwrite' : 'create',
      contentLength: args.content.length,
      lineCount: args.content.split('\n').length,
    },
  };
};

// ============================================
// FILE EDIT EXECUTOR (Enhanced with Validation)
// ============================================
const fileEditExecutor = async (args: Record<string, any>): Promise<string> => {
  if (!isTauri()) {
    return JSON.stringify({
      success: false,
      error: "File operations require desktop app",
    });
  }

  const fullPath = resolvePath(args.path);
  
  // Validate: file must have been read first
  try {
    operationLog.validateEditPermission(args.path);
  } catch (error) {
    return JSON.stringify({
      success: false,
      error: (error as Error).message,
    });
  }
  
  try {
    const existingContent = await readFileContent(fullPath);
    const lines = existingContent.split("\n");

    const startIdx = Math.max(0, (args.start_line || 1) - 1);
    const endIdx = Math.min(lines.length, args.end_line || args.start_line);

    const newLines = (args.content || "").split("\n");
    const patchedLines = [
      ...lines.slice(0, startIdx),
      ...newLines,
      ...lines.slice(endIdx),
    ];

    const patchedContent = patchedLines.join("\n");
    await writeFileContent(fullPath, patchedContent);
    
    // Log the edit operation
    operationLog.logOperation(FsOperationType.Edit, args.path, {
      fullPath,
      linesReplaced: endIdx - startIdx,
      linesInserted: newLines.length,
      startLine: args.start_line,
      endLine: args.end_line,
    });
    
    triggerRefresh();

    return JSON.stringify({
      success: true,
      message: `File edited: ${args.path}`,
      path: args.path,
      fullPath,
      linesReplaced: endIdx - startIdx,
      linesInserted: newLines.length,
    });
  } catch (error) {
    return JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

// Preview executor for edit
const fileEditPreviewExecutor = async (
  args: Record<string, any>
): Promise<ToolPreview> => {
  const fullPath = resolvePath(args.path);
  
  // Validate read permission
  try {
    operationLog.validateEditPermission(args.path);
  } catch (error) {
    return {
      preview: `Error: ${(error as Error).message}`,
      metadata: { error: true },
    };
  }
  
  // Read file and generate diff preview
  const existingContent = await readFileContent(fullPath);
  const lines = existingContent.split("\n");
  const startIdx = Math.max(0, (args.start_line || 1) - 1);
  const endIdx = Math.min(lines.length, args.end_line || args.start_line);
  
  const oldLines = lines.slice(startIdx, endIdx);
  const newLines = (args.content || "").split("\n");
  
  // Generate simple diff preview
  const diffPreview = [
    `--- ${args.path} (lines ${startIdx + 1}-${endIdx})`,
    `+++ ${args.path} (new content)`,
    ...oldLines.map((line, i) => `-${startIdx + i + 1}: ${line}`),
    ...newLines.map((line, i) => `+${startIdx + i + 1}: ${line}`),
  ].join('\n');
  
  return {
    preview: diffPreview,
    metadata: {
      path: args.path,
      fullPath,
      linesReplaced: endIdx - startIdx,
      linesInserted: newLines.length,
    },
  };
};

// ============================================
// REGISTER ALL FILE EXECUTORS (Enhanced)
// ============================================
export const registerFileExecutors = (): void => {
  toolRegistry.registerExecutor("file_read", fileReadExecutor);
  toolRegistry.registerExecutor("file_write", fileWriteExecutor);
  toolRegistry.registerExecutor("file_edit", fileEditExecutor);
  // ... other executors ...
  
  // Register preview executors
  toolRegistry.registerToolWithPreview(
    "file_write",
    fileWriteExecutor,
    fileWritePreviewExecutor
  );
  toolRegistry.registerToolWithPreview(
    "file_edit",
    fileEditExecutor,
    fileEditPreviewExecutor
  );
};
```

---

## Tool Execution Flow

### New Flow: Direct Execution Mode

```
User: "Refactor Button component to TypeScript"

┌─────────────────────────────────────┐
│  Direct Agent Service               │
│  1. Search for Button component    │
│  2. Read Button.jsx                │
│  3. Read all files that import it  │
│  4. Understand full context         │
└──────────────┬──────────────────────┘
               │
               ▼
┌─────────────────────────────────────┐
│  Operation Log                      │
│  - Logs: Read Button.jsx            │
│  - Logs: Read imports               │
│  - Tracks: Button.jsx read          │
└──────────────┬──────────────────────┘
               │
               ▼
┌─────────────────────────────────────┐
│  Plan Complete Refactor             │
│  - Create Button.tsx                │
│  - Update all imports               │
│  - Delete Button.jsx                │
└──────────────┬──────────────────────┘
               │
               ▼
┌─────────────────────────────────────┐
│  Execute All Changes                │
│  1. Write Button.tsx (preview)      │
│  2. User approves                   │
│  3. Write Button.tsx                │
│  4. Update imports (preview)         │
│  5. User approves                   │
│  6. Update imports                  │
│  7. Delete Button.jsx               │
└──────────────┬──────────────────────┘
               │
               ▼
┌─────────────────────────────────────┐
│  Verify Changes                     │
│  - Check for errors                 │
│  - Verify imports work              │
└─────────────────────────────────────┘
```

---

## Code Examples

### Example 1: Direct Tool Execution

```typescript
// New usage in ChatPanel.tsx
import { DirectAgentService } from '../services/direct-agent-service';

const directAgent = new DirectAgentService({
  enableOperationLogging: true,
  requireReadBeforeEdit: true,
  enablePreview: true,
});

// Execute a tool directly (like Cursor)
const result = await directAgent.executeTool('file_read', {
  path: 'src/components/Button.tsx',
});

// Read multiple files simultaneously
const files = await directAgent.readFiles([
  'src/components/Button.tsx',
  'src/components/Button.test.tsx',
  'src/types/components.ts',
]);

// All files read in parallel - full context!
```

### Example 2: Complete Refactor with Context

```typescript
// Refactor component with full context awareness
async function refactorComponent(componentName: string) {
  // Step 1: Find all related files
  const relatedFiles = await directAgent.searchCodebase(
    `Where is ${componentName} component used?`
  );
  
  // Step 2: Read all files simultaneously
  const fileContents = await directAgent.readFiles([
    `src/components/${componentName}.jsx`,
    ...relatedFiles,
  ]);
  
  // Step 3: Plan changes with full context
  const changes = planRefactor(fileContents, componentName);
  
  // Step 4: Execute all changes
  for (const change of changes) {
    // Preview first
    if (change.type === 'write' || change.type === 'edit') {
      const preview = await toolRegistry.executeToolCallWithPreview(
        {
          id: 'preview',
          type: 'function',
          function: {
            name: change.tool,
            arguments: JSON.stringify(change.args),
          },
        },
        true // preview mode
      );
      
      // Show preview to user
      const approved = await showPreviewAndGetApproval(preview);
      if (!approved) continue;
    }
    
    // Execute
    await directAgent.executeTool(change.tool, change.args);
  }
  
  // Step 5: Verify
  const errors = await checkForErrors();
  return { success: errors.length === 0, errors };
}
```

### Example 3: Operation Log Usage

```typescript
// Check operation history
const summary = operationLog.getSummary();
console.log(`Read ${summary.readCount} files`);
console.log(`Edited ${summary.editCount} files`);

// Get operations for a specific file
const operations = operationLog.getFileOperations('src/App.tsx');
// Returns: [{ type: 'read', path: '...', timestamp: ... }, ...]

// Validate before editing
try {
  operationLog.validateEditPermission('src/App.tsx');
  // Safe to edit
} catch (error) {
  // Must read first
  console.error(error.message);
}
```

---

## Migration Path

### Phase 1: Add Operation Logging (Week 1)

1. Create `src/tools/operation-log.ts`
2. Integrate into existing file executors
3. Add logging calls to all file operations
4. Test with existing tools

### Phase 2: Add Direct Agent Service (Week 2)

1. Create `src/services/direct-agent-service.ts`
2. Implement `executeTool` method
3. Implement `readFiles` (parallel reading)
4. Add context caching

### Phase 3: Add Preview Mode (Week 3)

1. Enhance `ToolRegistry` with preview support
2. Add preview executors for write/edit tools
3. Update UI to show previews
4. Add approval workflow with preview

### Phase 4: Add Search Utilities (Week 4)

1. Implement `codebase_search` utility
2. Add semantic search capabilities
3. Integrate with Direct Agent Service

### Phase 5: Hybrid Mode (Week 5)

1. Add mode selection (Direct vs LLM)
2. Update UI to allow mode switching
3. Test both modes
4. Document usage

---

## Configuration

### Settings Panel Enhancement

```typescript
// src/components/modals/SettingsPanel.tsx

interface AgentModeSettings {
  mode: 'direct' | 'llm' | 'hybrid';
  enableOperationLogging: boolean;
  requireReadBeforeEdit: boolean;
  enablePreview: boolean;
  autoApproveLowRisk: boolean;
}

// Add to settings store
const agentModeSettings: AgentModeSettings = {
  mode: 'direct', // Default to direct mode
  enableOperationLogging: true,
  requireReadBeforeEdit: true,
  enablePreview: true,
  autoApproveLowRisk: false,
};
```

---

## Benefits of New Architecture

### 1. **Context Awareness** (Like Cursor)
- ✅ Read multiple files simultaneously
- ✅ Understand full codebase structure
- ✅ Plan complete solutions
- ✅ See relationships between files

### 2. **Robustness** (Like Shai)
- ✅ Operation logging
- ✅ Read-before-edit enforcement
- ✅ Preview mode
- ✅ Audit trail

### 3. **Speed** (Like Cursor)
- ✅ Direct execution
- ✅ Parallel file reading
- ✅ No iteration delays
- ✅ Immediate results

### 4. **Safety** (Like Shai + Aurora)
- ✅ Operation logging
- ✅ Preview before changes
- ✅ Approval workflow
- ✅ Risk levels

---

## Example: Complete Refactor Flow

```typescript
// User: "Refactor Button component to TypeScript"

// Step 1: Direct Agent reads all related files
const files = await directAgent.readFiles([
  'src/components/Button.jsx',
  'src/components/Button.test.jsx',
  'src/App.tsx', // imports Button
  'src/pages/Home.tsx', // imports Button
]);

// Step 2: Plan complete refactor
const plan = {
  create: 'src/components/Button.tsx',
  update: [
    { file: 'src/App.tsx', import: 'Button' },
    { file: 'src/pages/Home.tsx', import: 'Button' },
  ],
  delete: 'src/components/Button.jsx',
};

// Step 3: Execute with previews
for (const change of plan.update) {
  // Preview import change
  const preview = await toolRegistry.executeToolCallWithPreview({
    id: 'preview',
    type: 'function',
    function: {
      name: 'file_edit',
      arguments: JSON.stringify({
        path: change.file,
        old_string: `import Button from './components/Button'`,
        new_string: `import Button from './components/Button'`, // Same import, but file is .tsx now
      }),
    },
  }, true);
  
  // User sees preview and approves
  if (await showPreview(preview)) {
    await directAgent.executeTool('file_edit', {
      path: change.file,
      old_string: `import Button from './components/Button'`,
      new_string: `import Button from './components/Button'`,
    });
  }
}

// Step 4: Verify
const errors = await checkLinting();
// All done in 1-2 minutes instead of 5-10!
```

---

## Summary

This refactoring transforms Aurora from an **LLM-driven iterative system** to a **hybrid system** that combines:

1. **Cursor's direct execution** - Fast, context-aware
2. **Shai's robustness** - Operation logging, preview mode
3. **Aurora's control** - Approval workflow, risk levels

**Result:** Best of all three worlds! 🚀

