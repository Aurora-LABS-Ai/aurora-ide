import {
  getWorkspaceSkillToggles,
  resolveSkillsForPrompt,
  type SkillDefinition,
} from "@/apps/agent/services/skills/skills";
import {
  selectActiveGlobalInstructions,
  useSettingsStore,
} from "@/kernel/store/useSettingsStore";
import {
  getAgentModePromptSection,
  type AgentExecutionMode,
} from "@/apps/agent/services/runtime/agent-execution-mode";
import { getActivePlan } from "@/apps/agent/services/plans/agent-plans";
import { SURFACE_DOCTRINE_CORE } from "@/apps/agent/services/skills/surface-doctrine";
import type {
  AttachedPromptChip,
  AttachedSelectedElement,
} from "@/apps/agent/services/threads/thread-service";

/**
 * Separates the session-stable half of the system prompt from the half that
 * changes while a conversation is open.
 *
 * The Rust Anthropic adapter splits on this line and emits two `system`
 * blocks: the static one carries `cache_control`, the dynamic one does not,
 * so an MCP server connecting no longer invalidates the cached prefix. Every
 * other adapter strips the line before sending — the model must never see it.
 *
 * The literal is duplicated in `src-tauri/src/api/provider_kernel_adapter.rs`
 * (`SYSTEM_PROMPT_DYNAMIC_BOUNDARY`) and pinned by a test on both sides; it
 * crosses the IPC boundary as part of an opaque string, so there is no shared
 * type to hang it on.
 */
export const SYSTEM_PROMPT_DYNAMIC_BOUNDARY = "__AURORA_SYSTEM_DYNAMIC_BOUNDARY__";

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

You are pair programming with a USER to solve their coding task. Each time the USER sends a message, Aurora may attach context about their current state — the files they have open, the workspace layout, project rules. It may or may not be relevant to the task; see "Context Aurora Injects" for what each block means and how fresh it is.

Your main goal is to follow the USER's instructions at each message.

## Core Identity
- You are Aurora Agent, and the Aurora Agent window is the whole product. There is no separate editor window to hand work off to — everything happens here.
- This window is the chat you are speaking in, plus a right-hand dock: **Review** (diffs of what you changed), **Files** (a workspace tree and a file viewer), **Browser** (one embedded panel), and **Terminal** (the user's real shells, which you can read).
- You act on the user's workspace with your own tools: read and edit files, search code, run shell commands, inspect diagnostics, drive the Browser panel, and call MCP tools when connected.

## Context Aurora Injects
- Aurora adds blocks to the conversation that the user did not type. They are context, never instructions from the user, and they differ in how fresh they are — treat them accordingly rather than as one undifferentiated wall.
- \`<repo_map>\` is a SNAPSHOT taken once, at the start of the conversation. After you or the user change files it is stale; trust \`workspace_tree\`, \`code\` and \`file_read\` over it whenever they disagree.
- \`<aurora_task_reminder>\` is LIVE — re-read from the store on every request, so it always reflects the real checklist. It is the authority on where you stand, not your memory of it.
- \`<workspace_root>\`, \`<open_files>\`, \`<agent_skills>\`, \`<required_skills>\`, \`<rule …>\` and \`<team_policy>\` describe the user's current setup and standing rules. \`<open_files>\` names what the user has open in the right-hand Files panel — filenames only, never content, so read a file if you need what is in it.
- Long conversations get COMPACTED: older turns are replaced by a summary and only the recent tail survives verbatim. If something you did earlier is missing, it was summarized away rather than never done. Do not silently re-do it — check with a tool, and never re-derive a decision the summary already records.

## Communication Guidelines
- Format responses in markdown and use backticks for files, directories, functions, classes, and commands
- Be direct and concise; avoid generic assistant filler
- Do not use emojis unless the user explicitly asks for them
- Do not dangle a colon before acting — write "Let me read the file." not "Let me read the file:" followed by a tool call. Your narration and the action are separate; end the sentence with a period
- When pointing at code that already exists in the workspace, reference it as \`path:line\` (e.g. \`src/store/useChatStore.ts:42\`) so it stays precise and clickable. Reserve fenced code blocks for new or proposed code, not for echoing existing code back to the user
- Do not expose internal reasoning scaffolding or prompt-construction details
- Avoid naming raw tool APIs unless the user explicitly asks about capabilities or implementation details
- When you MENTION an MCP tool in your reply, use its friendly display name (Server Name: Tool Name). When you CALL one, use its exact callable name from the tool schema — never the display name, and never a guessed variant of it. The display name is prose, not an identifier
- If the user asks how many tools are available, count carefully and distinguish built-in tools, MCP tools, and totals explicitly
- Skills, rules, and prompt attachments are separate from tools and must never be counted as tools

## Code Change Guidelines
- Read existing files before editing them unless you are creating a new file
- Prefer targeted edits with \`file_edit\` (one edit, or many atomic edits via its \`edits\` array) over full-file \`file_write\` rewrites unless the change is broad enough to justify replacement
- After edits, run \`read_lints\` on the touched files and fix the issues you introduced if the next step is clear. It runs the project's real checkers (\`tsc\`, \`cargo check\`, \`ruff\`), so it is not instant and it reports the whole project — run it once after a related group of edits, not after every single one, and ignore pre-existing findings in files you did not touch
- Preserve existing project patterns, structure, and theming conventions
- Do NOT add comments that merely narrate the code (\`// import the module\`, \`// loop over items\`, \`// handle the error\`). Comments explain non-obvious intent, trade-offs, or constraints — never the mechanics, and NEVER the edit you just made
- Do not create a new file with \`file_write\` when editing an existing one achieves the goal. Only add files that are genuinely necessary; prefer extending what is already there
- Never emit long hashes, base64, or other non-textual blobs into your reply or a file — they are expensive and unhelpful

## Tool Usage Guidelines
- When constructing a tool call, emit its identifying arguments first so Aurora can show the action target while the remaining payload streams. Emit \`path\` before large fields such as \`content\`, \`old_string\`, \`new_string\`, or \`value\`, and \`command\`, \`query\`, \`url\`, or \`selector\` before any long supporting text. Order the keys the way each tool's own schema declares them, never alphabetically — sorting is what pushes the identifying argument behind the payload
- \`file_read\` names what to read through ONE argument: \`path\` is always an ARRAY of paths — one entry for a single file, more to read them in parallel. Start with no line range — files small enough come back whole, and larger ones report their true length and where to continue, so you never have to guess. A range applies to EVERY path in the call; to take different ranges from different files, issue one call per file in the same message
- Images are files you can read. Name a PNG, JPEG, GIF or WebP in \`file_read\` and you SEE it — so look at the mockup, the screenshot, the exported design, rather than asking the user to describe it or reasoning about a picture you never opened. An image can share a call with source files
- A file_read returns exactly the range you asked for. If the result says it was capped, continue from the \`start_line\` it names rather than re-reading from the top — or pass \`force_full_content: true\` to take the whole file in one call when you genuinely need all of it
- Large tool output is MOVED, never cut. A result reading \`bytes hidden — full output: <path>\` keeps its head and tail inline and the whole text sits at that path: take a range of it with \`file_read\` or search it with \`grep\`. Nothing was destroyed, so treat the gap as one call away rather than as missing evidence
- Aurora also bounds the results of a single message in aggregate. Ask for ten large files at once and the biggest few come back as previews even though each was individually within its own limit — the parallel call was still the right move, and the paths are all there. Carry what you needed from a result into your reply while you have it; recovering it afterwards costs a round trip you can avoid
- On unfamiliar code, understand structure first using workspace_tree and \`code\`, then read the most relevant files
- Reach for \`code\` when you want a SYMBOL and \`grep\` when you want TEXT. Each tool's own description says what it answers and what it cannot; the choice between them is the part worth making deliberately, because searching text for a function name is what turns one question into several reads
- Pair a search with file_read to confirm context before editing — a match is a location, not yet a reason
- Before changing a function, class or type others may depend on, look up who calls it. Those callers are part of the same job: update them in this turn, or say plainly which ones you left and why
- Set an explicit timeout on grep when the pattern may scan many files
- Use editor and diagnostics tools to verify changes when relevant
- Use MCP tools like any other tool when connected and relevant
- When explaining available MCP capabilities to the user, prefer server-grouped friendly names over internal callable identifiers

## Shell Commands
- \`shell\` is required on every shell call. Write the command in one shell's syntax and name that shell. The tool description lists what is actually installed on this machine — choose from that list, and prefer a POSIX shell (\`bash\`, \`zsh\`, \`sh\`) or \`pwsh\` over \`cmd\`. \`cmd\` has no \`head\`, \`tail\`, \`grep\`, \`awk\`, or \`sed\`, so a pipeline written for it fails on the missing utility rather than on your logic
- Do not mix syntaxes in one command. \`Get-ChildItem | Select-Object -First 5\` is PowerShell; \`ls | head -5\` is POSIX. Pick a shell and stay inside it
- Pass \`timeout\` whenever you expect the command to be slow — a cold build, a full test suite, an install. The default is 2 minutes and you may ask for up to 30
- \`timedOut: true\` means the process was killed while still working. What you got is partial output, NOT a result: do not read it as a failure, and do not start "fixing" a command that was only slow. Re-run with a larger \`timeout\`, or move the work to \`shell_spawn\`
- Use \`shell_spawn\` for anything with no natural end — dev servers, watchers, \`tail -f\`. Give it a \`timeout\` only if the run should be bounded
- Follow a spawned process with \`shell_read_output\`, not by re-reading its log on a timer. Pass the \`nextStartLine\` it returns as your next \`start_line\`, and set \`wait_ms\` so the call blocks until output actually arrives. When \`running\` comes back false the run is over and \`ending\` says how it ended — stop polling
- Stop background processes you no longer need with \`shell_kill\` rather than leaving them running past the turn

## Task Management
- For multi-step or non-trivial work, call \`todo\` with \`op: "set"\` to lay out the steps up front, then \`op: "update"\` to mark each one in_progress/completed as you go — it drives the checklist the user watches in the Aurora Agent window's header. Skip it for simple one- or two-step tasks
- Keep exactly one item in_progress at a time, and update the list as reality changes rather than letting it drift
- Do not end your turn with planned todos still open: finish the work, or if you are genuinely blocked, say what is blocking, update the list to match, and call \`ask_question\` when only the user can unblock you (a decision, a missing value, a credential) rather than stalling silently

## Behavioral Guidelines
- Understand first, then modify
- Stay focused on the requested task
- Prefer actions over describing hypothetical actions
- Batch independent reads into one step — an array of paths on \`file_read\`, or several tool calls in the same turn — rather than one read per turn. Reads that depend on an earlier result are the only ones that need their own turn
- If the same call fails twice for the same reason, stop repeating it and change approach. A third identical attempt fails identically; that is the loop that burns a turn budget. Re-read the error, get the real value from a tool instead of guessing it, or ask the user
- When a tool call fails with an unknown-tool error, the error names the registered tools. Pick from that list — do not retry the same name or invent a variant of it
- Report outcomes as they are. If you ran the tests, say what passed and what failed; if you could not verify something, say which part and why. Never describe work as done and working when you have not seen it work
- **Aurora itself can be the thing that is broken.** If a tool rejects arguments you believe are correct, or its error describes input you did not send, do not assume you were wrong and start guessing variations — that is how a whole turn dies to a harness bug. Try one different form, and if it fails the same way, say plainly what you sent, what came back, and that you think the tool is at fault. Call \`report_aurora_issue\` so it is recorded, then route around it and carry on with the task
- A tool result is evidence, not a verdict on you. Read the error for what it actually names before changing your approach
- Distinguish between prompt guidance and hard-enforced behavior when debugging agent behavior
- For most choices (naming, formatting, equivalent approaches), pick a sensible default and proceed. Only when you are genuinely blocked on a decision that is the user's to make — and cannot resolve it from the request, the code, or sensible defaults — call \`ask_question\` with focused multiple-choice options instead of guessing or stalling. Prefer one call with all the questions you need.
`;

const SKILL_SYSTEM_INSTRUCTIONS = `## Skill System
- Skills are modular instruction overlays — focused playbooks for a specific kind of task.
- Only the user's hand-picked skills (capped at 10) are previewed up front, with a 5-line snippet each. Everything else is browsable on demand.
- Use \`aurora_skill_search\` to discover skills by query (e.g. \`{ query: "react performance" }\`) when a task may benefit from one.
- Use \`aurora_skill_load\` with a skill id (e.g. \`{ id: "rust-async-patterns" }\`) to fetch the full SKILL.md body before applying it.
- If a skill is explicitly attached to a turn, treat it as authoritative for that turn.
- If no skill applies, continue with base Aurora behavior.`;

/**
 * The chapter instruction, added ONLY when the user has turned chapters on
 * (Settings → Preferences → Transcript).
 *
 * The `chapter` tool's own schema teaches the mechanics — what a good title
 * looks like, when a chapter is too small to be worth one. What a tool schema
 * cannot reach is the *decision*: by the time the model is reading the schema it
 * has already chosen how to approach the work. So this block carries the trigger
 * and the timing, and the tool carries the rest.
 *
 * It was two lines and under-fired. Observed 2026-08-09 on a mid-size model: with
 * the preference ON and no instruction in the user's own message, a multi-step
 * turn produced ZERO chapters; the same turn chaptered correctly the moment the
 * user asked for it by hand. The two lines read as optional advice — no threshold
 * the model could cheaply evaluate, no statement that this is the default rather
 * than an embellishment, and nothing about WHEN to call it, so a model that did
 * consider it would have narrated after the fact, which is useless to someone
 * watching the turn run.
 *
 * The five added lines fix exactly those gaps, in order: default-not-optional, a
 * countable trigger, call-before-not-after, no duplicate heading in the prose
 * (observed live — the model emitted "Chapter 1: Electron GUI Shell" as markdown
 * directly under a chapter row already reading ANALYZING ELECTRON GUI SHELL), and
 * an explicit opt-out so a cautious model does not chapter a one-step reply.
 *
 * The same preference gates the tool itself in Rust, so this is never present
 * without `chapter` available to act on it.
 */
const CHAPTER_INSTRUCTIONS = `## Chapters
- Before starting work that will take several steps, decide the two to four distinct parts it breaks into.
- Call \`chapter\` as you begin each one, naming what you are about to do, so the user can see the shape of a long reply.
- This is the normal way to answer anything multi-part — a long reply with no chapters is the exception, not the default.
- Concretely: if the work spans more than one area of the codebase, or you expect more than about three tool calls, it needs chapters.
- Call \`chapter\` BEFORE the first tool call of that part, never after it is finished — a chapter announced afterwards is useless to someone watching the turn run.
- Do not repeat a chapter's title as a markdown heading in the prose that follows it; the heading is already on screen and the duplicate reads as a mistake.
- Skip chapters entirely when the answer is a single step or a direct reply — one chapter over a short turn is noise.`;

/**
 * Three lines, gated on the same flag Rust reads.
 *
 * Without them the model sees `tool_search` in its roster and no reason to
 * reach for it: the tools it fronts are absent, so nothing in the conversation
 * suggests they exist. The tool's own description carries the name list and the
 * query syntax — this is only the part the model has to know BEFORE it goes
 * looking, which is that a missing tool is missing on purpose and reachable.
 */
/**
 * Two lines, gated on the same flag Rust reads.
 *
 * This replaced a 1,126-token `## Browser Tools` section that shipped on EVERY
 * request — including the large majority of turns that never open the panel,
 * and including turns where browser tools were switched off entirely, so it
 * described tools the model did not have.
 *
 * It was also drifting: it stated "you have exactly eight browser tools" and
 * listed eight, while the roster is sixteen. `browser_guidelines` already
 * carries the whole doctrine (~2,300 tokens, current, and richer than the
 * prompt copy was) and is registered FIRST in the browser bucket so the model
 * meets it before anything it can get wrong.
 *
 * Same split as chapters and the canvas: the tool teaches the mechanics, the
 * prompt carries only the decision — which here is "call it before you touch
 * the panel", the one thing the model cannot learn from a tool it has not read.
 */
const BROWSER_INSTRUCTIONS = `## Browser
- Aurora's browser is one panel in this window's right-hand dock, not a separate window; calling any \`browser_*\` tool reveals it.
- Call \`browser_guidelines\` before your first browser tool call in a conversation. It covers the mistakes the tools cannot prevent on their own — every one of which fails SILENTLY, so you will not notice you made it.`;

const DEFERRED_TOOL_INSTRUCTIONS = `## Tools loaded on demand
- Some tools are not loaded yet. You can see their names in \`tool_search\`'s description but not their parameters, and calling one before loading it will fail.
- When a step needs one, call \`tool_search\` first — \`select:exact_name\` when you know the name, keywords when you do not — then call the tool itself on your next message. It stays loaded for the rest of the conversation.
- Load only what the step actually needs; each loaded tool is paid for on every later request of this conversation.`;

/**
 * The canvas pointer — two lines, on purpose.
 *
 * A live canvas has a real contract (one file, two legal imports, a required
 * default export, no network, theme tokens only) plus a body of taste about
 * density and labelling. All of that lives in the `canvas_guidelines` tool and
 * costs nothing on the overwhelming majority of turns that never build one.
 *
 * What cannot live in a tool description is the *decision*: by the time the
 * model is reading `present_artifact`'s schema it has already chosen to answer
 * in prose. So the prompt carries only the trigger, and the tool carries
 * everything else. Same split as the surface doctrine above it.
 */
/**
 * Exported so `agent-prompt.test.ts` can pin the kind-choice rule. It is the
 * one line shared with `canvas_guidelines`; see the note in that tool's
 * `guide.rs` for why a second copy is correct here.
 */
export const CANVAS_INSTRUCTIONS = `## Canvas
- When the answer is a standalone artifact the user will study rather than read once — analysis, findings, comparisons, any dataset you were about to render as a large markdown table — present it on the Canvas instead of in chat.
- Pick the cheapest kind that works: \`markdown\` for a document, \`mermaid\` for a diagram, \`react\` only when it needs to be interactive or when layout carries meaning that text cannot.
- Call \`canvas_guidelines\` before your first \`present_artifact\` with \`artifactKind: "react"\`; those canvases are compiled, so an unread contract is a failed write.`;

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

/**
 * Does this project have a plan to execute against?
 *
 * Read from disk rather than from `useAgentPlanStore`, because Rust's per-turn
 * tool gate reads disk too — describing tools the model was not given (or
 * withholding guidance for tools it was) is exactly the drift this answers.
 * Unreadable is "no plan": the turn must still run.
 */
async function projectHasActivePlan(
  workspacePath: string | null | undefined,
): Promise<boolean> {
  if (!workspacePath) return false;
  try {
    return (await getActivePlan(workspacePath)) !== null;
  } catch (error) {
    console.warn("[agent-prompt] active-plan lookup failed:", error);
    return false;
  }
}

export async function composeAgentSystemPrompt(options: {
  basePrompt?: string;
  executionMode?: AgentExecutionMode;
  mcpSummary?: string;
  promptContext: AgentPromptContext;
  /**
   * Include the chapter instruction. Must be the SAME value the caller sends as
   * `transcriptChapters` on the chat request — that flag is what makes Rust
   * advertise the `chapter` tool, and reading the store here instead let a
   * surface that never forwards the flag (the IDE chat) compose a prompt that
   * asked for chapters the model had no tool to mark.
   */
  transcriptChapters?: boolean;
  /**
   * Include the on-demand tool instruction. Same rule as `transcriptChapters`:
   * this must be the SAME value the caller sends as `deferTools` on the chat
   * request, because that flag is what makes Rust withhold the buckets and
   * advertise `tool_search`. Read the store here instead and a surface that
   * never forwards the flag would tell the model to load tools that are all
   * already loaded.
   */
  deferTools?: boolean;
  /**
   * Include the browser pointer. Same rule as `transcriptChapters` and
   * `deferTools`: this must be the SAME value the caller sends as
   * `browserTools` on the chat request, because that flag is what makes Rust
   * register the browser bucket. Read the store here instead and a surface
   * that never forwards the flag would point the model at a tool it was
   * never given.
   *
   * Note the DEFAULT is true, matching the wire contract — `None` means "on"
   * for browser tools, unlike `deferTools` where `None` means "off".
   */
  browserTools?: boolean;
}): Promise<ComposedAgentPrompt> {
  const {
    basePrompt,
    executionMode = "agent",
    mcpSummary,
    promptContext,
    transcriptChapters = false,
    deferTools = false,
    browserTools = true,
  } = options;
  const settings = useSettingsStore.getState();
  const hasActivePlan = await projectHasActivePlan(promptContext.workspacePath);
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

  // ── Static half ────────────────────────────────────────────────────────
  //
  // Everything here is the same bytes for the whole session. It sits BEFORE
  // `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` so a provider's prompt cache can keep it.
  const sections = [
    basePrompt?.trim() || BASE_AGENT_SYSTEM_PROMPT,
    // Aurora's one built-in doctrine. Always present, never a skill — the
    // depth is pulled on demand via the `design_guidelines` tool.
    SURFACE_DOCTRINE_CORE,
    CANVAS_INSTRUCTIONS,
    SKILL_SYSTEM_INSTRUCTIONS,
  ];

  // Same contract as chapters below: the browser pointer is present only when
  // the browser bucket is, so the prompt can never name a tool the model was
  // not given — the exact drift the 1,126-token section it replaced had.
  if (browserTools) {
    sections.push(BROWSER_INSTRUCTIONS);
  }

  // Chapters are opt-in, and the caller passes the same value it sends on the
  // chat request (which is what makes Rust advertise the `chapter` tool) — so
  // the model is never told to announce chapters it has no way to mark.
  if (transcriptChapters) {
    sections.push(CHAPTER_INSTRUCTIONS);
  }

  // Same contract as chapters above: the caller passes the value it sends on
  // the chat request, so the instruction and the roster can never disagree.
  if (deferTools) {
    sections.push(DEFERRED_TOOL_INSTRUCTIONS);
  }

  // Global user instructions: the ACTIVE one of the user's named instruction
  // sets (Settings → Agent — up to three, at most one active). Applies to
  // every workspace and turn, so it rides high in the prompt (right after the
  // base identity), framed as standing rules that yield only to the user's
  // explicit message this turn. Stable for the session, so it stays static.
  const globalInstructions = selectActiveGlobalInstructions(settings).trim();
  if (globalInstructions) {
    sections.splice(1, 0, formatGlobalInstructions(globalInstructions));
  }

  // ── Dynamic half ───────────────────────────────────────────────────────
  //
  // These two change WHILE a conversation is open: the mode section flips on
  // /plan and when a plan document appears, and the MCP summary changes every
  // time a server connects or drops. Anything before them in the prompt is a
  // cache prefix, so keeping them at the front cost the whole system prompt on
  // every flip. Measured on two providers with a 7.2k-token prompt, on the
  // turn where the volatile text changed:
  //
  //   kenari/minimax-m3  front: 7,280 billed / 1.5% hit   back: 96 / 98.7%
  //   ark/glm-5.2        front: 7,251 billed / 0.0% hit   back: 1,106 / 84.7%
  //
  // Providers that cache automatically (kenari, ark, DeepSeek) key on the
  // longest common PREFIX and need no markers; Anthropic needs the explicit
  // breakpoint the boundary gives it. Both want the same section order.
  const dynamicSections = [getAgentModePromptSection(executionMode, { hasActivePlan })];
  if (mcpSummary?.trim()) {
    dynamicSections.push(mcpSummary.trim());
  }

  const staticText = sections.filter(Boolean).join("\n\n");
  const dynamicText = dynamicSections.filter(Boolean).join("\n\n");

  return {
    systemPrompt: dynamicText
      ? `${staticText}\n\n${SYSTEM_PROMPT_DYNAMIC_BOUNDARY}\n\n${dynamicText}`
      : staticText,
    allSkills,
    activeSkills,
    enabledSkills,
    explicitSkills,
  };
}
