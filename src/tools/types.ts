/**
 * Tool Types - OpenAI Compatible Tool Definitions
 * Based on GLM-4.7 API specification
 */

// Property definition for function parameters
export interface PropertyDefinition {
  type: string;
  description?: string;
  enum?: string[];
  items?: PropertyDefinition | { type: string; properties?: Record<string, PropertyDefinition>; required?: string[] };
  properties?: Record<string, PropertyDefinition>;
  required?: string[];
  default?: unknown;
}

// OpenAI-compatible function parameter schema
export interface FunctionParameters {
  type: 'object';
  properties: Record<string, PropertyDefinition>;
  required: string[];
}

// OpenAI-compatible function definition
export interface FunctionDefinition {
  name: string;
  description: string;
  parameters: FunctionParameters;
}

// OpenAI-compatible tool schema
export interface ToolDefinition {
  type: 'function';
  function: FunctionDefinition;
}

// Tool call from the model
export interface ToolCallRequest {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string; // JSON string
  };
}

// Tool execution result
export interface ToolCallResult {
  tool_call_id: string;
  role: 'tool';
  content: string; // JSON string or plain text result
}

// Tool execution status
export type ToolStatus = 'pending' | 'executing' | 'complete' | 'failed';

// Internal tool call tracking
export interface TrackedToolCall {
  id: string;
  name: string;
  args: Record<string, any>;
  status: ToolStatus;
  result?: string;
  error?: string;
  startTime: number;
  endTime?: number;
}

// Tool executor function type
export type ToolExecutor<T = Record<string, any>> = (args: T, toolCallId?: string) => Promise<string>;

// Tool registry entry
export interface RegisteredTool {
  definition: ToolDefinition;
  executor: ToolExecutor;
  requiresApproval: boolean;
  riskLevel: 'low' | 'medium' | 'high';
}

