/**
 * The window's own tool definitions, shared with the Rust engine.
 *
 * The engine builds a turn's tool list from the files in
 * `src-tauri/src/agent_runtime/turn_build/tools/` (`include_str!`): one JSON
 * file per tool the window runs itself (artifacts, skills, `ask_question`),
 * in the exact `{type, function: {name, description, parameters}}` shape
 * `AgentService.buildAvailableTools` sends, plus `report-kind.md`, the text
 * deep research appends to `present_artifact`. Until the window stops
 * building turns the definitions also live here as TypeScript. This test
 * keeps the two identical: it fails when either side changes alone. After a
 * deliberate change to the TypeScript side, run with `AURORA_UPDATE_GOLDEN=1`
 * to rewrite the files.
 */

// @ts-expect-error The app intentionally omits Node typings; Vitest itself runs in Node.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  REPORT_KIND_INSTRUCTIONS,
  presentArtifactTool,
  readArtifactTool,
} from "@/apps/agent/tools/definitions/artifact-tools";
import { askQuestionTool } from "@/apps/agent/tools/definitions/question-tools";
import {
  auroraSkillLoadTool,
  auroraSkillSearchTool,
} from "@/apps/agent/tools/definitions/skill-tools";
import { getToolsForModel } from "@/apps/agent/tools";
import type { ToolDefinition } from "@/apps/agent/tools/types";

const node = (globalThis as unknown as {
  process: { cwd: () => string; env: Record<string, string | undefined> };
}).process;
const TOOLS_DIR = `${node.cwd()}/src-tauri/src/agent_runtime/turn_build/tools`;
const UPDATE = node.env.AURORA_UPDATE_GOLDEN === "1";

/** The order `getToolsForModel()` lists them in, which is the order sent. */
const WINDOW_TOOLS: ToolDefinition[] = [
  presentArtifactTool,
  readArtifactTool,
  auroraSkillSearchTool,
  auroraSkillLoadTool,
  askQuestionTool,
];

/** Exactly the projection `buildAvailableTools` applies before sending. */
const sent = (tool: ToolDefinition) => ({
  type: "function",
  function: {
    name: tool.function.name,
    description: tool.function.description,
    parameters: tool.function.parameters,
  },
});

const write = (file: string, text: string) => {
  mkdirSync(TOOLS_DIR, { recursive: true });
  writeFileSync(file, text, "utf8");
};

describe("window tool definitions shared with the engine", () => {
  it("lists every tool the window runs itself, in the order it sends them", () => {
    // A new window-run tool needs its own file here and a line in the Rust
    // `WINDOW_TOOLS` list (`turn_build/tools.rs`).
    const sentByWindow = getToolsForModel()
      .filter((tool) => !tool.nativeRustOwned)
      .map((tool) => tool.function.name);
    expect(sentByWindow).toEqual(WINDOW_TOOLS.map((tool) => tool.function.name));
  });

  it.each(WINDOW_TOOLS.map((tool) => tool.function.name))("%s.json", (name) => {
    const tool = WINDOW_TOOLS.find((candidate) => candidate.function.name === name)!;
    const json = `${JSON.stringify(sent(tool), null, 2)}\n`;
    const file = `${TOOLS_DIR}/${name}.json`;
    if (UPDATE) {
      write(file, json);
      return;
    }
    expect(existsSync(file), `missing ${file}; run with AURORA_UPDATE_GOLDEN=1`).toBe(true);
    expect(readFileSync(file, "utf8")).toBe(json);
  });

  it("report-kind.md", () => {
    const file = `${TOOLS_DIR}/report-kind.md`;
    if (UPDATE) {
      write(file, REPORT_KIND_INSTRUCTIONS);
      return;
    }
    expect(existsSync(file), `missing ${file}; run with AURORA_UPDATE_GOLDEN=1`).toBe(true);
    expect(readFileSync(file, "utf8")).toBe(REPORT_KIND_INSTRUCTIONS);
  });
});
