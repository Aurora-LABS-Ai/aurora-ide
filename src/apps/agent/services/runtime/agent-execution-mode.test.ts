import { describe, expect, it, vi } from "vitest";
import {
  AURORA_SURFACES,
  auroraSurfaceName,
  cycleAgentExecutionMode,
  DEEP_RESEARCH_PROMPT,
  effectiveExecutionMode,
  effectiveProjectRoot,
  filterToolsForExecutionMode,
  getAgentModePromptSection,
  isToolAllowedForExecutionMode,
  normalizeAgentExecutionMode,
  normalizeAuroraSurface,
  isPlanModeShellCommandAllowed,
} from "@/apps/agent/services/runtime/agent-execution-mode";
import type { ToolDefinition } from "@/apps/agent/tools/types";

vi.mock("@/apps/agent/store/tools/useMcpStore", () => ({
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

  it("does not read a search pattern as shell syntax", () => {
    // `>` inside quotes is data. A bare />/ test refused all of these, and in
    // Plan mode a refusal means the search never ran.
    expect(isPlanModeShellCommandAllowed('rg -n "->" src/main.rs')).toBe(true);
    expect(isPlanModeShellCommandAllowed('rg -n "=>" src')).toBe(true);
    expect(isPlanModeShellCommandAllowed('git log --pretty=format:"%h -> %s"')).toBe(true);
  });

  it("separates a mutating verb from an argument that merely names one", () => {
    expect(isPlanModeShellCommandAllowed('rg -n "copy" src')).toBe(true);
    expect(isPlanModeShellCommandAllowed("rg -n copy src")).toBe(true);
    expect(isPlanModeShellCommandAllowed("git log --grep rename")).toBe(true);
    expect(isPlanModeShellCommandAllowed("cat notes/rm-plan.md")).toBe(true);
    // A mutating verb leading any segment of a chain is still refused.
    expect(isPlanModeShellCommandAllowed("ls | del x")).toBe(false);
    expect(isPlanModeShellCommandAllowed("cat a && rm -rf b")).toBe(false);
    expect(isPlanModeShellCommandAllowed("rm -rf build")).toBe(false);
  });

  describe("plan tools", () => {
    it("exposes plan_write in plan mode only — it is the one permitted write there", () => {
      // Agent mode must not be able to rewrite the plan the user approved.
      expect(isToolAllowedForExecutionMode("plan", "plan_write")).toBe(true);
      expect(isToolAllowedForExecutionMode("agent", "plan_write")).toBe(false);
    });

    it("exposes plan_step_update during execution only", () => {
      // Marking progress is not authoring; plan mode must not mutate real state.
      expect(isToolAllowedForExecutionMode("agent", "plan_step_update")).toBe(true);
      expect(isToolAllowedForExecutionMode("plan", "plan_step_update")).toBe(false);
    });

    it("keeps plan_read available everywhere", () => {
      for (const mode of ["agent", "plan"] as const) {
        expect(isToolAllowedForExecutionMode(mode, "plan_read")).toBe(true);
      }
    });

    it("withholds the checklist from plan mode entirely", () => {
      // All three, `TaskList` included: plan mode authors the plan, it does
      // not work a checklist, so its list can only ever be empty.
      for (const name of ["TaskCreate", "TaskUpdate", "TaskList"]) {
        expect(isToolAllowedForExecutionMode("plan", name)).toBe(false);
        expect(isToolAllowedForExecutionMode("agent", name)).toBe(true);
      }
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
      expect(prompt).toContain("`TaskList`");
      expect(prompt).toContain("Never re-invent a task list from memory");
    });

    it("names all three task tools", () => {
      // Three names for three jobs, said once where the model will read them:
      // a roster entry alone does not say that closing one task and starting
      // the next is two calls in the same message.
      const prompt = getAgentModePromptSection("agent");
      for (const name of ["`TaskCreate`", "`TaskUpdate`", "`TaskList`"]) {
        expect(prompt).toContain(name);
      }
    });

    it("says nothing about plans when the project has none", () => {
      // Rust withholds plan_read / plan_step_update from a project with no
      // plan, so describing them would name tools the model was not given.
      const prompt = getAgentModePromptSection("agent", { hasActivePlan: false });
      expect(prompt).not.toContain("plan_step_update");
      expect(prompt).not.toContain("plan_read");
      expect(prompt).toContain("`TaskCreate`");
    });

    it("describes the two layers once the project has a plan", () => {
      const prompt = getAgentModePromptSection("agent", { hasActivePlan: true });
      expect(prompt).toContain("plan_step_update");
      expect(prompt).toContain("phases");
      // The plan does not replace the checklist; it sits above it.
      expect(prompt).toContain("`TaskCreate`");
      expect(prompt).toContain("cannot author or rewrite the plan from here");
    });
  });

  it("states the mode once, in the prompt section, as Aurora's own reading of the window", () => {
    // The mode used to be repeated per message as an `<execution_mode_context>`
    // block, saved into every message's context. The section is the one home
    // now, so it has to carry the authority claim itself.
    for (const mode of ["plan", "agent"] as const) {
      const section = getAgentModePromptSection(mode);
      expect(section).toMatch(/Aurora sets this mode from the window's actual state/);
      expect(section).not.toMatch(/runtime execution mode context/);
    }
  });

  describe("chat mode", () => {
    const tool = (name: string): ToolDefinition =>
      ({
        type: "function",
        function: { name, description: `the ${name} tool`, parameters: {} },
      }) as unknown as ToolDefinition;

    it("refuses every file and shell tool", () => {
      for (const name of [
        "file_read",
        "file_write",
        "file_edit",
        "delete_path",
        "move_path",
        "glob",
        "grep",
        "workspace_tree",
        "shell_execute",
        "shell_spawn",
        "code",
        "todo",
        "plan_write",
        "browser_navigate",
      ]) {
        expect(isToolAllowedForExecutionMode("chat", name)).toBe(false);
      }
    });

    it("offers research, presentation, memory and images", () => {
      for (const name of [
        "auroro_websearch",
        "present_artifact",
        "read_artifact",
        "recall",
        "remember",
        "generate_image",
        "generate_video",
        "aurora_skill_search",
        "aurora_skill_load",
        "chapter",
        "ask_question",
      ]) {
        expect(isToolAllowedForExecutionMode("chat", name)).toBe(true);
      }
    });

    it("keeps Chat image generation out of Build", () => {
      for (const mode of ["agent", "plan"] as const) {
        expect(isToolAllowedForExecutionMode(mode, "generate_image")).toBe(false);
      }
    });

    it("allows MCP, because connecting a server is the user's own grant", () => {
      expect(isToolAllowedForExecutionMode("chat", "mcp_fs_read_file")).toBe(true);
      expect(isToolAllowedForExecutionMode("chat", "mcp_anything_at_all")).toBe(true);
    });

    // The failure that turns an allow-list back into a deny-list.
    it("matches names exactly rather than by prefix", () => {
      for (const name of [
        "recall_everything",
        "rememberer",
        "auroro_websearch2",
        "present_artifact_and_more",
      ]) {
        expect(isToolAllowedForExecutionMode("chat", name)).toBe(false);
      }
    });

    it("filters a mixed roster down to its own tools", () => {
      const kept = filterToolsForExecutionMode(
        [
          tool("file_read"),
          tool("auroro_websearch"),
          tool("shell_execute"),
          tool("present_artifact"),
          tool("mcp_notion_search"),
          tool("browser_click"),
        ],
        "chat",
      ).map((t) => t.function.name);

      expect(kept).toEqual([
        "auroro_websearch",
        "present_artifact",
        "mcp_notion_search",
      ]);
    });

    // The memory tools travel one way. Chat's index holds Chat conversations,
    // so a Build turn that calls `recall` asks a store that knows nothing about
    // what Build did and is told, accurately and uselessly, that it found
    // nothing. It shipped that way: a Build turn called `recall` beside
    // `shell_execute`.
    it("keeps its memory out of every build mode", () => {
      for (const mode of ["agent", "plan"] as const) {
        for (const name of ["recall", "remember"]) {
          expect(isToolAllowedForExecutionMode(mode, name)).toBe(false);
        }
        expect(
          filterToolsForExecutionMode(
            [tool("recall"), tool("remember"), tool("file_read")],
            mode,
          ).map((t) => t.function.name),
        ).toEqual(["file_read"]);
      }
    });

    // Chat mode's prompt REPLACES the base rather than appending to it, so the
    // section helper has nothing to contribute. A non-empty return here would
    // mean the coding prompt is being layered underneath.
    it("contributes no mode section, because it replaces the whole prompt", () => {
      expect(getAgentModePromptSection("chat")).toBe("");
    });

    it("is not part of the composer's mode cycle", () => {
      // Chat is a different product, reached by the rail's switcher. One
      // keypress must never move a conversation to another store.
      expect(cycleAgentExecutionMode("agent")).toBe("plan");
      expect(cycleAgentExecutionMode("plan")).toBe("agent");
    });

    it("round-trips through normalization", () => {
      expect(normalizeAgentExecutionMode("chat")).toBe("chat");
      expect(normalizeAgentExecutionMode('"chat"')).toBe("chat");
      expect(normalizeAgentExecutionMode("CHAT")).toBe("chat");
      expect(normalizeAgentExecutionMode("nonsense")).toBe("agent");
      // A "team" mode saved before the agent team was removed opens as Agent.
      expect(normalizeAgentExecutionMode("team")).toBe("agent");
      expect(normalizeAgentExecutionMode('"team"')).toBe("agent");
    });
  });

  describe("the surface, and how it combines with the build mode", () => {
    it("normalizes to build for anything that is not chat", () => {
      expect(normalizeAuroraSurface("chat")).toBe("chat");
      expect(normalizeAuroraSurface('"chat"')).toBe("chat");
      expect(normalizeAuroraSurface("CHAT")).toBe("chat");
      expect(normalizeAuroraSurface("build")).toBe("build");
      expect(normalizeAuroraSurface(undefined)).toBe("build");
      expect(normalizeAuroraSurface("nonsense")).toBe("build");
    });

    // The reason the two are stored separately: a trip through Chat must
    // return you to the Build mode you left, not drop you on Agent.
    it("remembers the build mode while chat is in force", () => {
      expect(effectiveExecutionMode("chat", "plan")).toBe("chat");
      expect(effectiveExecutionMode("build", "plan")).toBe("plan");
      expect(effectiveExecutionMode("build", "agent")).toBe("agent");
    });

    it("chat outranks every build mode", () => {
      for (const mode of ["agent", "plan"] as const) {
        expect(effectiveExecutionMode("chat", mode)).toBe("chat");
      }
    });

    it("names both products for the switcher", () => {
      const ids = AURORA_SURFACES.map((s) => s.id);
      expect(ids).toEqual(["chat", "build"]);
      expect(AURORA_SURFACES[0].name).toBe("Aurora Chat");
      expect(AURORA_SURFACES[1].name).toBe("Aurora Build");
      // Neither entry is called "Agent" — the mode that writes software is Build.
      for (const surface of AURORA_SURFACES) {
        expect(surface.name).not.toMatch(/agent/i);
        expect(surface.tagline.length).toBeGreaterThan(0);
      }
    });

    /// The titlebar and the OS window title both read this, so a chat window
    /// titled "Aurora Agent" — a name that appears nowhere else on screen —
    /// is what it exists to prevent.
    it("titles the window with the product that is open", () => {
      expect(auroraSurfaceName("chat")).toBe("Aurora Chat");
      expect(auroraSurfaceName("build")).toBe("Aurora Build");
      // An unreadable stored value names the side Aurora opens on rather than
      // inventing a third product.
      expect(auroraSurfaceName("nonsense" as never)).toBe("Aurora Build");
    });

    // Seen live on the first real chat turn: the window keeps its project so
    // Build can resume on it, the send path read that project, and the model
    // was handed `<workspace_root>E:\…` plus "you are working inside this
    // project directory" in a mode with no file tools at all.
    it("gives a chat turn no project, however the window is scoped", () => {
      expect(effectiveProjectRoot("chat", "E:/VOID-EDITOR/Aurora-Agent-IDE")).toBeNull();
      expect(effectiveProjectRoot("chat", null)).toBeNull();
      expect(effectiveProjectRoot("chat", undefined)).toBeNull();
    });

    it("leaves every build mode rooted where it was", () => {
      for (const mode of ["agent", "plan"] as const) {
        expect(effectiveProjectRoot(mode, "E:/work")).toBe("E:/work");
      }
      // No project open is still no project, not `undefined` on the wire.
      expect(effectiveProjectRoot("agent", undefined)).toBeNull();
    });
  });

  describe("the deep-research instruction", () => {
    it("tells the model it has time, which is the whole point", () => {
      expect(DEEP_RESEARCH_PROMPT).toMatch(/You have time/);
      expect(DEEP_RESEARCH_PROMPT).toMatch(/Do not optimise for a fast reply/);
    });

    it("asks for sources next to claims, not a bibliography", () => {
      expect(DEEP_RESEARCH_PROMPT).toMatch(/source next to the thing it supports/);
      expect(DEEP_RESEARCH_PROMPT).toMatch(/primary sources/i);
    });

    /** The failure this mode exists to avoid is a confident gap. */
    it("requires gaps to be named", () => {
      expect(DEEP_RESEARCH_PROMPT).toMatch(/could not establish/);
      expect(DEEP_RESEARCH_PROMPT).toMatch(/paper over/);
    });

    it("does not make every answer a canvas", () => {
      // The over-correction: a research mode that renders three sentences as a
      // dashboard is worse than three sentences.
      expect(DEEP_RESEARCH_PROMPT).toMatch(/just write the paragraph/i);
    });

    /** It names only tools chat mode actually has. */
    it("names no tool the mode does not have", () => {
      for (const absent of ["browser_navigate", "file_read", "shell_execute", "code"]) {
        expect(DEEP_RESEARCH_PROMPT).not.toContain(absent);
      }
      expect(DEEP_RESEARCH_PROMPT).toContain("present_artifact");
    });
  });
});
