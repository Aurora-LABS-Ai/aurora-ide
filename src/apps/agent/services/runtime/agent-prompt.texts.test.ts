/**
 * The system prompt's fixed text, shared with the Rust engine.
 *
 * The engine builds the system prompt from the files in
 * `src-tauri/src/agent_runtime/turn_build/prompts/` (`include_str!`). Until
 * the window stops building turns, the same text also lives here as
 * TypeScript constants. This test keeps the two identical: it fails when
 * either side changes alone. After a deliberate change to the TypeScript
 * text, run with `AURORA_UPDATE_GOLDEN=1` to rewrite the files.
 */

// @ts-expect-error The app intentionally omits Node typings; Vitest itself runs in Node.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  BASE_AGENT_SYSTEM_PROMPT,
  BROWSER_INSTRUCTIONS,
  CANVAS_INSTRUCTIONS,
  CHAPTER_INSTRUCTIONS,
  CHAT_DEFERRED_TOOL_INSTRUCTIONS,
  DEFERRED_TOOL_INSTRUCTIONS,
  SKILL_SYSTEM_INSTRUCTIONS,
  WORKSPACE_ACCESS_RULES,
} from "@/apps/agent/services/runtime/agent-prompt";
import {
  CHAT_MODE_SYSTEM_PROMPT,
  DEEP_RESEARCH_PROMPT,
  getAgentModePromptSection,
} from "@/apps/agent/services/runtime/agent-execution-mode";
import { answerBoxInstructions } from "@/apps/agent/lib/answer-box/instructions";
import { REPLY_LAYOUT_INSTRUCTIONS } from "@/apps/agent/lib/reply-layout/instructions";
import { SURFACE_DOCTRINE_CORE } from "@/apps/agent/services/skills/surface-doctrine";

const node = (globalThis as unknown as {
  process: { cwd: () => string; env: Record<string, string | undefined> };
}).process;
const PROMPTS_DIR = `${node.cwd()}/src-tauri/src/agent_runtime/turn_build/prompts`;
const UPDATE = node.env.AURORA_UPDATE_GOLDEN === "1";

/** File name (without `.md`) → the text the TypeScript side uses. */
const TEXTS: Record<string, string> = {
  "base": BASE_AGENT_SYSTEM_PROMPT,
  "chat-base": CHAT_MODE_SYSTEM_PROMPT,
  "deep-research": DEEP_RESEARCH_PROMPT,
  "mode-agent": getAgentModePromptSection("agent", { hasActivePlan: false }),
  "mode-agent-active-plan": getAgentModePromptSection("agent", { hasActivePlan: true }),
  "mode-plan": getAgentModePromptSection("plan", {}),
  "surface-doctrine": SURFACE_DOCTRINE_CORE,
  "canvas": CANVAS_INSTRUCTIONS,
  "answer-box-build": answerBoxInstructions("build"),
  "answer-box-chat": answerBoxInstructions("chat"),
  "reply-layout": REPLY_LAYOUT_INSTRUCTIONS,
  "skill-system": SKILL_SYSTEM_INSTRUCTIONS,
  "chapters": CHAPTER_INSTRUCTIONS,
  "browser": BROWSER_INSTRUCTIONS,
  "optional-tools": DEFERRED_TOOL_INSTRUCTIONS,
  "optional-tools-chat": CHAT_DEFERRED_TOOL_INSTRUCTIONS,
  "access-read": WORKSPACE_ACCESS_RULES.read,
  "access-full": WORKSPACE_ACCESS_RULES.full,
};

describe("system prompt text shared with the engine", () => {
  it("knows every access level the prompt can state", () => {
    // A new level here needs its own file and a branch in the Rust composer.
    expect(Object.keys(WORKSPACE_ACCESS_RULES).sort()).toEqual(["full", "read", "workspace"]);
    expect(WORKSPACE_ACCESS_RULES.workspace).toBe("");
  });

  it("chat mode has no mode section", () => {
    expect(getAgentModePromptSection("chat", {})).toBe("");
  });

  it.each(Object.keys(TEXTS))("%s.md", (name) => {
    const file = `${PROMPTS_DIR}/${name}.md`;
    if (UPDATE) {
      mkdirSync(PROMPTS_DIR, { recursive: true });
      writeFileSync(file, TEXTS[name], "utf8");
      return;
    }
    expect(existsSync(file), `missing ${file}; run with AURORA_UPDATE_GOLDEN=1`).toBe(true);
    expect(readFileSync(file, "utf8")).toBe(TEXTS[name]);
  });
});
