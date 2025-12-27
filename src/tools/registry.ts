/**
 * Tool Registry
 * Central registry for managing tool definitions and executors
 */

import type {
  ToolDefinition,
  ToolExecutor,
  RegisteredTool,
  ToolCallRequest,
  ToolCallResult,
  TrackedToolCall
} from './types';
import { allTools } from './definitions';
import { getEnhancedToolRiskLevel } from './definitions/risk-levels-enhanced';

class ToolRegistry {
  private tools: Map<string, RegisteredTool> = new Map();
  private activeToolCalls: Map<string, TrackedToolCall> = new Map();

  constructor() {
    // Register all tool definitions (executors will be added later)
    this.registerAllDefinitions();
  }

  /**
   * Register all tool definitions from the definitions module
   */
  private registerAllDefinitions(): void {
    for (const tool of allTools) {
      this.registerDefinition(tool);
    }
  }

  /**
   * Register a tool definition without an executor
   */
  registerDefinition(definition: ToolDefinition): void {
    const name = definition.function.name;
    const riskLevel = getEnhancedToolRiskLevel(name);

    this.tools.set(name, {
      definition,
      executor: async () => {
        throw new Error(`Executor not implemented for tool: ${name}`);
      },
      requiresApproval: riskLevel === 'high', // Only HIGH risk requires approval
      riskLevel,
    });
  }

  /**
   * Register an executor for a tool
   */
  registerExecutor(name: string, executor: ToolExecutor): void {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new Error(`Tool not found: ${name}`);
    }
    tool.executor = executor;
  }

  /**
   * Get a tool by name
   */
  getTool(name: string): RegisteredTool | undefined {
    return this.tools.get(name);
  }

  /**
   * Get all registered tools
   */
  getAllTools(): RegisteredTool[] {
    return Array.from(this.tools.values());
  }

  /**
   * Get all tool definitions (for sending to the AI model)
   */
  getToolDefinitions(): ToolDefinition[] {
    return Array.from(this.tools.values()).map(t => t.definition);
  }

  /**
   * Check if a tool requires approval
   */
  requiresApproval(name: string): boolean {
    const tool = this.tools.get(name);
    return tool?.requiresApproval ?? true;
  }

  /**
   * Get the risk level of a tool
   */
  getRiskLevel(name: string): 'low' | 'medium' | 'high' {
    const tool = this.tools.get(name);
    return tool?.riskLevel ?? 'medium';
  }

  /**
   * Execute a tool call
   */
  async executeToolCall(toolCall: ToolCallRequest): Promise<ToolCallResult> {
    const tool = this.tools.get(toolCall.function.name);
    
    if (!tool) {
      return {
        tool_call_id: toolCall.id,
        role: 'tool',
        content: JSON.stringify({ error: `Unknown tool: ${toolCall.function.name}` }),
      };
    }

    // Parse arguments
    let args: Record<string, any>;
    try {
      args = JSON.parse(toolCall.function.arguments);
    } catch (e) {
      return {
        tool_call_id: toolCall.id,
        role: 'tool',
        content: JSON.stringify({ error: 'Invalid JSON arguments' }),
      };
    }

    // Track the tool call
    const trackedCall: TrackedToolCall = {
      id: toolCall.id,
      name: toolCall.function.name,
      args,
      status: 'executing',
      startTime: Date.now(),
    };
    this.activeToolCalls.set(toolCall.id, trackedCall);

    try {
      // Execute the tool
      const result = await tool.executor(args);
      
      // Update tracking
      trackedCall.status = 'complete';
      trackedCall.result = result;
      trackedCall.endTime = Date.now();

      return {
        tool_call_id: toolCall.id,
        role: 'tool',
        content: result,
      };
    } catch (error) {
      // Update tracking with error
      trackedCall.status = 'failed';
      trackedCall.error = error instanceof Error ? error.message : String(error);
      trackedCall.endTime = Date.now();

      return {
        tool_call_id: toolCall.id,
        role: 'tool',
        content: JSON.stringify({ 
          error: error instanceof Error ? error.message : String(error) 
        }),
      };
    }
  }

  /**
   * Get a tracked tool call by ID
   */
  getTrackedToolCall(id: string): TrackedToolCall | undefined {
    return this.activeToolCalls.get(id);
  }

  /**
   * Get all active tool calls
   */
  getActiveToolCalls(): TrackedToolCall[] {
    return Array.from(this.activeToolCalls.values());
  }

  /**
   * Clear completed tool calls from tracking
   */
  clearCompletedToolCalls(): void {
    for (const [id, call] of this.activeToolCalls) {
      if (call.status === 'complete' || call.status === 'failed') {
        this.activeToolCalls.delete(id);
      }
    }
  }
}

// Singleton instance
export const toolRegistry = new ToolRegistry();

// Export for testing
export { ToolRegistry };

