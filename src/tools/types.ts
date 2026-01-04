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

// Tool registry entry
export interface RegisteredTool {
  definition: ToolDefinition;
  executor: ToolExecutor;
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

// Tool executor function type
export type ToolExecutor<T = Record<string, any>> = (args: T, toolCallId?: string) => Promise<string>;

// Tool execution status
export type ToolStatus = 'pending' | 'executing' | 'complete' | 'failed';
