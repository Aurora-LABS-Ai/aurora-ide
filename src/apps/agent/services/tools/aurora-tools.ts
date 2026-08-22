/**
 * Frontend-native Aurora tool executor.
 *
 * Background
 * ----------
 * Most tools in the agent loop are owned by the Rust `ToolRegistry`
 * (`src-tauri/src/tools/`). MCP tools (`mcp_*`) are owned by the
 * frontend bridge (`src/services/mcp-tools.ts`) because they call
 * out to user-configured MCP servers.
 *
 * Skill discovery (`aurora_skill_search`, `aurora_skill_load`) and local
 * Artifact Canvas presentation are genuinely frontend-native. The skill catalog
 * lives in `src/services/skills.ts` — built-in skills are hardcoded
 * TS literals, workspace skills are discovered by scanning
 * `.aurora/skills/` and `.agents/skills/` through Tauri `fs` IPC,
 * frontmatter parsing happens in JS, and the same code powers the
 * `SkillsSettingsTab` UI plus the agent prompt skill-injection path.
 * Porting all of that to Rust would be a parallel implementation
 * with no behavioural gain, so we instead extend the frontend
 * bridge to also dispatch these tools.
 *
 * This file is the dispatcher: it knows which tool names are
 * frontend-native Aurora tools and how to run them. The bridge
 * (`agent-runtime-client.ts > dispatchToolPending`) is the only
 * caller.
 *
 * Contract
 * --------
 * `executeAuroraFrontendTool` returns a JSON-serialized string —
 * the same shape `executeMcpTool` returns — so the Rust runtime
 * sees a uniform tool-result payload regardless of which executor
 * actually ran. Failures throw; the bridge wraps the thrown
 * message in the standard `{ error, tool }` envelope and posts
 * `isError=true` via `agent_post_tool_result`.
 *
 * Risk
 * ----
 * Registered tools are read-only or limited to conversation-owned UI state.
 * They are classified `low`, so the bridge auto-approves them without
 * surfacing the tool-approval modal.
 */
import {
  normalizeAskQuestionArgs,
  requestUserQuestions,
  type AskQuestionItem,
} from "@/apps/agent/services/tools/question-bridge";
import { findSkillById, searchSkillCandidates } from "@/apps/agent/services/skills/skills";
import { useAgentArtifactStore } from "@/apps/agent/store/artifacts/useAgentArtifactStore";
import { useAgentChatStore } from "@/apps/agent/store/conversation/useAgentChatStore";
import { useAgentWorkspaceStore } from "@/apps/agent/store/workspace/useAgentWorkspaceStore";
import type {
  AgentArtifactKind,
  ArtifactTextPatch,
  PresentArtifactInput,
} from "@/apps/agent/services/artifacts/agent-artifacts";
import { previewThreadArtifactPatch } from "@/apps/agent/services/artifacts/agent-artifacts";
import { describeMermaidError, validateMermaidSource } from "@/apps/agent/services/artifacts/mermaid-artifacts";
import {
  listTerminalSessions,
  readTerminalSession,
} from "@/apps/agent/services/terminal/terminal-sessions";
import {
  executeTeamLeadTool,
  isTeamLeadTool,
  type TeamToolContext,
} from "@/apps/agent/services/team/team-agent-tools";

/**
 * Names of Aurora tools that are implemented in TypeScript on the
 * frontend rather than in the Rust runtime.
 *
 * Keep this list narrow: each entry runs without the tool-approval modal.
 * Anything that mutates project/system state or talks to an external service
 * should live in the Rust runtime
 * (or be an MCP server) so it benefits from the runtime's safety
 * checks, audit logging, and cancellation handling.
 */
const AURORA_FRONTEND_TOOLS = new Set<string>([
  "aurora_skill_search",
  "aurora_skill_load",
  // The user's terminals live in this window — their xterm buffers are here,
  // not in Rust — so reading them is necessarily a frontend tool. Both are
  // read-only: they observe output that already exists and can neither run a
  // command nor type into a live shell.
  "terminal_list",
  "terminal_read",
  // Interactive prompt. Auto-approved because the prompt UI *is* the consent —
  // it can't mutate anything, it just collects the user's answer and blocks the
  // turn until they respond (or skip).
  "ask_question",
  "present_artifact",
  "read_artifact",
]);

/**
 * `true` when `toolName` should be dispatched through the frontend
 * Aurora executor rather than the Rust runtime or MCP bridge.
 */
export function isAuroraFrontendTool(toolName: string): boolean {
  return AURORA_FRONTEND_TOOLS.has(toolName) || isTeamLeadTool(toolName);
}

/**
 * `true` for frontend Aurora tools that are safe to
 * run without the approval modal.
 *
 * Currently every entry in {@link AURORA_FRONTEND_TOOLS} qualifies,
 * but we keep the predicate separate so a future tool that needs
 * explicit consent can be added without changing the dispatch
 * logic.
 */
export function shouldAutoApproveAuroraFrontendTool(toolName: string): boolean {
  // Skill tools are read-only. Team-control tools are auto-approved by
  // product decision: the user opts into the whole flow by enabling Team in
  // settings + selecting Team mode, so the Lead drives it without per-call
  // modals. Each mutation still lands in Rust via the guarded `team_*`
  // commands, and execution is hard-gated on `teamEnabled`.
  return AURORA_FRONTEND_TOOLS.has(toolName) || isTeamLeadTool(toolName);
}

/**
 * `terminal_list` — the user's open terminals in this window.
 *
 * Empty is a real answer, not a failure: it means nothing is open, and saying
 * so plainly stops the model retrying or inventing a session id.
 */
function runTerminalList(): string {
  const sessions = listTerminalSessions();
  return JSON.stringify({
    success: true,
    count: sessions.length,
    terminals: sessions,
    message:
      sessions.length === 0
        ? "The user has no terminal open in Aurora right now."
        : `${sessions.length} terminal(s) open in Aurora's right rail.`,
  });
}

interface TerminalReadArgs {
  id?: unknown;
  scope?: unknown;
  head_lines?: unknown;
  tail_lines?: unknown;
}

/** `terminal_read` — one session's output, head + tail, elision stated. */
function runTerminalRead(rawArgs: unknown): string {
  const args = (rawArgs ?? {}) as TerminalReadArgs;
  const id = typeof args.id === "string" ? args.id.trim() : "";
  if (!id) {
    return JSON.stringify({
      success: false,
      error: "`id` is required. Call `terminal_list` for the open terminals and their ids.",
    });
  }

  const scope = args.scope === "all" ? "all" : "last_command";
  const toCount = (value: unknown, fallback: number): number =>
    typeof value === "number" && Number.isFinite(value) && value >= 0
      ? Math.min(500, Math.floor(value))
      : fallback;

  const result = readTerminalSession(id, {
    scope,
    headLines: toCount(args.head_lines, 40),
    tailLines: toCount(args.tail_lines, 40),
  });

  if (!result) {
    // Name the ones that DO exist: an id that has gone stale is the common
    // case (the user closed that tab), and the recovery is right there.
    const open = listTerminalSessions().map((s) => `${s.id} (${s.title})`);
    return JSON.stringify({
      success: false,
      error: `No terminal \`${id}\` is open in Aurora.`,
      open_terminals: open,
      hint:
        open.length === 0
          ? "The user has no terminal open."
          : "Use one of `open_terminals`, or call `terminal_list` again.",
    });
  }

  return JSON.stringify({ success: true, ...result });
}

interface SkillSearchArgs {
  query?: unknown;
  limit?: unknown;
  source?: unknown;
}

interface SkillLoadArgs {
  id?: unknown;
}

function coerceLimit(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return 30;
}

async function runSkillSearch(
  rawArgs: Record<string, unknown>,
  workspacePath: string | null,
): Promise<string> {
  const args = rawArgs as SkillSearchArgs;
  const query = typeof args.query === "string" ? args.query : undefined;
  const limit = coerceLimit(args.limit);
  const source =
    args.source === "builtin" || args.source === "workspace" || args.source === "global"
      ? args.source
      : undefined;

  const results = await searchSkillCandidates(query ?? null, limit, { workspacePath });

  const filtered = source ? results.filter((r) => r.source === source) : results;

  return JSON.stringify({
    count: filtered.length,
    query: query ?? null,
    results: filtered,
  });
}

async function runSkillLoad(
  rawArgs: Record<string, unknown>,
  workspacePath: string | null,
): Promise<string> {
  const args = rawArgs as SkillLoadArgs;
  const id = typeof args.id === "string" ? args.id.trim() : "";
  if (!id) {
    throw new Error("aurora_skill_load: `id` is required");
  }

  const skill = await findSkillById(id, { workspacePath });

  if (!skill) {
    throw new Error(`Skill not found: '${id}'`);
  }

  // Mirror the shape the agent prompt uses so the model gets a
  // predictable envelope: { id, name, description, source, path,
  // triggers, content }.
  return JSON.stringify({
    id: skill.id,
    name: skill.name,
    description: skill.description,
    source: skill.source,
    path: skill.sourcePath ?? null,
    triggers: skill.triggers,
    content: skill.content,
  });
}

/** Render the chosen option ids + free text back into human-readable answers. */
function describeAnswer(
  question: AskQuestionItem,
  selectedIds: string[],
  otherText: string | undefined,
): string | null {
  const labels = selectedIds.map(
    (id) => question.options.find((o) => o.id === id)?.label ?? id,
  );
  const parts = [...labels];
  if (otherText && otherText.trim()) parts.push(otherText.trim());
  return parts.length > 0 ? parts.join(", ") : null;
}

/**
 * Execute `ask_question`: render the interactive prompt, block until the user
 * answers/skips, and serialise their choices into a model-friendly envelope:
 * `{ skipped, responses: [{ id, prompt, answer }] }`. Unanswered questions come
 * back with `answer: null`.
 */
async function runAskQuestion(rawArgs: Record<string, unknown>): Promise<string> {
  const request = normalizeAskQuestionArgs(rawArgs);
  if (!request) {
    throw new Error(
      "ask_question: provide a non-empty `questions` array, each with `prompt` and `options`.",
    );
  }

  const result = await requestUserQuestions(request);

  const responses = request.questions.map((q) => {
    const answer = result.answers.find((a) => a.questionId === q.id);
    return {
      id: q.id,
      prompt: q.prompt,
      answer: answer ? describeAnswer(q, answer.selectedIds, answer.otherText) : null,
    };
  });

  return JSON.stringify({ skipped: result.skipped, responses });
}

interface PresentArtifactArgs {
  artifactCategory?: unknown;
  artifactId?: unknown;
  artifactKind?: unknown;
  artifactTitle?: unknown;
  /** Pre-rename spellings. Still read: threads on disk are full of them. */
  title?: unknown;
  kind?: unknown;
  content?: unknown;
  baseVersionTag?: unknown;
  patches?: unknown;
}

interface ReadArtifactArgs {
  artifactId?: unknown;
  versionTag?: unknown;
  query?: unknown;
  contextLines?: unknown;
}

function sourceExcerpts(content: string, query: string, contextLines: number) {
  const lines = content.split("\n");
  const ranges: Array<{ start: number; end: number }> = [];
  for (let index = 0; index < lines.length; index++) {
    if (!lines[index].includes(query)) continue;
    const start = Math.max(0, index - contextLines);
    const end = Math.min(lines.length - 1, index + contextLines);
    const previous = ranges[ranges.length - 1];
    if (previous && start <= previous.end + 1) {
      previous.end = Math.max(previous.end, end);
    } else if (ranges.length < 20) {
      ranges.push({ start, end });
    }
  }
  return ranges.map(({ start, end }) => ({
    startLine: start + 1,
    endLine: end + 1,
    content: lines.slice(start, end + 1).join("\n"),
  }));
}

async function runReadArtifact(
  rawArgs: Record<string, unknown>,
  ctx?: TeamToolContext,
): Promise<string> {
  const threadId = ctx?.threadId?.trim();
  if (!threadId) throw new Error("read_artifact: a saved conversation is required");

  const args = rawArgs as ReadArtifactArgs;
  const artifactId = typeof args.artifactId === "string" ? args.artifactId.trim() : "";
  const versionTag = typeof args.versionTag === "string" ? args.versionTag.trim() : "";
  const query = typeof args.query === "string" ? args.query : "";
  const contextLines = args.contextLines === undefined ? 2 : Number(args.contextLines);
  if (!Number.isInteger(contextLines) || contextLines < 0 || contextLines > 20) {
    throw new Error("read_artifact: contextLines must be an integer from 0 to 20");
  }

  const bundle = await useAgentArtifactStore.getState().loadThread(threadId);

  // Artifacts outlive the context that made them: reopen a conversation weeks
  // later, or compact the turn that created one, and the model no longer has
  // the id from its own tool result. Omitting artifactId lists what this
  // conversation actually has on disk, so the source is always reachable
  // instead of being reachable only by remembering.
  if (!artifactId) {
    return JSON.stringify({
      success: true,
      artifacts: bundle.artifacts.map((entry) => ({
        artifactId: entry.id,
        title: entry.title,
        kind: entry.kind,
        latestVersionTag: entry.versions[entry.versions.length - 1]?.tag ?? null,
        versionCount: entry.versions.length,
      })),
      message:
        bundle.artifacts.length === 0
          ? "This conversation has no Canvas artifacts yet."
          : "Call read_artifact again with one of these artifactId values to read its source.",
    });
  }

  const artifact = bundle.artifacts.find((entry) => entry.id === artifactId);
  if (!artifact) {
    const known = bundle.artifacts.map((entry) => entry.id);
    throw new Error(
      known.length > 0
        ? `read_artifact: artifact '${artifactId}' does not exist. This conversation has: ${known.join(", ")}`
        : `read_artifact: artifact '${artifactId}' does not exist; this conversation has no artifacts yet`,
    );
  }
  const version = versionTag
    ? artifact.versions.find((entry) => entry.tag === versionTag)
    : artifact.versions[artifact.versions.length - 1];
  if (!version) {
    throw new Error(
      `read_artifact: version '${versionTag || "latest"}' does not exist for '${artifactId}'`,
    );
  }

  const base = {
    success: true,
    artifactId,
    title: artifact.title,
    kind: artifact.kind,
    versionTag: version.tag,
  };
  return query
    ? JSON.stringify({ ...base, query, excerpts: sourceExcerpts(version.content, query, contextLines) })
    : JSON.stringify({ ...base, content: version.content });
}

async function runPresentArtifact(
  rawArgs: Record<string, unknown>,
  ctx?: TeamToolContext,
): Promise<string> {
  const threadId = ctx?.threadId?.trim();
  if (!threadId) {
    throw new Error("present_artifact: a saved conversation is required");
  }
  const args = rawArgs as PresentArtifactArgs;
  const artifactId = typeof args.artifactId === "string" ? args.artifactId.trim() : "";
  // Both spellings, new one first. The rename exists so the header sorts ahead
  // of `content`; the old names have to keep working or every thread already on
  // disk stops replaying.
  const titleRaw = args.artifactTitle ?? args.title;
  const title = typeof titleRaw === "string" ? titleRaw.trim() : "";
  const kind = args.artifactKind ?? args.kind;
  if (
    !artifactId ||
    !title ||
    !["html", "svg", "markdown", "mermaid", "react"].includes(String(kind))
  ) {
    throw new Error(
      "present_artifact: artifactId, artifactTitle, and artifactKind (html|svg|markdown|mermaid|react) are required",
    );
  }

  if (args.content !== undefined && typeof args.content !== "string") {
    throw new Error("present_artifact: content must be a string");
  }
  if (typeof args.content === "string" && args.content.trim().length === 0) {
    throw new Error("present_artifact: content cannot be empty");
  }
  if (args.patches !== undefined && !Array.isArray(args.patches)) {
    throw new Error("present_artifact: patches must be an array");
  }
  const content = typeof args.content === "string" ? args.content : null;
  const baseVersionTag =
    typeof args.baseVersionTag === "string" ? args.baseVersionTag.trim() : "";
  const patches: ArtifactTextPatch[] | null = Array.isArray(args.patches)
    ? args.patches.map((entry, index) => {
        if (!entry || typeof entry !== "object") {
          throw new Error(`present_artifact: patches[${index}] must be an object`);
        }
        const patch = entry as Record<string, unknown>;
        if (typeof patch.find !== "string" || patch.find.length === 0) {
          throw new Error(`present_artifact: patches[${index}].find is required`);
        }
        if (typeof patch.replace !== "string") {
          throw new Error(`present_artifact: patches[${index}].replace must be a string`);
        }
        if (patch.all !== undefined && typeof patch.all !== "boolean") {
          throw new Error(`present_artifact: patches[${index}].all must be a boolean`);
        }
        return {
          find: patch.find,
          replace: patch.replace,
          ...(patch.all === true ? { all: true } : {}),
        };
      })
    : null;
  const hasPatchUpdate = Boolean(baseVersionTag && patches && patches.length > 0);
  if (Boolean(content) === hasPatchUpdate) {
    throw new Error(
      "present_artifact: provide either content, or baseVersionTag with one or more patches, but not both",
    );
  }

  type PatchArtifactInput = Extract<PresentArtifactInput, { baseVersionTag: string }>;
  let input: PresentArtifactInput;
  let patchInput: PatchArtifactInput | null = null;
  if (content) {
    input = { artifactId, title, kind: kind as AgentArtifactKind, content };
  } else {
    patchInput = {
      artifactId,
      title,
      kind: kind as AgentArtifactKind,
      baseVersionTag,
      patches: patches ?? [],
    };
    input = patchInput;
  }

  // The engine gate. `mermaid` and `react` are not stored as authored — they
  // are drawn or compiled — so the source is put through the real engine here
  // and a failure aborts the write with that engine's own words. Rust refuses
  // these kinds without the `validated` claim set below, which is what stops a
  // future call path from quietly skipping this.
  if (kind === "mermaid" || kind === "react") {
    // For a patch, the thing to judge is the RESULT, so ask Rust to apply the
    // patches against the saved base without committing anything.
    const subject = content ?? (await previewThreadArtifactPatch(threadId, patchInput!));

    if (kind === "mermaid") {
      try {
        await validateMermaidSource(subject);
      } catch (reason: unknown) {
        throw new Error(
          content
            ? `present_artifact: Mermaid source is invalid and was not saved. ${describeMermaidError(reason)} Correct the source and retry with raw Mermaid syntax, not a Markdown code fence.`
            : `present_artifact: patches would create invalid Mermaid source and were not saved. ${describeMermaidError(reason)} Read ${artifactId} ${baseVersionTag}, correct the patch, and retry.`,
        );
      }
    } else {
      const { compileCanvasSource } = await import("@/apps/agent/services/artifacts/canvas-react");
      try {
        await compileCanvasSource(subject);
      } catch (reason: unknown) {
        const detail = reason instanceof Error ? reason.message : String(reason);
        throw new Error(
          content
            ? `present_artifact: the canvas did not compile and was not saved.\n${detail}\nCorrect the source and retry.`
            : `present_artifact: patches would produce a canvas that does not compile, and were not saved.\n${detail}\nRead ${artifactId} ${baseVersionTag}, correct the patch, and retry.`,
        );
      }
    }

    input = { ...input, validated: true } as PresentArtifactInput;
  }

  const bundle = await useAgentArtifactStore.getState().present(threadId, input);
  const versionTag = bundle.selectedVersionTag;

  if (useAgentChatStore.getState().currentThreadId === threadId) {
    useAgentWorkspaceStore.getState().openTab("canvas");
  }

  return JSON.stringify({
    success: true,
    artifactId,
    title,
    kind,
    versionTag,
    message: `Presented ${title}${versionTag ? ` (${versionTag})` : ""} in Canvas`,
  });
}

/**
 * Dispatch a frontend-native Aurora tool. Returns the JSON-stringified
 * tool result on success; throws on any failure (the bridge wraps the
 * thrown message in the standard `{ error, tool }` envelope).
 */
export async function executeAuroraFrontendTool(
  toolName: string,
  args: Record<string, unknown>,
  ctx?: TeamToolContext,
): Promise<string> {
  if (isTeamLeadTool(toolName)) {
    return executeTeamLeadTool(toolName, args, ctx);
  }

  switch (toolName) {
    case "aurora_skill_search":
      return runSkillSearch(args, ctx?.workspacePath ?? null);
    case "aurora_skill_load":
      return runSkillLoad(args, ctx?.workspacePath ?? null);
    case "terminal_list":
      return runTerminalList();
    case "terminal_read":
      return runTerminalRead(args);
    case "ask_question":
      return runAskQuestion(args);
    case "present_artifact":
      return runPresentArtifact(args, ctx);
    case "read_artifact":
      return runReadArtifact(args, ctx);
    default:
      // Defensive: the bridge gates on `isAuroraFrontendTool` before
      // calling us, so this branch only fires if the two lists drift.
      throw new Error(`Aurora frontend tool '${toolName}' has no executor`);
  }
}
