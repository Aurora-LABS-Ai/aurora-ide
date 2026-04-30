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
  explicitSkills: SkillDefinition[];
  matchedSkills: SkillDefinition[];
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
- On unfamiliar code, understand structure first using workspace-aware context, native Aurora search, or tree inspection
- Use aurora_search for indexed codebase discovery: use target="symbols" for functions/files/routes/tools and target="chunks" for source snippets; use grep for exact string lookup
- If Aurora search reports the workspace is not indexed or the model path is missing, tell the user the workspace must be indexed from Settings > Semantic Search before semantic/graph search is available
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
- Skills are modular instruction overlays that extend your behavior for specific task types.
- The available skill catalog is included in the first message of each conversation (not repeated).
- When a skill is relevant, use file_read to load the skill file from its path to get detailed instructions.
- If the user explicitly attaches a skill, its name and path are noted in the user message. Read and follow it.
- Auto-matched skills may also be noted. Read them if the task benefits from their guidance.
- If no skill applies, continue with base Aurora behavior.`;

/**
 * Format skill catalog for embedding in the first user message context.
 * Only includes name, description, and file path - NOT full content.
 * The agent reads skill files on demand via file_read.
 */
export function formatSkillCatalogForContext(skills: SkillDefinition[]): string {
  if (skills.length === 0) return '';

  const lines = skills.map((skill) => {
    const pathNote = skill.sourcePath ? ` (path: ${skill.sourcePath})` : ' (built-in)';
    return `- \`${skill.id}\`: ${skill.description}${pathNote}`;
  });

  return `<agent_skills description="Available skills. Use file_read on the path to load full instructions when relevant.">
${lines.join('\n')}
</agent_skills>`;
}

/**
 * Format explicitly attached or auto-matched skills as lightweight references.
 * Only name + path, no full content. Agent reads via file_read.
 */
export function formatSkillReferences(skills: SkillDefinition[], label: string): string {
  if (skills.length === 0) return '';

  const refs = skills.map((skill) => {
    if (skill.sourcePath) {
      return `- \`${skill.name}\` — read from: ${skill.sourcePath}`;
    }
    return `- \`${skill.name}\` (built-in): ${skill.content}`;
  });

  return `<${label} count="${skills.length}">
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
  const { allSkills, activeSkills, explicitSkills, matchedSkills } = await resolveSkillsForPrompt({
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
    explicitSkills,
    matchedSkills,
  };
}
