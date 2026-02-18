/**
 * Tool Registry
 * Central registry for managing tool definitions and executors
 */
import { allTools } from "./definitions";
import { getEnhancedToolRiskLevel } from "./definitions/risk-levels-enhanced";
import { parseToolArguments } from "../lib/tool-arguments";
import type { RegisteredTool, ToolCallRequest, ToolCallResult, ToolDefinition, ToolExecutor, TrackedToolCall } from "./types";

class ToolRegistry {
  private activeToolCalls: Map<string, TrackedToolCall> = new Map();
  private tools: Map<string, RegisteredTool> = new Map();

  constructor() {
    // Register all tool definitions (executors will be added later)
    this.registerAllDefinitions();
  }

  /**
   * Clear completed tool calls from tracking
   */
  public clearCompletedToolCalls(): void {
    for (const [id, call] of this.activeToolCalls) {
      if (call.status === 'complete' || call.status === 'failed') {
        this.activeToolCalls.delete(id);
      }
    }
  }

  /**
   * Execute a tool call
   */
  public async executeToolCall(
    toolCall: ToolCallRequest,
    preParsedArgs?: Record<string, unknown>
  ): Promise<ToolCallResult> {
    const tool = this.tools.get(toolCall.function.name);

    if (!tool) {
      return {
        tool_call_id: toolCall.id,
        role: 'tool',
        content: JSON.stringify({ error: `Unknown tool: ${toolCall.function.name}` }),
      };
    }

    let args: Record<string, unknown>;
    if (preParsedArgs) {
      args = preParsedArgs;
    } else {
      // Parse arguments
      const parsedArgsResult = parseToolArguments(toolCall.function.arguments);
      if (parsedArgsResult.status === 'invalid') {
        return {
          tool_call_id: toolCall.id,
          role: 'tool',
          content: JSON.stringify({ error: 'Invalid JSON arguments' }),
        };
      }
      args = parsedArgsResult.args;
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
      const result = await tool.executor(args, toolCall.id);

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
   * Get all active tool calls
   */
  public getActiveToolCalls(): TrackedToolCall[] {
    return Array.from(this.activeToolCalls.values());
  }

  /**
   * Get all registered tools
   */
  public getAllTools(): RegisteredTool[] {
    return Array.from(this.tools.values());
  }

  /**
   * Get the risk level of a tool
   */
  public getRiskLevel(name: string): 'low' | 'medium' | 'high' {
    const tool = this.tools.get(name);
    return tool?.riskLevel ?? 'medium';
  }

  /**
   * Get a tool by name
   */
  public getTool(name: string): RegisteredTool | undefined {
    return this.tools.get(name);
  }

  /**
   * Get all tool definitions (for sending to the AI model)
   */
  public getToolDefinitions(): ToolDefinition[] {
    return Array.from(this.tools.values()).map(t => t.definition);
  }

  /**
   * Get a tracked tool call by ID
   */
  public getTrackedToolCall(id: string): TrackedToolCall | undefined {
    return this.activeToolCalls.get(id);
  }

  /**
   * Register a tool definition without an executor
   */
  public registerDefinition(definition: ToolDefinition): void {
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
  public registerExecutor(name: string, executor: ToolExecutor): void {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new Error(`Tool not found: ${name}`);
    }
    tool.executor = executor;
  }

  /**
   * Check if a tool requires approval
   */
  public requiresApproval(name: string): boolean {
    const tool = this.tools.get(name);
    return tool?.requiresApproval ?? true;
  }

  /**
   * Register all tool definitions from the definitions module
   */
  private registerAllDefinitions(): void {
    for (const tool of allTools) {
      this.registerDefinition(tool);
    }
  }
}

// Singleton instance
export const toolRegistry = new ToolRegistry();

// Export for testing
export { ToolRegistry };
