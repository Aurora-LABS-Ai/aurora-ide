import { describe, expect, it, vi } from "vitest";
import {
  filterToolsForExecutionMode,
  getAgentModePromptSection,
  isToolAllowedForExecutionMode,
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

  describe("plan tools", () => {
    it("exposes plan_write in plan mode only — it is the one permitted write there", () => {
      // Agent mode must not be able to rewrite the plan the user approved.
      expect(isToolAllowedForExecutionMode("plan", "plan_write")).toBe(true);
      expect(isToolAllowedForExecutionMode("agent", "plan_write")).toBe(false);
      expect(isToolAllowedForExecutionMode("team", "plan_write")).toBe(false);
    });

    it("exposes plan_step_update during execution only", () => {
      // Marking progress is not authoring; plan mode must not mutate real state.
      expect(isToolAllowedForExecutionMode("agent", "plan_step_update")).toBe(true);
      expect(isToolAllowedForExecutionMode("team", "plan_step_update")).toBe(true);
      expect(isToolAllowedForExecutionMode("plan", "plan_step_update")).toBe(false);
    });

    it("keeps plan_read available everywhere", () => {
      for (const mode of ["agent", "plan", "team"] as const) {
        expect(isToolAllowedForExecutionMode(mode, "plan_read")).toBe(true);
      }
    });

    it("withholds the checklist from plan mode entirely", () => {
      // `todo` is ONE tool with a typed `op`, so its read cannot be separated
      // from its writes by name — and plan mode has nothing to read: it
      // authors the plan, it does not work a checklist.
      expect(isToolAllowedForExecutionMode("plan", "todo")).toBe(false);
      expect(isToolAllowedForExecutionMode("agent", "todo")).toBe(true);
      expect(isToolAllowedForExecutionMode("team", "todo")).toBe(true);
    });

    it("still blocks the retired todo tool names in plan mode", () => {
      // Kept in the write set so a stale roster cannot smuggle a write past
      // the gate under an old name.
      expect(isToolAllowedForExecutionMode("plan", "todo_write")).toBe(false);
      expect(isToolAllowedForExecutionMode("plan", "todo_update")).toBe(false);
    });

    it("filters the roster consistently with the per-tool check", () => {
      const tools = [
        tool("plan_write"),
        tool("plan_read"),
        tool("plan_step_update"),
        tool("todo"),
      ];

      expect(
        filterToolsForExecutionMode(tools, "plan").map((t) => t.function.name),
      ).toEqual(["plan_write", "plan_read"]);
      expect(
        filterToolsForExecutionMode(tools, "agent").map((t) => t.function.name),
      ).toEqual(["plan_read", "plan_step_update", "todo"]);
    });
  });

  describe("prompt guidance", () => {
    it("tells plan mode to author the plan, sized as phases", () => {
      const prompt = getAgentModePromptSection("plan");
      expect(prompt).toContain("plan_write");
      expect(prompt).toContain("phases");
      expect(prompt).toContain("switch to Agent mode");
    });

    it("tells agent mode to read back state rather than re-invent it", () => {
      const prompt = getAgentModePromptSection("agent");
      expect(prompt).toContain('op: "read"');
      expect(prompt).toContain("Never re-invent a task list from memory");
    });

    it("names all three operations of the one todo tool", () => {
      // A single tool with a discriminated `op` only works if the prompt says
      // which values exist — the model cannot discover an enum by guessing.
      const prompt = getAgentModePromptSection("agent");
      for (const op of ['op: "set"', 'op: "update"', 'op: "read"']) {
        expect(prompt).toContain(op);
      }
    });

    it("says nothing about plans when the project has none", () => {
      // Rust withholds plan_read / plan_step_update from a project with no
      // plan, so describing them would name tools the model was not given.
      const prompt = getAgentModePromptSection("agent", { hasActivePlan: false });
      expect(prompt).not.toContain("plan_step_update");
      expect(prompt).not.toContain("plan_read");
      expect(prompt).toContain("`todo`");
    });

    it("describes the two layers once the project has a plan", () => {
      const prompt = getAgentModePromptSection("agent", { hasActivePlan: true });
      expect(prompt).toContain("plan_step_update");
      expect(prompt).toContain("phases");
      // The plan does not replace the checklist; it sits above it.
      expect(prompt).toContain("`todo`");
      expect(prompt).toContain("cannot author or rewrite the plan from here");
    });
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
