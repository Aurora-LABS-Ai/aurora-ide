/**
 * Golden files for the system prompt the window composes today.
 *
 * Phase 3 of `DOCS/rust-core-extraction.md` moves turn building into the
 * Rust engine. Before any of it moves, this records the exact bytes
 * `composeAgentSystemPrompt` produces for a fixed set of cases, into
 * `src-tauri/src/agent_runtime/turn_build/golden/system-prompt/`. The Rust
 * port is done when it reads the same inputs and writes the same bytes;
 * until then this test stops the TypeScript side drifting unnoticed.
 *
 * Inputs a case cannot fix by itself are pinned here: the date, the settings,
 * the active plan, and the skills the resolver returns. The skill resolver
 * (which skills exist and which are on) is its own port and its own goldens.
 *
 * A deliberate prompt change: run with `AURORA_UPDATE_GOLDEN=1`, read the
 * diff, commit the new files with the change.
 */

// @ts-expect-error The app intentionally omits Node typings; Vitest itself runs in Node.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { SkillDefinition } from "@/apps/agent/services/skills/skills";
import { composeAgentSystemPrompt } from "@/apps/agent/services/runtime/agent-prompt";
import type { AgentExecutionMode } from "@/apps/agent/services/runtime/agent-execution-mode";

const pinned = vi.hoisted(() => ({
  settings: {
    skillToggles: {},
    skillsEnabled: true,
    workspaceAccess: "workspace" as string,
  },
  globalInstructions: "",
  activePlan: false,
  skills: {
    allSkills: [] as SkillDefinition[],
    activeSkills: [] as SkillDefinition[],
    enabledSkills: [] as SkillDefinition[],
    explicitSkills: [] as SkillDefinition[],
  },
}));

vi.mock("@/apps/agent/services/skills/skills", () => ({
  getWorkspaceSkillToggles: () => ({}),
  resolveSkillsForPrompt: async () => pinned.skills,
}));

vi.mock("@/apps/agent/services/plans/agent-plans", () => ({
  getActivePlan: async () => (pinned.activePlan ? { id: "plan" } : null),
}));

vi.mock("@/apps/agent/store/settings/useAgentSettingsStore", () => ({
  useAgentSettingsStore: { getState: () => pinned.settings },
  selectActiveGlobalInstructions: () => pinned.globalInstructions,
}));

const node = (globalThis as unknown as {
  process: { cwd: () => string; env: Record<string, string | undefined> };
}).process;
const GOLDEN_DIR = `${node.cwd()}/src-tauri/src/agent_runtime/turn_build/golden/system-prompt`;
const UPDATE = node.env.AURORA_UPDATE_GOLDEN === "1";

const skill = (id: string, source: SkillDefinition["source"], sourcePath?: string): SkillDefinition => ({
  id,
  name: id,
  description: `What ${id} is for.`,
  content: "",
  previewLines: [`# ${id}`, "First rule of this skill.", "Second rule."],
  source,
  sourcePath,
  storageKey: id,
  triggers: [],
});

interface GoldenCase {
  name: string;
  mode: AgentExecutionMode;
  workspacePath?: string | null;
  workspaceAccess?: string;
  projectRules?: string;
  globalInstructions?: string;
  activePlan?: boolean;
  transcriptChapters?: boolean;
  replyLayout?: boolean;
  deepResearch?: boolean;
  browserTools?: boolean;
  skills?: Partial<typeof pinned.skills>;
}

const PROJECT = "E:\\work\\shop";
const RULES = '<project_rules>\n<rule name="style.md">\nUse tabs.\n</rule>\n</project_rules>';
const two = [skill("react-perf", "workspace", "E:\\work\\shop\\.aurora\\skills\\react-perf\\SKILL.md"), skill("rust-async", "global")];

const CASES: GoldenCase[] = [
  { name: "agent-default", mode: "agent", workspacePath: PROJECT },
  { name: "agent-no-workspace", mode: "agent", workspacePath: null },
  { name: "agent-browser-off", mode: "agent", workspacePath: PROJECT, browserTools: false },
  {
    name: "agent-everything-on",
    mode: "agent",
    workspacePath: PROJECT,
    workspaceAccess: "full",
    projectRules: RULES,
    globalInstructions: "Answer in British English.",
    transcriptChapters: true,
    replyLayout: true,
  },
  { name: "agent-read-access", mode: "agent", workspacePath: PROJECT, workspaceAccess: "read" },
  {
    name: "agent-skills",
    mode: "agent",
    workspacePath: PROJECT,
    skills: { allSkills: [...two, skill("extra", "builtin")], enabledSkills: two, explicitSkills: [two[0]] },
  },
  { name: "agent-skills-none-enabled", mode: "agent", workspacePath: PROJECT, skills: { allSkills: two } },
  { name: "plan-default", mode: "plan", workspacePath: PROJECT },
  { name: "plan-active-plan", mode: "plan", workspacePath: PROJECT, activePlan: true },
  { name: "agent-active-plan", mode: "agent", workspacePath: PROJECT, activePlan: true },
  { name: "chat-default", mode: "chat", workspacePath: PROJECT, globalInstructions: "Ignored in chat." },
  { name: "chat-deep-research-layout", mode: "chat", deepResearch: true, replyLayout: true, transcriptChapters: true },
];

const TODAY = "2026-10-27";

/** A skill as the engine's composer reads it (`turn_build::prompt::PromptSkill`). */
const promptSkill = (s: SkillDefinition) => ({
  id: s.id,
  description: s.description,
  previewLines: s.previewLines,
  source: s.source,
  sourcePath: s.sourcePath ?? null,
});

/**
 * One case's inputs in the shape `turn_build::prompt::SystemPromptInput`
 * deserializes, so the Rust test composes from exactly these.
 */
const engineInput = (c: GoldenCase) => ({
  name: c.name,
  input: {
    mode: c.mode,
    workspacePath: c.workspacePath ?? null,
    workspaceAccess: c.workspaceAccess ?? "workspace",
    projectRules: c.projectRules ?? null,
    globalInstructions: c.globalInstructions ?? "",
    hasActivePlan: c.activePlan ?? false,
    transcriptChapters: c.transcriptChapters ?? false,
    replyLayout: c.replyLayout ?? false,
    deepResearch: c.deepResearch ?? false,
    browserTools: c.browserTools ?? true,
    today: TODAY,
    skills: {
      totalCount: c.skills?.allSkills?.length ?? 0,
      enabled: (c.skills?.enabledSkills ?? []).map(promptSkill),
      explicit: (c.skills?.explicitSkills ?? []).map(promptSkill),
    },
  },
});

describe("system prompt golden files", () => {
  beforeAll(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(`${TODAY}T09:00:00Z`));
    if (UPDATE) mkdirSync(GOLDEN_DIR, { recursive: true });
  });
  afterAll(() => vi.useRealTimers());

  it("cases.json holds every case's inputs for the engine", () => {
    const json = `${JSON.stringify(CASES.map(engineInput), null, 2)}\n`;
    const file = `${GOLDEN_DIR}/cases.json`;
    if (UPDATE) {
      writeFileSync(file, json, "utf8");
      return;
    }
    expect(readFileSync(file, "utf8")).toBe(json);
  });

  it.each(CASES)("$name", async (c) => {
    pinned.settings.workspaceAccess = c.workspaceAccess ?? "workspace";
    pinned.globalInstructions = c.globalInstructions ?? "";
    pinned.activePlan = c.activePlan ?? false;
    pinned.skills = {
      allSkills: [],
      activeSkills: [],
      enabledSkills: [],
      explicitSkills: [],
      ...c.skills,
    };
    const { systemPrompt } = await composeAgentSystemPrompt({
      executionMode: c.mode,
      promptContext: {
        userMessage: "Add a checkout button.",
        workspacePath: c.workspacePath,
        projectRules: c.projectRules,
      },
      transcriptChapters: c.transcriptChapters,
      replyLayout: c.replyLayout,
      deepResearch: c.deepResearch,
      browserTools: c.browserTools,
    });

    const file = `${GOLDEN_DIR}/${c.name}.txt`;
    if (UPDATE) {
      writeFileSync(file, systemPrompt, "utf8");
      return;
    }
    expect(existsSync(file), `missing ${file}; run with AURORA_UPDATE_GOLDEN=1`).toBe(true);
    expect(systemPrompt).toBe(readFileSync(file, "utf8"));
  });
});
