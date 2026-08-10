/**
 * Tools Module (post-Rust-migration)
 * ==================================
 *
 * Tool definitions for the LLM. Executors live in the Rust runtime;
 * this module only exposes:
 *   - Tool definition catalogue (`getToolsForModel`)
 *   - Risk-level metadata (`toolRequiresApproval`, `getRiskLevel` via registry)
 *   - The frontend-side `toolRegistry` for UI tracking
 *
 * Removed (pure dead weight after Rust migration):
 *   - `executeToolCall` — every native tool dispatches in Rust now
 *   - `formatToolsForRequest` — `agent-service` builds its own tool array
 *   - `registerAllExecutors` / `areExecutorsRegistered` — no executors to wire
 */
import { allTools, getToolByName, getToolRiskLevel, toolCategories } from "./definitions";
import { toolRegistry } from "./registry";
import type { ToolDefinition } from "./types";

/** All tool definitions for sending to the AI model. */
export const getToolsForModel = (): ToolDefinition[] => {
  return toolRegistry.getToolDefinitions();
};

/** Whether a given tool requires human approval (risk-level driven). */
export const toolRequiresApproval = (toolName: string): boolean => {
  const tool = toolRegistry.getTool(toolName);
  return tool?.requiresApproval ?? true;
};

export * from "./types";
export * from "./definitions";
export { toolRegistry, ToolRegistry } from "./registry";
export { operationLog, FsOperationType } from "./operation-log";
export type { FsOperation, OperationSummary } from "./operation-log";

export default {
  registry: toolRegistry,
  allTools,
  getToolByName,
  getToolRiskLevel,
  toolCategories,
  getToolsForModel,
  toolRequiresApproval,
};
