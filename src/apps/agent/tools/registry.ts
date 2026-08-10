/**
 * Tool Registry (post-Rust-migration)
 * ===================================
 *
 * Frontend-side metadata catalogue for tools the LLM can call. The
 * actual executors now live in the Rust runtime
 * (`src-tauri/src/tools/`); the frontend only needs:
 *
 *   1. The OpenAI-shaped tool definitions to send in the
 *      `AgentChatRequest.tools` array.
 *   2. Risk-level lookup so the UI can decorate high-risk tool cards.
 *   3. Per-call tracking for the in-flight tool spinner / status
 *      pills the chat timeline already renders.
 *
 * What's gone:
 *   - `executor` field on `RegisteredTool` / `registerExecutor` —
 *     the Rust ToolRegistry is the source of truth.
 *   - `executeToolCall` — the Rust runtime dispatches every native
 *     tool itself; only `mcp_*` tools round-trip through the
 *     frontend (handled directly by `agent-runtime-client`).
 *   - `requiresApproval` legacy plumbing — permissions are now
 *     gated by `SettingsAwarePermitter` on the Rust side, which
 *     consults the `tool_settings` SQLite table on every call.
 */
import { allTools } from "./definitions";
import { getEnhancedToolRiskLevel } from "./definitions/risk-levels-enhanced";
import type { RegisteredTool, TrackedToolCall, ToolDefinition } from "./types";

class ToolRegistry {
  private activeToolCalls: Map<string, TrackedToolCall> = new Map();
  private tools: Map<string, RegisteredTool> = new Map();

  constructor() {
    this.registerAllDefinitions();
  }

  /** Clear completed tool calls from in-memory tracking. */
  public clearCompletedToolCalls(): void {
    for (const [id, call] of this.activeToolCalls) {
      if (call.status === "complete" || call.status === "failed") {
        this.activeToolCalls.delete(id);
      }
    }
  }

  /** Active (still-running) tool calls — used by the timeline. */
  public getActiveToolCalls(): TrackedToolCall[] {
    return Array.from(this.activeToolCalls.values());
  }

  /** Every registered tool with its risk level + definition. */
  public getAllTools(): RegisteredTool[] {
    return Array.from(this.tools.values());
  }

  /** Risk level for a given tool name (defaults to `medium`). */
  public getRiskLevel(name: string): "low" | "medium" | "high" {
    const tool = this.tools.get(name);
    return tool?.riskLevel ?? "medium";
  }

  /** Single tool record by name (or `undefined`). */
  public getTool(name: string): RegisteredTool | undefined {
    return this.tools.get(name);
  }

  /**
   * Tool definitions in the OpenAI-shaped wire format the model
   * expects. Used by `agent-service` when building the
   * `AgentChatRequest.tools` array.
   */
  public getToolDefinitions(): ToolDefinition[] {
    return Array.from(this.tools.values()).map((t) => t.definition);
  }

  /** One tracked tool call by id (used by the chat timeline). */
  public getTrackedToolCall(id: string): TrackedToolCall | undefined {
    return this.activeToolCalls.get(id);
  }

  /**
   * Record a tool call as `executing` so the UI can show a spinner
   * before the Rust runtime fires its first delta. Called by the
   * agent runtime client when an `assistant_event::tool_use` is
   * received.
   */
  public recordToolCallStart(id: string, name: string, args: Record<string, unknown>): void {
    this.activeToolCalls.set(id, {
      id,
      name,
      args,
      status: "executing",
      startTime: Date.now(),
    });
  }

  /** Mark a tracked tool call complete with its result string. */
  public recordToolCallComplete(id: string, result: string): void {
    const tracked = this.activeToolCalls.get(id);
    if (!tracked) return;
    tracked.status = "complete";
    tracked.result = result;
    tracked.endTime = Date.now();
  }

  /** Mark a tracked tool call as failed with an error message. */
  public recordToolCallFailure(id: string, error: string): void {
    const tracked = this.activeToolCalls.get(id);
    if (!tracked) return;
    tracked.status = "failed";
    tracked.error = error;
    tracked.endTime = Date.now();
  }

  /**
   * Register a tool definition (no executor). Used internally by
   * `registerAllDefinitions` and by MCP integration when servers
   * advertise new tools at runtime.
   */
  public registerDefinition(definition: ToolDefinition): void {
    const name = definition.function.name;
    const riskLevel = getEnhancedToolRiskLevel(name);
    this.tools.set(name, {
      definition,
      requiresApproval: riskLevel === "high",
      riskLevel,
    });
  }

  private registerAllDefinitions(): void {
    for (const tool of allTools) {
      this.registerDefinition(tool);
    }
  }
}

export const toolRegistry = new ToolRegistry();
export { ToolRegistry };
