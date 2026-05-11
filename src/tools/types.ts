/**
 * Tool Types - OpenAI Compatible Tool Definitions
 * Based on GLM-4.7 API specification
 */

// Property definition for function parameters
// OpenAI-compatible function definition
export interface FunctionDefinition {
  description: string;
  name: string;
  parameters: FunctionParameters;
}

// OpenAI-compatible function parameter schema
export interface FunctionParameters {
  properties: Record<string, PropertyDefinition>;
  required: string[];
  type: 'object';
}

export interface PropertyDefinition {
  default?: unknown;
  description?: string;
  enum?: string[];
  items?: PropertyDefinition | { type: string; properties?: Record<string, PropertyDefinition>; required?: string[] };
 properties?: Record<string, PropertyDefinition>;
  required?: string[];
  type: string;
}

// Tool registry entry — frontend metadata only. Executors live in
// the Rust ToolRegistry; this struct just carries the OpenAI-shaped
// definition + risk metadata for UI decoration.
export interface RegisteredTool {
  definition: ToolDefinition;
  requiresApproval: boolean;
  riskLevel: 'low' | 'medium' | 'high';
}

// Tool call from the model
export interface ToolCallRequest {
  function: {
    name: string;
    arguments: string; // JSON string
  };
  id: string;
  type: 'function';
}

// Tool execution result
export interface ToolCallResult {
  content: string; // JSON string or plain text result
  role: 'tool';
  tool_call_id: string;
}

// OpenAI-compatible tool schema
export interface ToolDefinition {
  function: FunctionDefinition;
  type: 'function';
  /**
   * Phase 3 (Sub-E §8 frontend bridge slim): set to `true` for tools
   * whose canonical implementation lives in the Rust ToolRegistry
   * (file ops, workspace ops, shell, editor IPC, search, todo, …).
   * Phase 3 expects every Rust-owned tool to short-circuit on the
   * Rust side; if one falls through to the TypeScript bridge,
   * `agent-runtime-client.ts::dispatchToolPending` logs a warning
   * before defensively dispatching through `AgentToolRunner`.
   *
   * Defaults to `false` / `undefined` for tools that legitimately
   * require frontend-only execution (MCP tools, anything that needs
   * the Monaco editor instance, browser preview, …).
   */
  nativeRustOwned?: boolean;
}

// Internal tool call tracking
export interface TrackedToolCall {
  args: Record<string, any>;
  endTime?: number;
  error?: string;
  id: string;
  name: string;
  result?: string;
  startTime: number;
  status: ToolStatus;
}

// Tool execution status
export type ToolStatus = 'pending' | 'executing' | 'complete' | 'failed';
