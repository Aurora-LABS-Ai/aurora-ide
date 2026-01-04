/**
 * Tools Module
 * 
 * This module provides a modular tool system for the AI agent.
 * Tools are OpenAI-compatible function definitions that can be executed by the agent.
 * 
 * Structure:
 * - types.ts: Type definitions for tools
 * - definitions/: Tool definitions organized by category
 * - registry.ts: Central registry for tool management
 * - executors/: Tool executor implementations (to be implemented)
 * 
 * Usage:
 * 1. Import tool definitions for sending to the AI model
 * 2. Register executors for tools that need to be executed
 * 3. Use the registry to execute tool calls from the model
 */

// Export types
import { allTools, getToolByName, getToolRiskLevel, toolCategories } from "./definitions";
// Re-export commonly used items
import { toolRegistry } from "./registry";
import type { ToolCallRequest, ToolCallResult, ToolDefinition } from "./types";

/**
 * Execute a tool call from the AI model
 */
export const executeToolCall = async (toolCall: ToolCallRequest): Promise<ToolCallResult> => {
  return toolRegistry.executeToolCall(toolCall);
};

/**
 * Format tools for OpenAI API request
 */
export const formatToolsForRequest = (tools?: ToolDefinition[]): ToolDefinition[] => {
  return tools || allTools;
};

/**
 * Get all tool definitions for sending to the AI model
 */
export const getToolsForModel = (): ToolDefinition[] => {
  return toolRegistry.getToolDefinitions();
};

/**
 * Check if a tool requires user approval before execution
 */
export const toolRequiresApproval = (toolName: string): boolean => {
  return toolRegistry.requiresApproval(toolName);
};

export * from './types';

// Export definitions
export * from './definitions';

// Export registry
export { toolRegistry, ToolRegistry } from './registry';

// Export executors
export { registerAllExecutors, areExecutorsRegistered } from './executors';

// Export operation log
export { operationLog, FsOperationType } from './operation-log';

export type { FsOperation, OperationSummary } from './operation-log';

// Default export for convenience
export default {
  registry: toolRegistry,
  allTools,
  getToolByName,
  getToolRiskLevel,
  toolCategories,
  getToolsForModel,
  executeToolCall,
  toolRequiresApproval,
};
