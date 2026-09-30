import { afterEach, describe, expect, it, vi } from "vitest";

import {
  BASE_AGENT_SYSTEM_PROMPT,
  CANVAS_INSTRUCTIONS,
  composeAgentSystemPrompt,
  formatEnvironment,
} from "@/apps/agent/services/runtime/agent-prompt";
import { CHAT_MODE_SYSTEM_PROMPT } from "@/apps/agent/services/runtime/agent-execution-mode";

vi.mock("@/apps/agent/services/skills/skills", () => ({
  getWorkspaceSkillToggles: () => ({}),
  resolveSkillsForPrompt: async () => ({
    allSkills: [],
    activeSkills: [],
    enabledSkills: [],
    explicitSkills: [],
  }),
}));

vi.mock("@/apps/agent/services/plans/agent-plans", () => ({
  getActivePlan: async () => null,
}));

const activeInstructions = vi.hoisted(() => ({ text: "" }));

vi.mock("@/apps/agent/store/settings/useAgentSettingsStore", () => ({
  useAgentSettingsStore: {
    getState: () => ({ skillToggles: {}, skillsEnabled: false }),
  },
  selectActiveGlobalInstructions: () => activeInstructions.text,
}));

afterEach(() => { activeInstructions.text = ""; });

describe("stable optional tool discovery instructions", () => {
  it("teaches exact discovery followed by execution of the browser guide", async () => {
    const { systemPrompt } = await composeAgentSystemPrompt({
      browserTools: true,
      promptContext: { workspacePath: "E:/project", userMessage: "browse" },
    });
    const browserSection = systemPrompt.split("## Browser\n")[1]?.split("\n## ")[0];
    expect(browserSection).toBeDefined();
    const search = 'tool_search({"query":"select:browser_guidelines"})';
    const execute = 'call_tool({"name":"browser_guidelines","arguments":{}})';
    expect(browserSection).toContain(search);
    expect(browserSection).toContain(execute);
    expect(browserSection!.indexOf(search)).toBeLessThan(browserSection!.indexOf(execute));
    expect(browserSection).toContain("Discovering its schema alone does not load the guide");
    expect(browserSection).not.toContain("browser_guidelines({})");
  });

  it.each([
    { browserTools: false, executionMode: "agent" as const },
    { browserTools: true, executionMode: "chat" as const },
  ])("omits browser entry instructions when unavailable: %o", async (options) => {
    const { systemPrompt } = await composeAgentSystemPrompt({
      ...options,
      promptContext: { userMessage: "help" },
    });
    expect(systemPrompt).not.toContain("## Browser\n");
    expect(systemPrompt).not.toContain("select:browser_guidelines");
  });

  it("keeps the complete system prompt identical across MCP connection changes and legacy flags", async () => {
    const common = { promptContext: { workspacePath: "E:/project", userMessage: "help" } };
    const before = await composeAgentSystemPrompt({ ...common, mcpSummary: "No servers connected", deferTools: false });
    const after = await composeAgentSystemPrompt({ ...common, mcpSummary: "Connected: drive, github; 100 tools", deferTools: true });
    expect(after.systemPrompt).toBe(before.systemPrompt);
    expect(after.systemPrompt).toContain("call_tool(");
    expect(after.systemPrompt).toContain("Call the core tools in your tool list directly");
    expect(after.systemPrompt).not.toContain("Connected: drive");
    expect(after.systemPrompt).not.toContain("stays loaded for the rest");
  });
  it("teaches the same wrapper contract in chat mode", async () => {
    const result = await composeAgentSystemPrompt({ executionMode: "chat", promptContext: { userMessage: "help" } });
    expect(result.systemPrompt).toContain("call_tool(");
    expect(result.systemPrompt).toContain("search again after compaction");
    expect(result.systemPrompt).not.toContain("File operations, code search, shell");
    expect(result.systemPrompt).not.toContain("Browser, connected MCP apps, and team tools");
  });
});

/**
 * The base prompt ships on EVERY request of every conversation, so anything
 * that drifts here is paid for thousands of times and believed by the model
 * until someone notices by hand. These pin the failures that actually happened.
 */
describe("the base system prompt does not contradict the tools", () => {
  it("teaches local source search and honest uncertainty", () => {
    expect(BASE_AGENT_SYSTEM_PROMPT).toContain('op: "search"');
    expect(BASE_AGENT_SYSTEM_PROMPT).toContain("ranked word matches");
    expect(BASE_AGENT_SYSTEM_PROMPT).toContain("not a confirmed relationship");
    expect(BASE_AGENT_SYSTEM_PROMPT).not.toContain("paid indexing");
  });

  it("never teaches a `paths` argument, which no tool declares any more", () => {
    // `file_read` used to declare `path` AND `paths`, and the prompt taught the
    // pair. The schema could not express "exactly one of" without `oneOf` (HTTP
    // 400 on strict validators), so the rule lived here in prose and was
    // enforced by REJECTION — and a strictly-decoding model, which fills every
    // declared property, sent both and was told its own correct call was
    // malformed. 6 of 60 `file_read` calls in one live thread died that way.
    expect(BASE_AGENT_SYSTEM_PROMPT).not.toMatch(/`paths`/);
    expect(BASE_AGENT_SYSTEM_PROMPT).not.toMatch(/paths:\s*\[\]/);
  });

  it("describes `file_read` as one argument taking a string or an array", () => {
    expect(BASE_AGENT_SYSTEM_PROMPT).toMatch(/`file_read` names what to read through ONE argument/);
  });

  it("does not state a browser tool COUNT, which drifted from 8 to 16 unnoticed", () => {
    // The removed section claimed "exactly eight browser tools" while the
    // roster held sixteen. A number in prose has no way to stay true; the
    // roster the model receives is the only honest source.
    expect(BASE_AGENT_SYSTEM_PROMPT).not.toMatch(/exactly (eight|8|sixteen|16) browser tools/i);
  });

  it("keeps the browser doctrine out of the always-on prompt", () => {
    // ~1,126 tokens of it shipped on every request, including turns where
    // browser tools were switched off entirely. `browser_guidelines` carries it
    // now, and the pointer to that tool is gated on the same flag Rust reads.
    expect(BASE_AGENT_SYSTEM_PROMPT).not.toMatch(/browser_page_outline/);
    expect(BASE_AGENT_SYSTEM_PROMPT).not.toMatch(/## Browser Tools/);
  });

  it("does not promise a separate IDE window to hand work to", () => {
    // The agent window is the product. Telling the model it can "reach into
    // the separate Aurora IDE window" offers a capability that is not there.
    expect(BASE_AGENT_SYSTEM_PROMPT).not.toMatch(/separate Aurora IDE window/);
    expect(BASE_AGENT_SYSTEM_PROMPT).not.toMatch(/two brains/);
    // ...and does not deny one either. "There is no separate editor window to
    // hand work off to" described a thing that is not there, which is the one
    // shape this prompt has already learned to avoid: the tail preamble's
    // prohibitions came back as 49 of 80 thinking blocks. Say what the window
    // HAS and let the absence be something the model never thinks about.
    expect(BASE_AGENT_SYSTEM_PROMPT).not.toMatch(/no separate editor window/i);
    expect(BASE_AGENT_SYSTEM_PROMPT).not.toMatch(/hand work off/i);
  });

  it("states who it is once, and says what the window has", () => {
    // The opening used to name Aurora Agent three times in its first 120
    // words — the first line, again as the first bullet of a "Core Identity"
    // heading that restated the line above it, and the window in all three.
    // This is the start of every request's cached prefix, so it is what the
    // model reads first every single time; spending it on one fact three times
    // shapes what the model thinks the conversation is about.
    const identity = BASE_AGENT_SYSTEM_PROMPT.match(/You are Aurora Agent/g) ?? [];
    expect(identity).toHaveLength(1);
    expect(BASE_AGENT_SYSTEM_PROMPT).not.toMatch(/## Core Identity/);
    expect(BASE_AGENT_SYSTEM_PROMPT).not.toMatch(/whole product/);
    // The dock is real information and stays: it is what the model can act on.
    for (const panel of ["**Review**", "**Files**", "**Browser**", "**Terminal**"]) {
      expect(BASE_AGENT_SYSTEM_PROMPT).toContain(panel);
    }
  });

  it("tells the model the harness itself can be at fault", () => {
    // Twice now a correct call was rejected by Aurora and the model concluded
    // it had erred — retrying variations until the turn died, once retracting
    // a correct bug report. This is the line that makes the other outcome
    // available to it.
    expect(BASE_AGENT_SYSTEM_PROMPT).toMatch(/Aurora itself can be the thing that is broken/);
    expect(BASE_AGENT_SYSTEM_PROMPT).toMatch(/report_aurora_issue/);
  });

  it("explains the injected blocks and which of them go stale", () => {
    for (const marker of [
      "## Context Aurora Injects",
      "<repo_map>",
      "<aurora_context>",
      "<checklist>",
      "<aurora_task_reminder>",
      "<open_files>",
      "<machine_tools>",
    ]) {
      expect(BASE_AGENT_SYSTEM_PROMPT).toContain(marker);
    }
    // The map is a snapshot and must say so — an agent that trusts it after
    // sixty edits is reading a frozen picture as though it were the workspace.
    expect(BASE_AGENT_SYSTEM_PROMPT).toMatch(/`<repo_map>` sits at the head of the first message: a SNAPSHOT/);
    // The checklist in a message's context is the list as it stood THEN; the
    // tool's own results are the present. Saying "live" of a saved block
    // would be the one thing worse than saying nothing.
    expect(BASE_AGENT_SYSTEM_PROMPT).not.toMatch(/<checklist>.*is LIVE/i);
    expect(BASE_AGENT_SYSTEM_PROMPT).toMatch(/as it stood when they sent that message/);
  });

  // Everything Aurora adds is written once and stays put: there is no state
  // block rebuilt per request, no second user turn, no reminder frozen into
  // every tool result. What each block means is said HERE, in the cached
  // prefix, so the blocks themselves ship bare — the five-sentence preamble
  // that used to ride at the tail was recited back in 49 of 80 thinking blocks.
  it("describes the message context and the rare reminder, without prohibitions", () => {
    expect(BASE_AGENT_SYSTEM_PROMPT).toMatch(/`<aurora_context>` sits at the end of a user message/);
    expect(BASE_AGENT_SYSTEM_PROMPT).toMatch(/`<aurora_task_reminder>` appears inside a tool result, rarely/);
    // The old shapes must not come back under their old names.
    expect(BASE_AGENT_SYSTEM_PROMPT).not.toContain("<aurora_runtime_state>");
    expect(BASE_AGENT_SYSTEM_PROMPT).not.toContain("<ide_context>");
    expect(BASE_AGENT_SYSTEM_PROMPT).not.toContain("<execution_mode_context>");
    // Describes, never forbids — a list of things not to do is a list of
    // things to think about.
    const section = BASE_AGENT_SYSTEM_PROMPT.split("## Context Aurora Injects")[1]?.split("\n## ")[0] ?? "";
    expect(section).not.toMatch(/do not reply|do not acknowledge|not from the user/i);
  });

  // 741 of the checklist-only assistant messages on disk were followed by a
  // message of real tool calls: a checklist update sent by itself, then the
  // work. One sentence about batching is the whole fix for that.
  it("tells the model a checklist update rides with the next step's tool calls", () => {
    expect(BASE_AGENT_SYSTEM_PROMPT).toMatch(
      /Checklist calls travel with the work they describe/,
    );
  });

  // …and the exception, because the two rules meet at the end of every turn.
  // The last task's work finished in the PREVIOUS message, so closing it can
  // only travel alone — and a model told both rules without the exception
  // spends its thinking arbitrating between them. Observed on a real build.
  it("names the one case where a checklist update travels alone", () => {
    expect(BASE_AGENT_SYSTEM_PROMPT).toMatch(
      /ONE exception is the final task[\s\S]*close it on its own/,
    );
  });

  // A checklist whose last item IS the written answer has no consistent
  // closing move: "close it alongside your final tool call" wants it ticked
  // before the writing, "never mark completed what is not" forbids exactly
  // that. 16 of the 959 checklist items on disk are that item, and session
  // `3da1e78d` spent 56,007 characters of thinking circling the conflict.
  // Remove the collision at the source rather than arbitrating it.
  it("keeps the checklist on work, and carries no round-trip economics", () => {
    expect(BASE_AGENT_SYSTEM_PROMPT).toMatch(/tracks the WORK, not your reply/);
    expect(BASE_AGENT_SYSTEM_PROMPT).toMatch(
      /Never add a task for writing the answer/,
    );
    // The exact guidance that created the conflict. (An unrelated line about
    // carrying tool-result content forward legitimately mentions a round trip;
    // ban the sentences, not the word.)
    for (const banned of [
      "wasted round-trip",
      "close the last task in the same message",
      "A tool call ends your message",
      "only closes a task",
    ]) {
      expect(BASE_AGENT_SYSTEM_PROMPT).not.toContain(banned);
    }
  });

  /**
   * Read live on 2026-09-04, session `fccbc7a8`: the model wrote its entire
   * 5,832-character architecture answer AND closed the last task in the same
   * message. A message with a tool call in it cannot end a turn — Aurora has
   * to run the tool and hand back the result — so it was asked again with the
   * answer already behind it, and spent a whole extra request writing 567
   * characters of "that's the full picture".
   *
   * The prompt already said the checklist should be "fully closed by the time
   * you write". True, and not enough: it never said the mechanical fact that
   * makes the ordering matter. This states it, in terms of what happens rather
   * than as round-trip economics — the arithmetic version is banned above,
   * because it collides with "never mark completed what is not".
   */
  it("says the final-answer message calls no tools, and why", () => {
    expect(BASE_AGENT_SYSTEM_PROMPT).toMatch(
      /message that carries your final answer calls no tools/i,
    );
    // The reason, not just the rule: a rule with no mechanism behind it is one
    // the model weighs against the others instead of simply following.
    expect(BASE_AGENT_SYSTEM_PROMPT).toMatch(/is not the end of a turn/i);
  });

  it("warns that compaction can erase earlier work from view", () => {
    expect(BASE_AGENT_SYSTEM_PROMPT).toMatch(/COMPACTED/);
  });

  it("states that open files carry names only, never content", () => {
    // The block is re-sent every turn. If it ever grows file bodies it becomes
    // the most expensive thing in the conversation.
    expect(BASE_AGENT_SYSTEM_PROMPT).toMatch(/filenames only, never content/i);
  });
});

describe("the canvas section decides the KIND before the guide is reachable", () => {
  it("carries the cheapest-kind rule in the always-present text", () => {
    // This rule lived only in `canvas_guidelines`, which is read AFTER a model
    // has already chosen `react` — far too late to talk it out of the choice.
    // Meanwhile `present_artifact`'s description, which IS always visible, says
    // "prefer react for datasets". The encouraging half was in the room at
    // decision time and the sobering half was not, so every ambiguous case
    // resolved the same way. Mirrors `the_kind_choice_rule_is_stated_up_front`
    // on the Rust side; change one wording and one of the two fails.
    expect(CANVAS_INSTRUCTIONS).toMatch(/Pick the cheapest kind that works/);
    expect(CANVAS_INSTRUCTIONS).toMatch(/`react` only when it needs to be interactive/);
  });

  it("still points at the guide before a compiled canvas is written", () => {
    expect(CANVAS_INSTRUCTIONS).toMatch(/canvas_guidelines/);
    // The renamed field, not the pre-rename `kind:`.
    expect(CANVAS_INSTRUCTIONS).toMatch(/artifactKind: "react"/);
  });
});

/**
 * Aurora Chat replaces the base prompt rather than appending to it. These pin
 * what must NOT reach it — every one of these lines is false in chat mode, and
 * a model told them anyway holds two identities and pays for both on every
 * request.
 */
describe("the chat-mode system prompt", () => {
  it("is not the coding prompt", () => {
    expect(CHAT_MODE_SYSTEM_PROMPT).not.toBe(BASE_AGENT_SYSTEM_PROMPT);
    expect(CHAT_MODE_SYSTEM_PROMPT).not.toMatch(/advanced AI coding agent/);
    expect(CHAT_MODE_SYSTEM_PROMPT).not.toMatch(/pair programming/);
  });

  it("names no tool chat mode does not have", () => {
    for (const absent of [
      "file_read",
      "file_edit",
      "file_write",
      "shell_execute",
      "workspace_tree",
      "todo",
      "plan_write",
      "team_dispatch",
      "browser_navigate",
      "repo_map",
    ]) {
      expect(CHAT_MODE_SYSTEM_PROMPT).not.toContain(absent);
    }
  });

  it("says where the machine work lives instead of refusing outright", () => {
    // The failure this prevents: a model that says "I can't do that" when the
    // truth is "not here, and the other side of this app can".
    expect(CHAT_MODE_SYSTEM_PROMPT).toMatch(/Aurora Build/);
    expect(CHAT_MODE_SYSTEM_PROMPT).toMatch(/switch/i);
    expect(CHAT_MODE_SYSTEM_PROMPT).toMatch(/no access to the user's files/i);
  });

  it("tells the model that connected tools are the one exception", () => {
    // MCP runs with no approval prompt in chat mode, so the prompt has to be
    // straight about what it CAN reach, or it will refuse work it can do.
    expect(CHAT_MODE_SYSTEM_PROMPT).toMatch(/connected/i);
  });

  it("does not itself carry the deep-research instruction", () => {
    // Deep research is a property of the CONVERSATION, added as its own
    // section. Baking it into the base prompt would apply it to every chat.
    expect(CHAT_MODE_SYSTEM_PROMPT).not.toContain("Deep research");
  });

  it("stays short, because it is the cached prefix of every request", () => {
    // Not a style preference: chat mode is cache-driven, and this text is
    // re-sent on every turn of every conversation. The coding prompt is the
    // thing being avoided, so the bound is stated against it.
    expect(CHAT_MODE_SYSTEM_PROMPT.length).toBeLessThan(
      BASE_AGENT_SYSTEM_PROMPT.length / 2,
    );
  });
});

/**
 * The constant being right is not the same as the model receiving it, and the
 * gap between those two shipped: every chat turn ran on the coding prompt
 * because `AgentService` always passes a `basePrompt` and the "is this an
 * override?" check compared a trimmed string against an untrimmed constant.
 * Nothing tested the COMPOSED output, so nothing caught it. These do.
 */
/**
 * Session-fixed facts belong in the cached half, not beside the things that
 * change. This is OpenCode's split — its system prompt carries the working
 * directory, the worktree, git-or-not, the platform and the date, and it
 * injects nothing per request at all — and Aurora was the one mixing them:
 * the workspace path and the file-access rules rode in the per-turn context
 * block, so they were re-sent every time the checklist or the open files moved.
 */
describe("the environment block", () => {
  it("states where the work happens and when, once", () => {
    const env = formatEnvironment({ workspacePath: "E:/project" });
    expect(env).toContain("<env>");
    expect(env).toContain("Workspace root: E:/project");
    expect(env).toMatch(/Today's date: \d{4}-\d{2}-\d{2}/);
  });

  it("carries the standing file-access permission, which is a setting not a turn", () => {
    expect(formatEnvironment({ workspacePath: "E:/p", workspaceAccess: "full" })).toContain(
      "FULL FILE ACCESS",
    );
    expect(formatEnvironment({ workspacePath: "E:/p", workspaceAccess: "full" })).toContain(
      "automatically approves tools and disables command guards",
    );
    expect(formatEnvironment({ workspacePath: "E:/p", workspaceAccess: "read" })).toContain(
      "ALLOWED reading files outside this workspace",
    );
    // Strict says nothing: the workspace line above it already does.
    expect(
      formatEnvironment({ workspacePath: "E:/p", workspaceAccess: "workspace" }),
    ).not.toMatch(/ALLOWED|FULL FILE ACCESS/);
  });

  it("says nothing at all with no project open", () => {
    expect(formatEnvironment({ workspacePath: null })).toBe("");
    expect(formatEnvironment({ workspacePath: "   " })).toBe("");
  });

  it("reaches the composed prompt for a project, and never in chat", async () => {
    const build = await composeAgentSystemPrompt({
      executionMode: "agent",
      promptContext: { userMessage: "hi", workspacePath: "E:/project" },
    });
    expect(build.systemPrompt).toContain("Workspace root: E:/project");

    // Aurora Chat has no workspace, so it has no environment to describe.
    const chat = await composeAgentSystemPrompt({
      executionMode: "chat",
      promptContext: { userMessage: "hi", workspacePath: "E:/project" },
    });
    expect(chat.systemPrompt).not.toContain("<env>");
  });
});

describe("the composed chat prompt", () => {
  const chatOpening = CHAT_MODE_SYSTEM_PROMPT.split("\n")[0];

  it("keeps an active Build instruction profile out of Chat", async () => {
    activeInstructions.text = "PRIVATE BUILD STANDING RULE";
    const chat = await composeAgentSystemPrompt({
      executionMode: "chat",
      promptContext: { userMessage: "hello", workspacePath: "E:/project" },
    });
    const build = await composeAgentSystemPrompt({
      executionMode: "agent",
      promptContext: { userMessage: "hello", workspacePath: "E:/project" },
    });
    expect(chat.systemPrompt).not.toContain(activeInstructions.text);
    expect(build.systemPrompt).toContain(activeInstructions.text);
  });

  it("is the chat prompt even though the caller always passes the coding one", async () => {
    const composed = await composeAgentSystemPrompt({
      // Exactly what `SENSIBLE_DEFAULTS` holds — the untouched default, not an
      // override. Passed verbatim, trailing newline and all.
      basePrompt: BASE_AGENT_SYSTEM_PROMPT,
      executionMode: "chat",
      promptContext: { userMessage: "hello" },
    });

    expect(composed.systemPrompt).toContain(chatOpening);
    expect(composed.systemPrompt).not.toMatch(/advanced AI coding agent/);
    expect(composed.systemPrompt).not.toMatch(/pair programming/);
  });

  it("is the chat prompt when no base prompt is passed at all", async () => {
    const composed = await composeAgentSystemPrompt({
      executionMode: "chat",
      promptContext: { userMessage: "hello" },
    });

    expect(composed.systemPrompt).toContain(chatOpening);
  });

  it("still yields to a caller's own prompt", async () => {
    const composed = await composeAgentSystemPrompt({
      basePrompt: "You are a haiku bot.",
      executionMode: "chat",
      promptContext: { userMessage: "hello" },
    });

    expect(composed.systemPrompt).toContain("You are a haiku bot.");
    expect(composed.systemPrompt).not.toContain(chatOpening);
  });

  it("leaves Build mode on the coding prompt", async () => {
    const composed = await composeAgentSystemPrompt({
      basePrompt: BASE_AGENT_SYSTEM_PROMPT,
      executionMode: "agent",
      promptContext: { userMessage: "hello" },
    });

    expect(composed.systemPrompt).toMatch(/advanced AI coding agent/);
    expect(composed.systemPrompt).not.toContain(chatOpening);
  });
});
