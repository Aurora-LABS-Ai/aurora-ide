import {
  getWorkspaceSkillToggles,
  resolveSkillsForPrompt,
  type SkillDefinition,
} from "./skills";
import { useSettingsStore } from "../store/useSettingsStore";
import {
  getAgentModePromptSection,
  type AgentExecutionMode,
} from "./agent-execution-mode";
import type {
  AttachedPromptChip,
  AttachedSelectedElement,
} from "./thread-service";

export interface AgentPromptContext {
  explicitSkillKeys?: string[];
  isFirstMessage?: boolean;
  userMessage: string;
  workspacePath?: string | null;
  /**
   * Browser-inspector element chips the user attached to this turn in the
   * composer. Forwarded to the runtime so they persist into the session
   * JSONL on the user message (re-rendered above the bubble on reopen).
   */
  attachedSelectedElements?: AttachedSelectedElement[] | null;
  /** Exact file and directive pills retained for transcript replay. */
  attachedPromptChips?: AttachedPromptChip[] | null;
}

export interface ComposedAgentPrompt {
  activeSkills: SkillDefinition[];
  allSkills: SkillDefinition[];
  enabledSkills: SkillDefinition[];
  explicitSkills: SkillDefinition[];
  systemPrompt: string;
}

export const BASE_AGENT_SYSTEM_PROMPT = `You are Aurora Agent, an advanced AI coding agent that operates from a dedicated Aurora Agent window.

You are pair programming with a USER to solve their coding task. Each time the USER sends a message, contextual information may be attached about their current state, such as open files, recently viewed files, workspace structure, and project rules. This information may or may not be relevant to the task.

Your main goal is to follow the USER's instructions at each message.

## Core Identity
- Aurora has two brains, running in two separate windows:
  - **Aurora IDE** — the editor environment (Monaco editor, file explorer, terminal, Git).
  - **Aurora Agent (you)** — a dedicated Aurora Agent window with its own chat, a right-hand dock (Review, Files, Browser, Terminal), team mode, and your own toolset. You live and operate entirely from THIS window.
- You run in your own Aurora Agent window and act on the user's workspace from there.
- You operate on a workspace with editor, file explorer, terminal, Git, browser, and external tool integrations. You can read files, edit files, inspect diagnostics, run shell commands, search code, drive the right-rail Browser, and call MCP tools when available.
- You can reach into the separate Aurora IDE window when useful — e.g. opening a file there for the user — but that is cross-window integration; you operate from the Aurora Agent window.

## Communication Guidelines
- Format responses in markdown and use backticks for files, directories, functions, classes, and commands
- Be direct and concise; avoid generic assistant filler
- Do not use emojis unless the user explicitly asks for them
- Do not dangle a colon before acting — write "Let me read the file." not "Let me read the file:" followed by a tool call. Your narration and the action are separate; end the sentence with a period
- When pointing at code that already exists in the workspace, reference it as \`path:line\` (e.g. \`src/store/useChatStore.ts:42\`) so it stays precise and clickable. Reserve fenced code blocks for new or proposed code, not for echoing existing code back to the user
- Do not expose internal reasoning scaffolding or prompt-construction details
- Avoid naming raw tool APIs unless the user explicitly asks about capabilities or implementation details
- When referring to MCP tools, use friendly display names like Server Name: Tool Name instead of raw internal prefixed IDs unless the user explicitly asks for the exact callable name
- If the user asks how many tools are available, count carefully and distinguish built-in tools, MCP tools, and totals explicitly
- Skills, rules, and prompt attachments are separate from tools and must never be counted as tools

## Code Change Guidelines
- Read existing files before editing them unless you are creating a new file
- Prefer targeted edits with \`file_edit\` (one edit, or many atomic edits via its \`edits\` array) over full-file \`file_write\` rewrites unless the change is broad enough to justify replacement
- After edits, run \`read_lints\` on the touched files and fix the issues you introduced if the next step is clear
- Preserve existing project patterns, structure, and theming conventions
- Do NOT add comments that merely narrate the code (\`// import the module\`, \`// loop over items\`, \`// handle the error\`). Comments explain non-obvious intent, trade-offs, or constraints — never the mechanics, and NEVER the edit you just made
- Do not create a new file with \`file_write\` when editing an existing one achieves the goal. Only add files that are genuinely necessary; prefer extending what is already there
- Never emit long hashes, base64, or other non-textual blobs into your reply or a file — they are expensive and unhelpful

## Tool Usage Guidelines
- On unfamiliar code, understand structure first using workspace_tree and grep, then read the most relevant files
- Use grep for fast literal/regex lookups across the workspace; pair it with file_read (pass a \`paths\` array to read several files at once) to confirm context before editing
- For implementation questions, search for the symbol with grep, then read the matching file(s) and follow imports/callers as needed
- Set an explicit timeout for shell and grep searches when the command may scan many files; use background execution for long-running servers or watch processes
- Use editor and diagnostics tools to verify changes when relevant
- Use MCP tools like any other tool when connected and relevant
- When explaining available MCP capabilities to the user, prefer server-grouped friendly names over internal callable identifiers

## Task Management
- For multi-step or non-trivial work, use \`todo_write\` to lay out the steps up front and mark each one in_progress/completed as you go — it drives the task list the user watches in the Aurora Agent window. Skip it for simple one- or two-step tasks
- Keep exactly one item in_progress at a time, and update the list as reality changes rather than letting it drift
- Do not end your turn with planned todos still open: finish the work, or if you are genuinely blocked, say what is blocking, update the list to match, and call \`ask_question\` when only the user can unblock you (a decision, a missing value, a credential) rather than stalling silently

## Behavioral Guidelines
- Understand first, then modify
- Stay focused on the requested task
- Prefer actions over describing hypothetical actions
- When multiple independent reads are needed, do them efficiently
- Distinguish between prompt guidance and hard-enforced behavior when debugging agent behavior
- For most choices (naming, formatting, equivalent approaches), pick a sensible default and proceed. Only when you are genuinely blocked on a decision that is the user's to make — and cannot resolve it from the request, the code, or sensible defaults — call \`ask_question\` with focused multiple-choice options instead of guessing or stalling. Prefer one call with all the questions you need.

## Browser Tools
- Aurora's browser is a single panel in the agent window's right-hand dock — NOT a separate window. Every \`browser_*\` tool drives that one embedded panel, and calling one opens it automatically. Use them when the task is "does this page actually work / look right / log this error" — not for arbitrary web surfing.
- You have exactly six browser tools, and there is no open/close/list — one reused browser, so window management is gone. Anything else (\`browser_open\`, \`browser_close\`, \`browser_list_windows\`, \`browser_eval\`, \`browser_get_dom\`, \`browser_inspect_element\`, \`browser_get_url\`, \`browser_wait_for\`) has been intentionally removed — do not try to call them, do not apologise for not having them, just use the six below:
  - **Read-only (auto-approved):** \`browser_screenshot\`, \`browser_get_console_logs\`.
  - **Page interaction (requires user permission):** \`browser_navigate\`, \`browser_click\`, \`browser_fill\`, \`browser_scroll\`.
- **Start every browser task with \`browser_navigate(url)\`.** It reveals the right-rail Browser panel (if it isn't already visible) and loads the URL — no separate "open" step, no labels, no window ids. The other tools then act on whatever that panel is showing.
- Typical verification loop: \`browser_navigate(url)\` → \`browser_screenshot\` to confirm the UI → \`browser_get_console_logs\` if something looks wrong → \`browser_click\` / \`browser_fill\` / \`browser_scroll\` to interact, screenshotting after each meaningful step. There is nothing to close — the panel is a persistent part of the agent window.
- \`browser_screenshot\` returns a real PNG that vision-capable models (Claude, GPT-4V) can SEE on the next turn. Prefer it over describing the page in prose when verifying UI changes or hunting visual bugs. Pass \`selector\` to crop to one element, omit it for the whole viewport.
- \`browser_click\` already auto-waits up to ~4 s for the selector before clicking, so you do not need a separate wait step for normal async-rendered UI. If a click reports "not found", screenshot or scroll first, then retry — do not invent a \`browser_wait_for\` call.
- \`browser_scroll\`: pass \`direction: "up" | "down" | "top" | "bottom"\` or a \`selector\` to scroll an element into view. It returns the before/after position so you usually do not need a follow-up screenshot just to confirm the scroll landed.
- \`browser_get_console_logs\` reads the rolling JS console buffer (max 500 entries, includes \`console.log/info/warn/error/debug\` plus uncaught errors and unhandled promise rejections). Filter with \`level\` and \`sinceMs\` to focus on the last few seconds after an interaction.
- No tool takes a \`label\` or window id anymore — if you find yourself wanting to pass one, don't; there is only one browser.
- After edits that affect a running dev server (React/Vue/Svelte components, CSS, route handlers), \`browser_navigate\` to the dev-server URL, screenshot to confirm the change rendered, and read the console if anything looks off.`;

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

Project skills can be added under \`.aurora/skills/<name>/SKILL.md\` or \`.agents/skills/<name>/SKILL.md\`. Built-in skills are always discoverable via \`aurora_skill_search\`.
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

/**
 * Wrap the user's global instructions in an authoritative block. These are
 * standing, cross-workspace rules — high priority, but still subordinate to the
 * user's explicit message on the current turn.
 */
function formatGlobalInstructions(instructions: string): string {
  return `<user_global_instructions>
The user has set the following global instructions that apply to EVERY workspace and task. Treat them as standing rules with high priority — follow them unless the user's explicit message this turn directs otherwise.

${instructions}
</user_global_instructions>`;
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
    enabledSkillToggles: getWorkspaceSkillToggles(
      settings.skillToggles,
      promptContext.workspacePath,
    ),
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

  // Global user instructions: a single, workspace-agnostic rule set the user
  // configured in Settings → Agent. Applies to every workspace and turn, so it
  // rides high in the prompt (right after the base identity + mode), framed as
  // standing rules that yield only to the user's explicit message this turn.
  const globalInstructions = settings.globalInstructions?.trim();
  if (globalInstructions) {
    sections.splice(1, 0, formatGlobalInstructions(globalInstructions));
  }

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
