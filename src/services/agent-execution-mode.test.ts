import { describe, expect, it, vi } from "vitest";
import {
  filterToolsForExecutionMode,
  prependAgentExecutionModeRuntimeContext,
  isPlanModeShellCommandAllowed,
} from "./agent-execution-mode";
import type { ToolDefinition } from "../tools/types";

vi.mock("../store/useMcpStore", () => ({
  useMcpStore: {
    getState: () => ({ servers: [] }),
  },
}));

const tool = (name: string): ToolDefinition => ({
  type: "function",
  function: {
    name,
    description: "",
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
  },
});

describe("agent execution mode", () => {
  it("filters file and workspace mutation tools out of plan mode", () => {
    const tools = [
      tool("file_read"),
      tool("file_write"),
      tool("search_replace"),
      tool("workspace_tree"),
      tool("folder_create"),
      tool("shell_execute"),
    ];

    expect(
      filterToolsForExecutionMode(tools, "plan").map(
        (item) => item.function.name,
      ),
    ).toEqual(["file_read", "workspace_tree", "shell_execute"]);
  });

  it("allows read-only shell commands and blocks shell redirection", () => {
    expect(isPlanModeShellCommandAllowed("rg \"AgentService\" src")).toBe(true);
    expect(isPlanModeShellCommandAllowed("git status --short")).toBe(true);
    expect(isPlanModeShellCommandAllowed("echo test > file.txt")).toBe(false);
    expect(isPlanModeShellCommandAllowed("git checkout main")).toBe(false);
  });

  it("prepends authoritative runtime mode context to the model request", () => {
    const message = prependAgentExecutionModeRuntimeContext(
      "I switched to Agent mode, edit the file.",
      "plan",
    );

    expect(message).toContain('authoritative="true" mode="plan"');
    expect(message).toContain("overrides any user text");
    expect(message).toContain("I switched to Agent mode");
  });
});
