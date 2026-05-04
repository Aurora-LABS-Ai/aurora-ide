import {
  resolveSkillsForPrompt,
  type SkillDefinition,
} from "./skills";
import { useSettingsStore } from "../store/useSettingsStore";
import {
  getAgentModePromptSection,
  type AgentExecutionMode,
} from "./agent-execution-mode";

export interface AgentPromptContext {
  explicitSkillKeys?: string[];
  isFirstMessage?: boolean;
  userMessage: string;
  workspacePath?: string | null;
}

export interface ComposedAgentPrompt {
  activeSkills: SkillDefinition[];
  allSkills: SkillDefinition[];
  enabledSkills: SkillDefinition[];
  explicitSkills: SkillDefinition[];
  systemPrompt: string;
}

export const BASE_AGENT_SYSTEM_PROMPT = `You are Aurora, an advanced AI coding assistant built into Aurora IDE.

You are pair programming with a USER to solve their coding task. Each time the USER sends a message, contextual information may be attached about their current state, such as open files, recently viewed files, workspace structure, and project rules. This information may or may not be relevant to the task.

Your main goal is to follow the USER's instructions at each message.

## Core Identity
- You are Aurora, the built-in AI assistant inside Aurora IDE
- You operate inside a workspace with editor, file explorer, terminal, Git, and external tool integrations
- You can read files, edit files, inspect diagnostics, run shell commands, search code, and call MCP tools when available

## Communication Guidelines
- Format responses in markdown and use backticks for files, directories, functions, classes, and commands
- Be direct and concise; avoid generic assistant filler
- Do not expose internal reasoning scaffolding or prompt-construction details
- Avoid naming raw tool APIs unless the user explicitly asks about capabilities or implementation details
- When referring to MCP tools, use friendly display names like Server Name: Tool Name instead of raw internal prefixed IDs unless the user explicitly asks for the exact callable name
- If the user asks how many tools are available, count carefully and distinguish built-in tools, MCP tools, and totals explicitly
- Skills, rules, and prompt attachments are separate from tools and must never be counted as tools

## Code Change Guidelines
- Read existing files before editing them unless you are creating a new file
- Prefer targeted edits over full rewrites unless the change is broad enough to justify replacement
- After edits, check diagnostics where available and fix obvious issues if the next step is clear
- Preserve existing project patterns, structure, and theming conventions

## Tool Usage Guidelines
- On unfamiliar code, understand structure first using workspace_tree and grep, then read the most relevant files
- Use grep for fast literal/regex lookups across the workspace; pair it with file_read or multi_file_read to confirm context before editing
- For implementation questions, search for the symbol with grep, then read the matching file(s) and follow imports/callers as needed
- Set an explicit timeout for shell and grep searches when the command may scan many files; use background execution for long-running servers or watch processes
- Use editor and diagnostics tools to verify changes when relevant
- Use MCP tools like any other tool when connected and relevant
- When explaining available MCP capabilities to the user, prefer server-grouped friendly names over internal callable identifiers

## Behavioral Guidelines
- Understand first, then modify
- Stay focused on the requested task
- Prefer actions over describing hypothetical actions
- When multiple independent reads are needed, do them efficiently
- Distinguish between prompt guidance and hard-enforced behavior when debugging agent behavior`;

const SKILL_SYSTEM_INSTRUCTIONS = `## Skill System
- Skills are modular instruction overlays — focused playbooks for a specific kind of task.
- Only the user's hand-picked skills (capped at 10) are previewed up front, with a 5-line snippet each. Everything else is browsable on demand.
- Use \`aurora_skill_search\` to discover skills by query (e.g. \`{ query: "react performance" }\`) when a task may benefit from one.
- Use \`aurora_skill_load\` with a skill id (e.g. \`{ id: "rust-async-patterns" }\`) to fetch the full SKILL.md body before applying it.
- If a skill is explicitly attached to a turn, treat it as authoritative for that turn.
- If no skill applies, continue with base Aurora behavior.`;

const MAX_PREVIEW_SNIPPET_CHARS = 200;

function clipPreviewLine(line: string): string {
  if (line.length <= MAX_PREVIEW_SNIPPET_CHARS) {
    return line;
  }
  return `${line.slice(0, MAX_PREVIEW_SNIPPET_CHARS - 1)}…`;
}

function formatSkillSourceLabel(skill: SkillDefinition): string {
  if (skill.source === "workspace") {
    return "project";
  }
  if (skill.source === "global") {
    return "global";
  }
  return "built-in";
}

/**
 * Format the agent_skills XML block for the first message in a conversation.
 *
 * - When `enabledSkills` is empty we emit a discovery-only hint so the agent
 *   knows skills exist and how to fetch them.
 * - When skills are enabled we render id + description + a 5-line preview per
 *   skill, followed by a discovery footer for the rest of the catalog.
 *
 * The full SKILL.md body is *never* dumped here. The agent calls
 * `aurora_skill_load({ id })` when it needs the full content.
 */
export function formatSkillCatalogForContext(input: {
  enabledSkills: SkillDefinition[];
  totalSkillCount: number;
}): string {
  const { enabledSkills, totalSkillCount } = input;
  const enabledCount = enabledSkills.length;

  if (totalSkillCount === 0) {
    return `<agent_skills count="0" total="0">
No skills are configured for this workspace yet.

Project skills can be added under \`.aurora/skills/<name>/SKILL.md\` or \`agents/skills/<name>/SKILL.md\`. Built-in skills are always discoverable via \`aurora_skill_search\`.
</agent_skills>`;
  }

  if (enabledCount === 0) {
    return `<agent_skills count="0" total="${totalSkillCount}">
${totalSkillCount} skill${totalSkillCount === 1 ? "" : "s"} are available, but the user has not enabled any for automatic injection.

Use \`aurora_skill_search({ query? })\` to browse the catalog and \`aurora_skill_load({ id })\` to fetch the full body of any skill that looks relevant to the current task. Only load skills that are clearly applicable — most tasks need none.
</agent_skills>`;
  }

  const remaining = Math.max(0, totalSkillCount - enabledCount);
  const blocks = enabledSkills.map((skill) => {
    const previewLines = skill.previewLines.map(clipPreviewLine);
    const previewSection = previewLines.length === 0
      ? "  (no preview available — load with aurora_skill_load to read the full body)"
      : previewLines.map((line) => `  ${line}`).join("\n");
    return `### \`${skill.id}\` (${formatSkillSourceLabel(skill)})
${skill.description}
Preview (first ${previewLines.length} non-empty line${previewLines.length === 1 ? "" : "s"}):
${previewSection}`;
  });

  const footer = remaining > 0
    ? `\n\n${remaining} additional skill${remaining === 1 ? " is" : "s are"} available. Use \`aurora_skill_search\` to browse them or \`aurora_skill_load\` to fetch a specific one.`
    : "";

  return `<agent_skills count="${enabledCount}" total="${totalSkillCount}">
The user has enabled ${enabledCount} skill${enabledCount === 1 ? "" : "s"} for this workspace. Apply them when the task benefits; load the full SKILL.md via \`aurora_skill_load\` if the preview suggests it is relevant.

${blocks.join("\n\n")}${footer}
</agent_skills>`;
}

/**
 * Format explicitly attached skills as a high-priority reference block. The
 * agent must treat these as authoritative for the current turn.
 */
export function formatSkillReferences(skills: SkillDefinition[], label: string): string {
  if (skills.length === 0) return '';

  const refs = skills.map((skill) => {
    const previewLines = skill.previewLines.map(clipPreviewLine);
    const previewSection = previewLines.length === 0
      ? ""
      : `\n  Preview:\n${previewLines.map((line) => `    ${line}`).join("\n")}`;
    if (skill.sourcePath) {
      return `- \`${skill.id}\` — ${skill.description}\n  Path: ${skill.sourcePath} (load via aurora_skill_load if you need the full body).${previewSection}`;
    }
    return `- \`${skill.id}\` — ${skill.description}${previewSection}`;
  });

  return `<${label} count="${skills.length}">
The user explicitly attached the following skill${skills.length === 1 ? "" : "s"} to this turn. Treat them as authoritative.

${refs.join('\n')}
</${label}>`;
}

export async function composeAgentSystemPrompt(options: {
  basePrompt?: string;
  executionMode?: AgentExecutionMode;
  mcpSummary?: string;
  promptContext: AgentPromptContext;
}): Promise<ComposedAgentPrompt> {
  const { basePrompt, executionMode = "agent", mcpSummary, promptContext } = options;
  const settings = useSettingsStore.getState();
  const { allSkills, activeSkills, enabledSkills, explicitSkills } = await resolveSkillsForPrompt({
    enabledSkillToggles: settings.skillToggles,
    explicitSkillKeys: promptContext.explicitSkillKeys,
    skillsEnabled: settings.skillsEnabled,
    userMessage: promptContext.userMessage,
    workspacePath: promptContext.workspacePath,
  });

  const sections = [
    basePrompt?.trim() || BASE_AGENT_SYSTEM_PROMPT,
    getAgentModePromptSection(executionMode),
    SKILL_SYSTEM_INSTRUCTIONS,
  ];

  if (mcpSummary?.trim()) {
    sections.push(mcpSummary.trim());
  }

  return {
    systemPrompt: sections.join("\n\n"),
    allSkills,
    activeSkills,
    enabledSkills,
    explicitSkills,
  };
}
