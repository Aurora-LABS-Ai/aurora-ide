/**
 * Agent Window — send pipeline (P4).
 *
 * The IDE's `useAgentSend` is welded to ~10 IDE stores (chat, thread, audit,
 * checkpoint, context, team broadcast, live preview …). The agent window is a
 * separate OS window with its own isolated chat store, so it gets its OWN, much
 * thinner pipeline that:
 *
 *   1. materialises a project-scoped thread on the FIRST send (draft → thread),
 *   2. drives the SAME Rust `agent_chat_v2` runtime via the shared
 *      `AgentService` façade (so tool execution, persistence, and context all
 *      behave exactly like the IDE),
 *   3. streams tokens / thinking / tool calls into `useAgentChatStore` for a
 *      live transcript, then reloads the authoritative JSONL when the turn ends.
 *
 * Tool approval is honoured from the user's settings (auto / deny), with an
 * inline Approve/Reject prompt for `always_ask` tools (the window has no modal).
 *
 * NB: because this is a separate JS context, `getAgentService()` here is a
 * DISTINCT singleton from the IDE's — the two windows never share runtime state.
 */

import { useCallback, useRef, useState } from "react";

import {
  AgentService,
  threadService,
  type PromptOverhead,
  type ToolCallRequest,
} from "@/apps/agent/services";
import { useAgentSettingsStore } from "@/apps/agent/store/settings/useAgentSettingsStore";
import {
  DEFAULT_MAX_OUTPUT_TOKENS,
  resolveModelRequest,
  resolveTemperature,
} from "@/apps/agent/services/runtime/model-request-config";
import { classifyError } from "@/apps/agent/lib/error-classifier";
import type {
  AttachedPromptChip,
  DbMessage,
  TokenUsage,
} from "@/apps/agent/services/threads/thread-service";
import {
  BASE_AGENT_SYSTEM_PROMPT,
  formatSkillReferences,
} from "@/apps/agent/services/runtime/agent-prompt";
import {
  effectiveExecutionMode,
  effectiveProjectRoot,
} from "@/apps/agent/services/runtime/agent-execution-mode";
import { getWorkspaceSkillToggles, resolveSkillsForPrompt } from "@/apps/agent/services/skills/skills";
import {
  tokenService,
  stripImagePayloads,
  IMAGE_TOKEN_COST,
  type ChatMessageForCount,
} from "@/apps/agent/services/runtime/token-service";
import { asChatFormat, runLocalTitle, runReplySuggestions } from "@/apps/agent/adapters/prompt-refine";
import { resolveThreadModel } from "@/apps/agent/lib/thread/thread-model";
import { imageModelFromSelection } from "@/apps/agent/services/providers/image-providers";
import { runDirectImageTurn } from "./direct-image-turn";
import {
  refineConfig,
  refinePathsConfigured,
  replySuggestionsReady,
  useAgentRefineStore,
} from "@/apps/agent/store/composer/useAgentRefineStore";
import { useAgentSuggestStore } from "@/apps/agent/store/composer/useAgentSuggestStore";
import { useAgentChatStore } from "@/apps/agent/store/conversation/useAgentChatStore";
import { useAgentContextStore } from "@/apps/agent/store/conversation/useAgentContextStore";
import {
  parseKillResult,
  parseSpawnResult,
  useAgentBackgroundStore,
} from "@/apps/agent/store/conversation/useAgentBackgroundStore";
import { useAgentArtifactStore } from "@/apps/agent/store/artifacts/useAgentArtifactStore";
import {
  composerImages,
  composerKey,
  useAgentAttachmentStore,
} from "@/apps/agent/store/composer/useAgentAttachmentStore";
import {
  buildCommandSelection,
  composerCommands,
  useAgentCommandStore,
} from "@/apps/agent/store/composer/useAgentCommandStore";
import { loadProjectRules } from "@/apps/agent/services/runtime/context-builder";
import { appendImageMarkers } from "@/apps/agent/lib/render/image-markers";
import {
  buildSelectionContext,
  buildSelectionPills,
  useAgentSelectionStore,
} from "@/apps/agent/store/composer/useAgentSelectionStore";
import { useAgentWorkspaceStore } from "@/apps/agent/store/workspace/useAgentWorkspaceStore";
import {
  appendCompaction,
  appendContent,
  appendNotice,
  appendProcessBeat,
  appendThinking,
  appendUserInjection,
  beginReconnect,
  clearReconnect,
  finishCompaction,
  nextEventId,
  textOf,
  upsertToolEvent,
  type TimelineEvent,
} from "@/apps/agent/components/conversation/timeline";
import { describeToolActivity, type AgentActivity } from "@/apps/agent/components/conversation/activity";
import { isDirectiveCommand } from "@/apps/agent/adapters/prompt-commands";

/** Read the in-progress ordered timeline off a message (defaults to empty). */
function timelineOf(m: DbMessage): TimelineEvent[] {
  const raw = (m as { timeline?: unknown }).timeline;
  return Array.isArray(raw) ? (raw as TimelineEvent[]) : [];
}

// The Rust runtime hard-clamps EVERY tool result to 8 KiB before it enters the
// model's conversation history (`MAX_TOOL_RESULT_LENGTH` in conversation.rs).
// The UI store keeps a much larger copy (up to 512 KiB) for the rich renderers,
// so we MUST clamp to the model-history size here or the estimate overcounts a
// grep / multi_file_read / shell result by up to ~64x and the context ring
// balloons far past what the model actually receives.
const MODEL_TOOL_RESULT_CLAMP = 8_192;

// What the model is told about the path boundary now lives in the system
// prompt (`agent-prompt.ts`, `WORKSPACE_ACCESS_RULES`). It is a setting, so it
// is identical on every request of a conversation and belongs in the cached
// half rather than beside the things that actually change.

// Output cap used when neither the model nor the provider declares one.
// On every provider except Anthropic, reasoning tokens bill against this same
// cap, so a high reasoning effort can burn the whole allowance before the model
// writes a visible word — the turn then ends at the cap with only thinking to
// show for it. Keep this comfortably above a long reasoning pass; users can
// still set an exact `Max output` per model in provider settings.

/**
 * Estimate token usage for a turn the provider never reported. Many OpenAI-
 * compatible backends (Fireworks, Ollama, OpenRouter, custom) don't emit
 * `stream_options.include_usage`, so the context ring would otherwise read zero.
 * We approximate with tiktoken over the live transcript + the base system
 * prompt, and flag the result `estimated` so the UI shows it with a `~`.
 *
 * Mirrors what the runtime ACTUALLY sends the model, not what the UI stores:
 *  - every tool result is clamped to {@link MODEL_TOOL_RESULT_CLAMP} (8 KiB),
 *  - image payloads are stripped and billed flat (never raw base64),
 *  - the FULL prompt overhead is counted — the composed system prompt, the IDE
 *    context block, AND the tool schemas — not just the base system prompt.
 *    The tool schemas alone are the bulk of the ~16% gap a usage-reporting
 *    provider (DeepSeek) revealed; counting only `BASE_AGENT_SYSTEM_PROMPT`
 *    made the 80% compaction trigger fire late.
 *  - the prompt is capped at the runtime's trim budget (it drops the oldest
 *    messages once the request would exceed `window − maxOutput·1.1`), so the
 *    estimate plateaus like the real context instead of growing forever.
 *
 * `overhead` is the exact system + tool text the {@link AgentService} composed
 * for this turn ({@link AgentService.getLastPromptOverhead}); when it's null
 * (the turn died before composing) we fall back to the base system prompt.
 */
async function estimateTurnUsage(
  messages: DbMessage[],
  modelForCount: string,
  contextWindow: number,
  maxOutputTokens: number,
  overhead: PromptOverhead | null,
): Promise<TokenUsage | null> {
  if (messages.length === 0) return null;

  // The last assistant message is this turn's completion; everything before it
  // is the prompt context the model saw.
  let lastAssistantIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant") {
      lastAssistantIdx = i;
      break;
    }
  }
  const completionRaw =
    lastAssistantIdx >= 0 ? messages[lastAssistantIdx].content ?? "" : "";

  let imageCount = 0;

  // CRITICAL: the live store folds an ENTIRE turn (every tool call + result)
  // onto ONE assistant message. So the final assistant message carries all of
  // this turn's tool results — which are INPUT context (the model re-ingested
  // them across iterations), not output. Count them as prompt; only the final
  // assistant's TEXT is the completion. (Earlier this whole message was treated
  // as completion, dropping ~190k tokens of tool results → the "1%" bug.)
  const toCount = (m: DbMessage, idx: number): ChatMessageForCount => {
    // Each tool RESULT enters history clamped to 8 KiB (after image stripping),
    // exactly like the runtime. Fold the clamped results into `content`; pass
    // name+args via `toolCalls` so neither is double-counted.
    const toolResults = (m.tool_calls ?? [])
      .map((tc) => {
        const clean = stripImagePayloads(tc.result ?? "");
        imageCount += clean.images;
        return clean.text.slice(0, MODEL_TOOL_RESULT_CLAMP);
      })
      .join("");
    // The final assistant's text is the completion, not prompt — skip it here.
    const body =
      idx === lastAssistantIdx
        ? { text: "", images: 0 }
        : stripImagePayloads(m.content ?? "");
    imageCount += body.images;
    return {
      role: m.role,
      content: `${body.text}${toolResults}`,
      toolCalls: (m.tool_calls ?? []).map((tc) => ({
        name: tc.name,
        arguments: stripImagePayloads(tc.arguments ?? "").text,
      })),
    };
  };

  // Count ALL messages (tool results included) as prompt context; the final
  // assistant's text alone is the completion.
  const countedPrompt = messages.map(toCount);
  const completionClean = stripImagePayloads(completionRaw);
  imageCount += completionClean.images;

  // The system + IDE-context text and the tool schemas the runtime sent this
  // turn. Falls back to the base prompt alone if the turn never composed them.
  const systemText = overhead?.systemText ?? BASE_AGENT_SYSTEM_PROMPT;
  const toolSchemaJson = overhead?.toolSchemaJson ?? "";

  try {
    const [history, sys, toolSchemas, completion] = await Promise.all([
      tokenService.countMessagesTokens(countedPrompt, modelForCount),
      tokenService.countTokens(systemText, modelForCount),
      toolSchemaJson
        ? tokenService.countTokens(toolSchemaJson, modelForCount)
        : Promise.resolve({ tokens: 0 }),
      tokenService.countTokens(completionClean.text, modelForCount),
    ]);
    let promptTokens =
      history.tokens +
      sys.tokens +
      toolSchemas.tokens +
      imageCount * IMAGE_TOKEN_COST;

    // Mirror the runtime's history trim: once the request would exceed
    // `window − maxOutput·1.1`, it drops the oldest messages. The real prompt
    // can't exceed that budget, so neither should the estimate.
    const reserve = Math.ceil(maxOutputTokens * 1.1);
    const budget = Math.max(0, contextWindow - reserve);
    if (budget > 0 && promptTokens > budget) promptTokens = budget;

    return {
      promptTokens,
      completionTokens: completion.tokens,
      totalTokens: promptTokens + completion.tokens,
      estimated: true,
    };
  } catch {
    return null;
  }
}

/** A tool waiting on the user because its approval mode is `always_ask`. */
export interface PendingApproval {
  id: string;
  toolName: string;
  /** Raw JSON arguments (provider format), for the prompt preview. */
  args: string;
}

/** Per-send options that are not part of the message itself. */
export interface SendOptions {
  /**
   * Execution mode for THIS turn only, overriding the window's setting.
   *
   * `aurora agent --plan` is the caller. Per-turn rather than through
   * `setAgentExecutionMode` because that setter is global: it would leave the
   * window in plan mode after a dispatched task finished, and two concurrent
   * dispatches in different modes would each clobber the other's.
   */
  executionMode?: "agent" | "plan";
  /**
   * The `aurora agent` task this send fulfils, when a terminal dispatched it.
   *
   * Forwarded to Rust, which tees the turn's events into that task's
   * transcript so `aurora agent --follow` watches the same work this window
   * renders. Absent for every send a person makes.
   */
  cliTaskId?: string | null;
  /**
   * The model for THIS turn only, as `providerId:modelKey`.
   *
   * `aurora agent --model` and the `aurora_agent_dispatch` tool are the
   * callers. Per-turn for the same reason {@link SendOptions.executionMode} is,
   * plus one specific to the model: a dispatch that starts a NEW conversation
   * cannot express its choice through the thread at all.
   *
   * `setThreadModel` records a pin by mapping over `threads`/`allThreads`, and
   * a freshly created thread is deliberately in neither — `refreshThreads`
   * keeps 0-message threads out of the rail, so no row exists until the first
   * message lands. The pin therefore no-opped in memory, `resolveThreadModel`
   * found nothing, and the turn fell back to the user's default: a task
   * dispatched with `--model luna` ran on whatever the window had selected,
   * and only the transcript's echo of the *requested* model made it look
   * right.
   */
  model?: string | null;
  /**
   * Who is starting this turn. Defaults to the user, which is every send a
   * person makes.
   *
   * `"process"` is the background report: a process ended while this
   * conversation was idle, so nothing was going to tell the model unless
   * something started a turn. The message is real and gets answered, but it is
   * persisted as a process event rather than as words anybody typed — no user
   * bubble, no pill, no title derived from it.
   */
  origin?: "user" | "process";
  /** The transcript's one line when {@link SendOptions.origin} is `"process"`. */
  summary?: string | null;
}

export interface AgentWindowSend {
  /** True while a turn is streaming. */
  sending: boolean;
  /** Send (or resend) a turn. No-op on empty text or while already sending. */
  send: (
    text: string,
    fileChips?: AttachedPromptChip[],
    options?: SendOptions,
  ) => Promise<void>;
  /** Compact the open thread immediately. No-op when no idle thread is open. */
  compact: () => Promise<void>;
  /** Cancel the in-flight turn. */
  stop: () => void;
  /** The tool currently awaiting approval, or `null`. */
  pendingApproval: PendingApproval | null;
  /** Approve the pending tool once. */
  approve: () => void;
  /** Approve + remember (flip the tool to auto for future turns). */
  approveAlways: () => void;
  /** Reject the pending tool. */
  reject: () => void;
}

const genId = () => Math.random().toString(36).slice(2, 11);

/**
 * Was this conversation started in deep research?
 *
 * Read from the thread, not from `deepResearchNext`. The setting seeds a NEW
 * chat and nothing else; a conversation's own answer is fixed at creation, and
 * that is exactly what lets the instruction live in the cacheable prefix.
 *
 * A thread the store has not loaded yet reads as `false`, which is the safe
 * direction: a missing instruction produces a normal answer, while a wrongly
 * added one changes the prompt of a conversation that was framed differently.
 */
function threadIsDeepResearch(threadId: string | null): boolean {
  if (!threadId) return false;
  const { threads, allThreads } = useAgentChatStore.getState();
  const found =
    allThreads.find((t) => t.id === threadId) ?? threads.find((t) => t.id === threadId);
  return found?.deepResearch === true;
}

function nowIso(): string {
  return new Date().toISOString();
}

// `withProviderDefaults` now lives in services/model-request-config so the
// provider connection test normalizes configs exactly as a turn does.

/**
 * Load the user's `/`-selected project rules and format them as an authoritative
 * context block (mirrors how the IDE context builder injects rules). Returns
 * `null` when nothing is selected, the project is unknown, or none resolve.
 */
async function buildRuleContext(
  projectRoot: string | null,
  ruleFilenames: string[],
): Promise<string | null> {
  if (!projectRoot || ruleFilenames.length === 0) return null;
  let rules: Array<{ filename: string; content: string }>;
  try {
    rules = await loadProjectRules(projectRoot);
  } catch {
    return null;
  }
  const wanted = new Set(ruleFilenames);
  const selected = rules.filter((r) => wanted.has(r.filename));
  if (selected.length === 0) return null;

  const body = selected
    .map((r) => `<rule file="${r.filename}">\n${r.content}\n</rule>`)
    .join("\n\n");
  return `<project_rules>\nThe user explicitly attached these project rules to this turn. Treat them as authoritative standing rules for this task.\n\n${body}\n</project_rules>`;
}

/**
 * Total character budget for auto-attached project rules (~2.5K tokens).
 * Oversized rules are truncated with a pointer to the file so the agent can
 * `file_read` the rest when it actually matters.
 */
const AUTO_RULES_CHAR_BUDGET = 10_000;

/**
 * Auto-attach the project's `.aurora/*.md` rules — parity with the IDE's
 * context builder, which injects `<project_rules>` on a chat's first message.
 * Without this, rules only reached the agent window when the user explicitly
 * `/`-attached them. Rules already selected via `/` are excluded here (they
 * ride verbatim in `buildRuleContext`), and the total is capped by
 * [`AUTO_RULES_CHAR_BUDGET`] so a huge rules folder can't flood the context.
 */
async function buildAutoRulesContext(
  projectRoot: string | null,
  excludeFilenames: string[],
): Promise<string | null> {
  if (!projectRoot) return null;
  let rules: Array<{ filename: string; content: string }>;
  try {
    rules = await loadProjectRules(projectRoot);
  } catch {
    return null;
  }
  const exclude = new Set(excludeFilenames);
  const auto = rules.filter((r) => !exclude.has(r.filename) && r.content.length > 0);
  if (auto.length === 0) return null;

  let remaining = AUTO_RULES_CHAR_BUDGET;
  const parts: string[] = [];
  for (const rule of auto) {
    if (remaining <= 0) {
      parts.push(
        `<rule file="${rule.filename}" omitted="true">Omitted for context budget — read .aurora/${rule.filename} with file_read if relevant.</rule>`,
      );
      continue;
    }
    let body = rule.content;
    if (body.length > remaining) {
      body = `${body.slice(0, remaining)}\n…[truncated — read .aurora/${rule.filename} for the rest]`;
    }
    remaining -= body.length;
    parts.push(`<rule file="${rule.filename}">\n${body}\n</rule>`);
  }
  return `<project_rules description="Project-specific rules from .aurora/*.md files that must be followed">\n${parts.join("\n\n")}\n</project_rules>`;
}

/**
 * What the user currently has open in the right-hand Files panel.
 *
 * NAMES ONLY, never content. A path costs a few tokens and tells the agent
 * where the user's attention is; the file body costs thousands and it already
 * has `file_read` for the moment it actually needs one. Injecting content here
 * would re-send it on every request of the conversation for as long as the file
 * stayed open.
 *
 * This replaces the IDE-derived open-tab list, which is gone: the agent window
 * is the product and the separate editor window is no longer where the user's
 * files are. The rail viewer shows one file at a time today, so the block is
 * built from a LIST rather than a single path — if the panel grows tabs, every
 * tab's filename lands here with no redesign and no change to the contract.
 */
export function buildOpenFilesContext(
  paths: string[],
  activePath: string | null,
): string | null {
  const open = paths.map((path) => path.trim()).filter(Boolean);
  if (open.length === 0) return null;
  // Marked, not positional: the dock's active tab may be the file tree, the
  // browser or a terminal, in which case none of these files is the one being
  // looked at and claiming the first one is would be a small lie every turn.
  const rows = open.map(
    (path) => `- ${path}${path === activePath ? "  (showing)" : ""}`,
  );
  return `<open_files count="${open.length}">
Open in the user's Files panel right now. Filenames only — read one with file_read if you need what is in it.

${rows.join("\n")}
</open_files>`;
}

/**
 * `/image` — the user has prioritised a picture. This goes to the SELECTED
 * model, never around it: the model reads the request and runs
 * `generate_image`, which lets it catch a prompt that would waste forty
 * seconds and a paid call before the call is made. The design notes record
 * that a direct-to-API `/image` was proposed and overruled for this reason.
 */
function buildImageRequest(requested: boolean): string | null {
  if (!requested) return null;
  return `<image_request>
The user attached /image: they want a picture made of this message, and that comes before any other reply. Reply in a sentence at most, then call generate_image with a prompt written out from what they said. If what they wrote is too thin to draw from (a bare noun, no subject or setting), offer one fuller prompt in one or two lines and ask before spending the call. Otherwise do not ask; make it.
</image_request>`;
}

/** Soft nudge toward the `/`-selected MCP servers (their tools are already available). */
function buildMcpDirective(serverNames: string[]): string | null {
  if (serverNames.length === 0) return null;
  const list = serverNames.join(", ");
  return `<preferred_mcp_servers>\nThe user explicitly referenced these connected MCP server(s) for this task: ${list}. Prefer their tools where relevant.\n</preferred_mcp_servers>`;
}

/**
 * AI title maker — for the FIRST message of a NEW chat only. Depending on the
 * configured mode, asks either the user's OpenAI-compatible endpoint (cloud)
 * or the local prompt-refine llama.cpp model (local) for a short title,
 * persists it, and reflects it in the live store + rail. Fully non-blocking
 * and non-fatal: any failure (off, unconfigured, network, bad key) silently
 * keeps the locally-derived title. The runtime's own auto-title is gated on
 * the sidecar still reading "New Chat", so whichever write lands first, this
 * title wins (and on failure the derived title stands).
 */
async function maybeGenerateTitle(threadId: string, firstMessage: string): Promise<void> {
  const s = useAgentSettingsStore.getState();
  if (s.titleMakerMode === "off" || !firstMessage.trim()) return;

  try {
    let title: string;
    if (s.titleMakerMode === "local") {
      const refine = useAgentRefineStore.getState();
      // The llama.cpp FOLDER is always the shared one from prompt refine —
      // there is one runtime on the machine. Only the model can differ.
      if (!refine.llamaDir.trim()) return;
      const ownModel = s.titleMakerLocalModel.trim();
      if (!ownModel && !refinePathsConfigured(refine)) return;
      title = await runLocalTitle(`title_${threadId}`, firstMessage, {
        ...refineConfig(refine),
        ...(ownModel
          ? {
              modelPath: ownModel,
              chatFormat: asChatFormat(s.titleMakerLocalChatFormat),
            }
          : {}),
      });
    } else {
      const baseUrl = s.titleMakerBaseUrl.trim();
      const model = s.titleMakerModel.trim();
      if (!baseUrl || !model) return;
      title = await threadService.generateTitle({
        baseUrl,
        apiKey: s.titleMakerApiKey.trim() || null,
        model,
        userMessage: firstMessage,
      });
    }
    const clean = (title ?? "").trim();
    if (!clean) return;

    await threadService.updateTitle(threadId, clean);
    // Reflect immediately: the live turn (rail + header) and, if this thread is
    // the open one, the current thread.
    useAgentChatStore.setState((state) => {
      const live = state.liveTurns[threadId];
      return {
        liveTurns: live
          ? { ...state.liveTurns, [threadId]: { ...live, title: clean } }
          : state.liveTurns,
        currentThread:
          state.currentThreadId === threadId && state.currentThread
            ? { ...state.currentThread, title: clean }
            : state.currentThread,
      };
    });
    void useAgentChatStore.getState().refreshThreads();
  } catch (err) {
    console.warn("[agent-window] title maker failed; keeping derived title:", err);
  }
}

/**
 * One `AgentService` PER in-flight thread. Each instance owns its own runtime
 * client + provider/workspace config, so turns on different threads run fully
 * in parallel (the Rust runtime already locks per-thread and isolates events by
 * turnId). Keyed by thread id; entries are removed when the turn settles.
 */
const runningAgents = new Map<string, AgentService>();

/**
 * Reply suggestions — after a turn settles, ask the local prompt-refine model
 * for up to 3 short replies the user could tap instead of typing. Fire-and-
 * forget (the ~4s of model calls must never delay turn teardown); the
 * assistant text is captured synchronously because the live turn closes right
 * after this is invoked. Results are dropped if a new turn started meanwhile,
 * and any failure simply means no chips. Gated on the shared composer-assists
 * preference.
 */
function generateSuggestionsFrom(
  threadId: string,
  messages: Array<{ role: string; content?: string | null }>,
): void {
  const refine = useAgentRefineStore.getState();
  const lastAssistant = [...messages]
    .reverse()
    .find((m) => m.role === "assistant" && (m.content ?? "").trim());
  const text = (lastAssistant?.content ?? "").trim();
  if (!text) return;
  // The model role-plays as the USER — it needs to see what the user asked
  // for, not just what the assistant answered.
  const lastUser = [...messages]
    .reverse()
    .find((m) => m.role === "user" && (m.content ?? "").trim());
  const userText = (lastUser?.content ?? "").trim();

  void runReplySuggestions(
    `suggest_${threadId}_${Date.now()}`,
    userText,
    text,
    refineConfig(refine),
  )
    .then((suggestions) => {
      // A newer turn owns the conversation now — these chips describe a
      // message that's no longer the latest.
      if (runningAgents.has(threadId)) return;
      useAgentSuggestStore.getState().setSuggestions(threadId, suggestions);
    })
    .catch((err) => {
      console.warn("[agent-window] reply suggestions skipped:", err);
    });
}

function maybeSuggestReplies(threadId: string): void {
  if (!replySuggestionsReady(useAgentRefineStore.getState())) return;
  const messages = useAgentChatStore.getState().liveTurns[threadId]?.messages ?? [];
  generateSuggestionsFrom(threadId, messages);
}

/**
 * Manual `/suggest` trigger from the composer. Explicit intent — gated only
 * on the local model being configured, NOT on the auto-suggestions toggle,
 * and reads the SETTLED thread (live turns have already closed by the time
 * the user can type a slash command).
 */
export function requestReplySuggestions(threadId: string): void {
  if (!refinePathsConfigured(useAgentRefineStore.getState())) return;
  if (runningAgents.has(threadId)) return; // mid-turn — chips would be stale
  const messages = useAgentChatStore.getState().currentThread?.messages ?? [];
  generateSuggestionsFrom(threadId, messages);
}

interface BackgroundSendTarget {
  threadId: string;
  projectRoot: string | null;
  seed: import("@/apps/agent/services/threads/thread-service").DbThread;
  /**
   * True when a PERSON pressed send on this thread's own composer, as opposed
   * to the pipeline resubmitting on their behalf (the post-turn queue flush).
   *
   * It decides whether the turn consumes what a composer staged — images, `/`
   * directives, inspector picks — and whether sending mid-turn queues instead
   * of being dropped. A resubmit must do neither: the staged items belong to
   * the next thing the user types, not to a message they already sent.
   */
  interactive?: boolean;
  /**
   * The `aurora agent` task this send is fulfilling, when a terminal
   * dispatched it.
   *
   * Forwarded to Rust, which tees the turn's events into that task's
   * transcript so the terminal can follow the same work. Absent for every
   * send a person makes, which is the overwhelming majority.
   */
  cliTaskId?: string | null;
}

/**
 * Which conversation a send pipeline drives.
 *
 * Omitted, the pipeline follows the OPEN chat — the main pane's behaviour. A
 * chat docked in the side panel passes its own binding, so its composer, stop
 * button and approval prompt act on ITS thread while the main pane keeps
 * driving another one. Both can stream at the same time; the runtime already
 * locks per thread and the store already keys live turns by thread id.
 */
export interface BoundConversation {
  threadId: string;
  projectRoot: string | null;
  /**
   * This panel's loaded transcript, used to seed a live turn.
   *
   * A function, not a value: the seed is read at send time, so a transcript
   * that finished loading (or grew) after mount is still the one used. Without
   * it a docked send would open its live turn on an empty stub and the history
   * above the new message would vanish until the turn ended.
   */
  getSeed: () => import("@/apps/agent/services/threads/thread-service").DbThread | null;
}

export function useAgentWindowSend(bound?: BoundConversation): AgentWindowSend {
  // The conversation this pipeline drives: an explicit binding, else the open
  // chat. Everything below reads THIS rather than `currentThreadId`, which is
  // what lets a docked chat run its own turn without touching the main pane.
  const openThreadId = useAgentChatStore((s) => s.currentThreadId);
  const targetThreadId = bound?.threadId ?? openThreadId;

  // "Sending" means THIS conversation is streaming — a turn running in any
  // other chat must not lock the composer you're looking at.
  const sending = useAgentChatStore(
    (s) => !!targetThreadId && !!s.liveTurns[targetThreadId],
  );
  const [pendingApprovals, setPendingApprovals] = useState<
    Record<string, PendingApproval>
  >({});
  const pendingApproval = targetThreadId
    ? pendingApprovals[targetThreadId] ?? null
    : null;
  // One unresolved `always_ask` promise per running thread. Parallel turns must
  // never overwrite each other's approval resolver.
  const approvalResolversRef = useRef(
    new Map<string, (ok: boolean) => void>(),
  );
  // Latest `send`, so the post-turn auto-flush can resubmit a queued injection
  // as a fresh turn without `send` having to depend on itself.
  const sendRef = useRef<
    | ((
        raw: string,
        target?: BackgroundSendTarget,
        fileChips?: AttachedPromptChip[],
        options?: SendOptions,
      ) => Promise<void>)
    | null
  >(null);

  const resolveApproval = useCallback((ok: boolean) => {
    const threadId = targetThreadId;
    if (!threadId) return;
    const resolver = approvalResolversRef.current.get(threadId);
    approvalResolversRef.current.delete(threadId);
    setPendingApprovals((current) => {
      if (!(threadId in current)) return current;
      const next = { ...current };
      delete next[threadId];
      return next;
    });
    resolver?.(ok);
  }, [targetThreadId]);

  const approve = useCallback(() => resolveApproval(true), [resolveApproval]);
  const reject = useCallback(() => resolveApproval(false), [resolveApproval]);
  const approveAlways = useCallback(() => {
    const tool = pendingApproval?.toolName;
    if (tool) useAgentSettingsStore.getState().setToolApproval(tool, "auto");
    resolveApproval(true);
  }, [pendingApproval, resolveApproval]);

  const stop = useCallback(() => {
    // Cancel THIS conversation's turn only — every other running chat, docked
    // or backgrounded, keeps going.
    if (targetThreadId) {
      resolveApproval(false);
      runningAgents.get(targetThreadId)?.stop();
    }
  }, [resolveApproval, targetThreadId]);

  const compact = useCallback(async () => {
    const store = useAgentChatStore.getState();
    const threadId = targetThreadId;
    const seed = bound ? bound.getSeed() : store.currentThread;
    if (!threadId || !seed || store.liveTurns[threadId]) return;

    const settings = useAgentSettingsStore.getState();
    // Compaction is a real model call on this conversation's history, so it
    // rides the conversation's own model — not whichever one is selected now.
    const modelSelection = resolveThreadModel(threadId);
    let compactRequest: ReturnType<typeof resolveModelRequest>;
    try {
      compactRequest = resolveModelRequest(modelSelection, settings.thinkingEnabled);
    } catch {
      return;
    }
    if (!compactRequest) return;
    const llmConfig = compactRequest.providerConfig;
    let compactionProvider;
    try {
      compactionProvider = settings.compactionModel
        ? resolveModelRequest(settings.compactionModel, settings.thinkingEnabled)
            ?.providerConfig
        : undefined;
    } catch {
      // A stale auxiliary Cursor variant must not prevent the conversation's
      // own model from compacting. Undefined deliberately falls back to it.
      compactionProvider = undefined;
    }

    // Chat wins outright: Team is a Build-side feature, and a chat conversation
    // must never be promoted into one because the team switch happens to be on.
    const executionMode = effectiveExecutionMode(
      settings.auroraSurface,
      settings.teamEnabled && settings.agentExecutionMode !== "plan"
        ? "team"
        : settings.agentExecutionMode,
    );
    // A docked chat compacts against ITS project, not the window's current
    // scope — the window may have been re-scoped since the tab was opened. A
    // chat has no project at all, so the summarizer is not handed one either.
    const projectRoot = effectiveProjectRoot(
      executionMode,
      bound ? bound.projectRoot : store.projectRoot,
    );
    const markerId = genId();
    let markerStarted = false;
    let markerSettled = false;
    // When the summary call began, for the card's live clock and for the
    // duration it settles to. Compaction is one model call over the whole
    // conversation and routinely runs for minutes, so a shimmer with no number
    // beside it cannot be told apart from a hang — the same reason the
    // mid-turn marker stamps one (`appendCompaction`).
    let markerStartedAt = 0;

    store.beginTurn(threadId, seed, projectRoot);
    store.setThreadActivity(threadId, { label: "Compacting context…" });

    const agent = new AgentService();
    runningAgents.set(threadId, agent);
    agent.setProvider(llmConfig);
    agent.setThreadId(threadId);
    agent.updateConfig({
      executionMode,
      reasoning: compactRequest.reasoning,
      workspacePath: projectRoot,
      maxTokens:
        llmConfig.defaultMaxTokens ?? llmConfig.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
      compactionThresholdPct: settings.compactionThresholdPct,
      compactionSummaryBudget: settings.compactionSummaryBudget,
      // A manual `/compact` honours the pinned summarizer exactly as an
      // automatic one does — same call, same model.
      compactionProvider,
      workspaceAccess: settings.workspaceAccess,
    });

    /** How long the run took, or `undefined` when it never started a clock. */
    const settledDuration = () =>
      markerStartedAt > 0 ? Date.now() - markerStartedAt : undefined;

    const completeMarker = (beforeTokens: number, afterTokens: number) => {
      markerSettled = true;
      const content = JSON.stringify({
        beforeTokens,
        afterTokens,
        status: "completed",
        startedAt: markerStartedAt || undefined,
        durationMs: settledDuration(),
      });
      if (!markerStarted) {
        markerStarted = true;
        store.appendTurnMessage(threadId, {
          id: markerId,
          role: "compaction",
          content,
          timestamp: nowIso(),
        });
      } else {
        store.patchTurnMessage(threadId, markerId, (message) => ({
          ...message,
          content,
        }));
      }
      // Drop the ring to the post-compaction size immediately; the next real
      // request replaces it with a measurement. Recorded as a PROJECTION, not
      // as usage — overwriting the provider's own numbers with ours made the
      // card claim the provider had reported nothing and erased the cache-hit
      // row along with it.
      useAgentContextStore.getState().setProjectedUsage(threadId, afterTokens);
    };

    const failMarker = (info: { beforeTokens: number; reason: string; cancelled: boolean }) => {
      markerSettled = true;
      const content = JSON.stringify({
        beforeTokens: info.beforeTokens,
        afterTokens: 0,
        status: info.cancelled ? "cancelled" : "failed",
        reason: info.reason,
        startedAt: markerStartedAt || undefined,
        durationMs: settledDuration(),
      });
      if (!markerStarted) {
        markerStarted = true;
        store.appendTurnMessage(threadId, {
          id: markerId,
          role: "compaction",
          content,
          timestamp: nowIso(),
        });
      } else {
        store.patchTurnMessage(threadId, markerId, (message) => ({ ...message, content }));
      }
    };

    try {
      const result = await agent.compactThread({
        onCompactionStarted: () => {
          markerStarted = true;
          markerStartedAt = Date.now();
          store.appendTurnMessage(threadId, {
            id: markerId,
            role: "compaction",
            content: JSON.stringify({
              beforeTokens: 0,
              afterTokens: 0,
              status: "running",
              startedAt: markerStartedAt,
            }),
            timestamp: nowIso(),
          });
        },
        onCompactionCompleted: completeMarker,
        onCompactionFailed: failMarker,
      });
      if (result && !markerStarted) {
        completeMarker(result.beforeTokens, result.afterTokens);
      }
    } catch (error) {
      console.error("[agent-window] manual compaction failed:", error);
      if (markerStarted && !markerSettled) {
        failMarker({ beforeTokens: 0, reason: "runtime_error", cancelled: false });
      }
    } finally {
      runningAgents.delete(threadId);
      // The summarization request carried the whole head of the conversation
      // — routinely the single largest charge in a long chat. `sendTurn` marks
      // the cost basis stale in its own `finally`; this path never did, so the
      // card kept serving its pre-compaction copy and the charge appeared
      // nowhere in Aurora. In `finally` for the same reason as there: a failed
      // compaction still spent the tokens it spent.
      useAgentContextStore.getState().invalidateBreakdown(threadId);
      await store.refreshThreads();
      store.endTurn(threadId);
    }
  }, [bound, targetThreadId]);

  const sendTurn = useCallback(async (
    raw: string,
    target?: BackgroundSendTarget,
    fileChips: AttachedPromptChip[] = [],
    options?: SendOptions,
  ) => {
    const content = raw.trim();
    if (!content) return;

    // Did a person press send, or is the pipeline resubmitting on their behalf?
    // Only a human send consumes what a composer staged and may queue mid-turn.
    const fromComposer = !target || target.interactive === true;

    // Which composer's staging tray this turn drains. Composers file under their
    // own thread (`"draft"` before one exists), so a docked chat's send can
    // never pick up what was staged in the main pane — they are different trays
    // that happen to look identical.
    const stageKey = composerKey(
      target ? target.threadId : useAgentChatStore.getState().currentThreadId,
    );

    // Mid-turn injection: if this conversation already has a streaming turn,
    // queue the text instead of starting a second one. The Rust runtime drains
    // the slot at the next tool-result boundary and staples it onto the tool
    // message, so the model sees it inline (parity with the IDE).
    //
    // A steering message must be as accurate as a fresh turn: `@` file
    // mentions already ride in the text (`@rel`), staged `/` directives are
    // consumed HERE and resolved into a `<steering_context>` block on the
    // model copy — a mid-turn send used to silently drop them (they stayed
    // staged and leaked onto the NEXT turn) — and inspector picks ride the
    // same block. Picks used to wait for a fresh turn, which read as a silent
    // drop: the pills left the composer, the injected bubble showed bare
    // text, and nothing said whether the model ever saw the elements. It had
    // not. An element block is plain text and rides a tool-result boundary as
    // well as any rule does.
    if (fromComposer) {
      const chat = useAgentChatStore.getState();
      const liveThreadId = target?.threadId ?? chat.currentThreadId;
      if (liveThreadId && chat.liveTurns[liveThreadId]) {
        const steeringCommands = composerCommands(
          useAgentCommandStore.getState(),
          stageKey,
        ).filter(isDirectiveCommand);
        const steeringSelection = buildCommandSelection(steeringCommands);
        const steeringCommandChips = steeringCommands.map((c) => ({
          kind: c.kind,
          title: c.title,
        } satisfies AttachedPromptChip));
        if (steeringCommands.length > 0) {
          useAgentCommandStore.getState().clear(stageKey);
        }

        // Inspector picks: full context to the model (below), a compact pill
        // per element on the queued card and the injected row. Consumed now —
        // leaving them staged is what made them leak onto the next turn.
        const steeringPicks = useAgentSelectionStore.getState().selected;
        const steeringPickChips = steeringPicks.map((entry) => ({
          kind: "element" as const,
          title: `<${entry.element.tagName}> ${(entry.element.text ?? "").trim().slice(0, 24)}`.trim(),
          value: entry.element.selector,
          // The pick's index, so the injected row can anchor this pill at its
          // `@element:N` token in the text. Carried in `path` because that is
          // a field the Rust chip struct round-trips — a TS-only field would
          // be dropped between enqueue and the injection event.
          path: String(entry.index),
        } satisfies AttachedPromptChip));
        if (steeringPicks.length > 0) useAgentSelectionStore.getState().clear();

        const chips = [...fileChips, ...steeringCommandChips, ...steeringPickChips];

        // Staged image attachments ride the injection as `<aurora_image>`
        // markers — the same wire path `browser_screenshot` uses, so a
        // mid-turn image reaches a vision model as a real image part
        // (staging is already vision-gated at the composer). The display
        // copy carries the markers too, so the inline injected row renders
        // the same thumbnails a user bubble would.
        const steeringImages = composerImages(
          useAgentAttachmentStore.getState(),
          stageKey,
        );
        const displayWithImages = appendImageMarkers(content, steeringImages);
        if (steeringImages.length > 0) {
          useAgentAttachmentStore.getState().clear(stageKey);
        }

        // Resolve directive content the same way a fresh turn does. The
        // system prompt of an in-flight turn can't change, so the resolved
        // blocks ride inside the injected message instead of ideContext.
        const steeringRoot = target?.projectRoot ?? chat.projectRoot;
        const blocks: string[] = [];
        // Same block a fresh turn sends via ideContext — selector, tag, text
        // and clipped HTML per element, so the model can locate the source.
        const steeringSelectionBlock = buildSelectionContext(steeringPicks);
        if (steeringSelectionBlock) blocks.push(steeringSelectionBlock);
        const steeringRules = await buildRuleContext(
          steeringRoot,
          steeringSelection.ruleFilenames,
        );
        if (steeringRules) blocks.push(steeringRules);
        const steeringMcp = buildMcpDirective(steeringSelection.mcpServerNames);
        if (steeringMcp) blocks.push(steeringMcp);
        const steeringImage = buildImageRequest(steeringSelection.imageRequested);
        if (steeringImage) blocks.push(steeringImage);
        if (steeringSelection.explicitSkillKeys.length > 0) {
          try {
            const s = useAgentSettingsStore.getState();
            const resolved = await resolveSkillsForPrompt({
              enabledSkillToggles: getWorkspaceSkillToggles(s.skillToggles, steeringRoot),
              explicitSkillKeys: steeringSelection.explicitSkillKeys,
              skillsEnabled: s.skillsEnabled,
              userMessage: content,
              workspacePath: steeringRoot ?? undefined,
            });
            if (resolved.explicitSkills.length > 0) {
              blocks.push(formatSkillReferences(resolved.explicitSkills, "required_skills"));
            }
          } catch (err) {
            console.warn("[agent-window] mid-turn skill resolution failed:", err);
          }
        }
        // Tag pair is a contract with the Rust reload path
        // (`strip_steering_context` in commands/threads.rs) — it cuts this
        // block back out of the injected row's display text. (The runtime
        // adds its own mid-turn framing preamble at injection time.)
        const modelText =
          blocks.length > 0
            ? `${displayWithImages}\n\n<steering_context>\n${blocks.join("\n\n")}\n</steering_context>`
            : steeringImages.length > 0
              ? displayWithImages
              : undefined;
        void chat.enqueueMessage(liveThreadId, content, {
          modelText,
          displayText: steeringImages.length > 0 ? displayWithImages : undefined,
          chips: chips.length > 0 ? chips : undefined,
          imageCount: steeringImages.length > 0 ? steeringImages.length : undefined,
        });
        return;
      }
    }

    // Drain any staged image attachments into `<aurora_image>` markers appended
    // to the message. `contentForModel` is what the runtime sees and persists
    // (and what the user bubble renders images from); `content` stays clean for
    // the thread title/preview seed. Attachments are vision-gated at the
    // composer, so they're only present for a vision-capable model.
    const attachments = fromComposer
      ? composerImages(useAgentAttachmentStore.getState(), stageKey)
      : [];
    const contentForModel = appendImageMarkers(content, attachments);
    if (attachments.length > 0) useAgentAttachmentStore.getState().clear(stageKey);

    // Snapshot the inspector picks ONCE, up front: the compact `pills` ride on
    // the user bubble (display), the full `<selected_elements>` block rides to
    // the model via ideContext (below). Clear the composer chips now so the
    // selection isn't reused on the next turn.
    //
    // Still window-global, unlike the trays above: there is ONE inspector (the
    // browser panel), so its picks belong to whichever composer sends next
    // rather than to a particular conversation.
    const picks = fromComposer ? useAgentSelectionStore.getState().selected : [];
    const selectionPills = buildSelectionPills(picks);
    if (picks.length > 0) useAgentSelectionStore.getState().clear();

    // Snapshot the staged `/` directives (skills / rules / MCP) for THIS turn,
    // then clear the chips so they don't ride along on the next message. Skills
    // thread through `explicitSkillKeys`; rules + MCP become context blocks below.
    const stagedCommands = fromComposer
      ? composerCommands(useAgentCommandStore.getState(), stageKey).filter(
          isDirectiveCommand,
        )
      : [];
    const commandSelection = buildCommandSelection(stagedCommands);
    // Compact chips snapshotted for the user bubble (display only — the
    // directive's effect rides to the model via ideContext / explicitSkillKeys).
    const commandChips = stagedCommands.map((c) => ({
      kind: c.kind,
      title: c.title,
    } satisfies AttachedPromptChip));
    const promptChips = [...fileChips, ...commandChips];
    if (stagedCommands.length > 0) {
      useAgentCommandStore.getState().clear(stageKey);
    }

    const store = useAgentChatStore.getState();

    const settings = useAgentSettingsStore.getState();

    // Execution mode for this turn. The agent window has NO separate "Lead" and
    // no mode toggle — the chat model in the selector IS the Lead. So enabling
    // Team in Settings is the whole opt-in: the model runs in Team mode (which is
    // what exposes the `team_*` tools + the Lead guidance so it can actually
    // dispatch a team), except in read-only Plan mode where mutations are off.
    // A per-turn override outranks the window's setting, and is how
    // `aurora agent --plan` gets read-only tools. It has to be per-turn: the
    // global setter would leave the window in plan mode after the dispatch
    // finished, and two concurrent dispatches in different modes would each
    // overwrite the other's.
    const requestedMode = options?.executionMode ?? settings.agentExecutionMode;
    // `aurora agent --plan` can override the Build mode for one turn, but it
    // cannot reach across into Chat: a CLI task addresses a project, and Chat
    // has none. So the surface is applied AFTER the override, not before.
    const executionMode = effectiveExecutionMode(
      settings.auroraSurface,
      settings.teamEnabled && requestedMode !== "plan" ? "team" : requestedMode,
    );

    // Bootstrap the thread (create-on-first-send) BEFORE touching the UI so a
    // failed creation doesn't leave a half-rendered turn. Only the main pane can
    // be a draft — a docked chat always addresses a thread that already exists.
    const wasDraft = !target && !store.currentThreadId;
    const threadId = target?.threadId ?? await store.ensureThreadForSend(content);

    // Per-THREAD guard: block a second turn on the SAME thread, but allow other
    // threads to run concurrently (that's the whole point of parallel turns).
    if (useAgentChatStore.getState().liveTurns[threadId]) return;

    // The model belongs to the CONVERSATION, so it can only be resolved once we
    // know which thread this turn is for — which is why it's read here and not
    // with the rest of the settings above. Two chats streaming side by side each
    // run on their own model; a chat you haven't given one falls back to the
    // user's default. Resolved at SEND time so a pick made while the composer
    // was focused counts toward this turn.
    //
    // A dispatch that NAMED a model wins outright. It cannot go through the
    // thread: a conversation created for this very send is not in the summary
    // lists yet, so the pin has nowhere to live until the first message lands
    // (see `SendOptions.model`). Reading the thread first would silently run
    // the wrong model, which is exactly the bug this replaced.
    const modelSelection =
      options?.model?.trim() || resolveThreadModel(threadId);

    // Capture the project for THIS turn now — the user may navigate to another
    // project while it runs, and tools must stay rooted at the originating one.
    // A chat turn has none: the window keeps the project so Build can resume on
    // it, and `effectiveProjectRoot` is where that memory stops.
    const projectRoot = effectiveProjectRoot(
      executionMode,
      target?.projectRoot ?? store.projectRoot,
    );

    // The conversation's model IS an image model: the reply is a picture, made
    // by one call, with none of the language-model machinery below (no context
    // blocks, no tools, no stream). Decided here, after the pin is resolved and
    // before the live turn opens, so the two paths share everything up to the
    // point they genuinely differ. The staged `/` chips were consumed above
    // and are not forwarded — an image model cannot read a rule.
    const directImage = imageModelFromSelection(modelSelection, settings.imageProviders);
    if (directImage) {
      await runDirectImageTurn({
        threadId,
        prompt: content,
        provider: directImage.provider,
        model: directImage.model,
        modelSelection,
        seed: target?.seed,
        projectRoot,
        executionMode,
      });
      return;
    }

    // Open a LIVE turn keyed to this thread. Streaming targets `liveTurns[id]`,
    // so navigating away mid-turn doesn't drop the in-flight work — it keeps
    // running and re-attaches when the user opens this chat again.
    // The mode this turn ACTUALLY runs under, which is not always the
    // window's setting — `aurora agent --plan` overrides it for one turn. The
    // composer reads this so it shows what is running rather than what is
    // configured.
    store.beginTurn(threadId, target?.seed, projectRoot, executionMode);

    // Reset the turn's running cost. Every request this turn makes folds into
    // it, so a long tool-using turn shows a cost that climbs instead of one
    // that reports only its final request.
    useAgentContextStore.getState().beginTurn(threadId);

    // The checklist is NOT cleared here. Rust owns it and it is durable per
    // thread, so a multi-turn task list must survive into the next turn — the
    // agent is still working through it, and `todo_write` replaces it when a
    // genuinely new list starts.

    // Optimistic opener — the runtime re-persists this verbatim, so the
    // reload at the end reconciles it to the authoritative id.
    //
    // A turn Aurora started because a background process ended has no user
    // bubble — nobody typed "Failed pnpm test · exit 1". It gets a `process`
    // row instead, the exact shape `threads.rs` rebuilds from the persisted
    // `ProcessEvent` block, and `buildTurns` turns that row into a fresh
    // assistant turn whose first line is the beat. The row is what gives the
    // reply its own turn: seeding the beat into the streaming message with
    // no row above it left that message consecutive with the previous
    // reply, the two merged, and the answer streamed into a bubble that had
    // already settled and scrolled past. Live and reloaded now disagree
    // about nothing.
    if (options?.origin === "process") {
      store.appendTurnMessage(threadId, {
        id: genId(),
        role: "process",
        content: options.summary?.trim() || contentForModel,
        timestamp: nowIso(),
      });
    } else {
      store.appendTurnMessage(threadId, {
        id: genId(),
        role: "user",
        content: contentForModel,
        attachedSelectedElements: selectionPills.length > 0 ? selectionPills : undefined,
        attachedCommands: commandChips.length > 0 ? commandChips : undefined,
        attachedPromptChips: promptChips.length > 0 ? promptChips : undefined,
        timestamp: nowIso(),
      });
    }

    // AI title maker — ONLY for the first message of a NEW chat (never existing
    // threads). Fire-and-forget so it never blocks the turn; on success it
    // replaces the derived title in meta + UI, on any error the derived title
    // stands. Disabled or unconfigured → skipped entirely (no-op).
    if (wasDraft) {
      void maybeGenerateTitle(threadId, content);
    }

    // Resolve every model-specific request choice before doing the expensive
    // context work below. Cursor resolution is exact and can fail when a saved
    // combination no longer exists on the account. Surface that as a
    // recoverable assistant message and close the optimistic turn cleanly.
    let resolvedRequest: ReturnType<typeof resolveModelRequest>;
    try {
      // This is the SAME resolver the per-model connection test calls. It
      // applies the model-level API format, the typed reasoning request, and
      // provider-native variants once. Keeping a second hand-built path here
      // is how tests passed on one wire while real turns ran on another.
      resolvedRequest = resolveModelRequest(modelSelection, settings.thinkingEnabled);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      store.appendTurnMessage(threadId, {
        id: genId(),
        role: "assistant",
        content: `Cursor couldn't start this turn.\n\n${detail}`,
        timestamp: nowIso(),
      });
      store.endTurn(threadId);
      return;
    }
    if (!resolvedRequest) {
      store.appendTurnMessage(threadId, {
        id: genId(),
        role: "assistant",
        content:
          "This chat's model is no longer available, or no provider is configured. Choose a model in Settings → Providers and try again.",
        timestamp: nowIso(),
      });
      store.endTurn(threadId);
      return;
    }
    const {
      providerConfig,
      model: activeModel,
      reasoning,
      thinkingEnabled,
      thinkingBudgetTokens,
    } = resolvedRequest;
    // The model this turn's requests are billed against. Use the row the
    // resolver actually selected (important when a deleted pin fell back),
    // while keeping Cursor's composed wire id out of durable accounting.
    const turnModel = activeModel
      ? `${activeModel.providerId}:${activeModel.modelKey}`
      : `${providerConfig.id}:${providerConfig.model}`;

    let compactionProvider;
    try {
      compactionProvider = settings.compactionModel
        ? resolveModelRequest(settings.compactionModel, settings.thinkingEnabled)
            ?.providerConfig
        : undefined;
    } catch {
      // Keep the chat usable when a pinned auxiliary Cursor variant vanished;
      // the Rust runtime will summarize on this conversation's own model.
      compactionProvider = undefined;
    }

    // The streaming assistant target. It follows the opener row appended
    // above — a user bubble or a process row — and `buildTurns` merges it
    // into the turn that row opened, whichever kind it was.
    const assistantId = genId();
    const assistantSeed: DbMessage = {
      id: assistantId,
      role: "assistant",
      content: "",
      timestamp: nowIso(),
      tool_calls: [],
      timeline: [],
    };
    store.appendTurnMessage(threadId, assistantSeed);
    let streamAttemptCheckpoint: DbMessage | null = null;

    const patchTurn = useAgentChatStore.getState().patchTurnMessage;
    const patchMessage = (id: string, patch: (m: DbMessage) => DbMessage) =>
      patchTurn(threadId, id, patch);
    // Header narrator: a short, plain-language line of what the agent is doing
    // right now. Written on phase changes (thinking → tool → responding); the
    // store setter no-ops when unchanged, so calling it per token is free.
    const setActivity = (activity: AgentActivity) =>
      useAgentChatStore.getState().setThreadActivity(threadId, activity);

    // ── Streaming-text coalescing ─────────────────────────────────────
    // Tokens arrive far faster than the display refreshes (bursty, often
    // several per millisecond). Patching the store per token re-renders the
    // whole transcript per token — the streaming jank that grows with the
    // size of the active turn. Text deltas buffer here and flush as ONE
    // store patch per animation frame (a timer backstops hidden windows,
    // where rAF doesn't fire). Anything that appends a NON-text timeline
    // event flushes first, so the ordered timeline stays exact.
    const pendingText: Array<{ kind: "content" | "thinking"; text: string }> = [];
    let textFlushRaf: number | null = null;
    let textFlushTimer: number | null = null;
    const flushStreamText = () => {
      if (textFlushRaf !== null) {
        cancelAnimationFrame(textFlushRaf);
        textFlushRaf = null;
      }
      if (textFlushTimer !== null) {
        window.clearTimeout(textFlushTimer);
        textFlushTimer = null;
      }
      if (pendingText.length === 0) return;
      const deltas = pendingText.splice(0, pendingText.length);
      patchMessage(assistantId, (m) => {
        // The retry is streaming, so the "reconnecting" marker has done its
        // job. Removed in the SAME patch that appends the recovered text, so
        // the marker never blinks out a frame before the reply resumes.
        let timeline = clearReconnect(timelineOf(m));
        let content = m.content || "";
        let thinking = m.thinking || "";
        let isThinking = !!m.isThinking;
        for (const d of deltas) {
          if (d.kind === "content") {
            // First content token ends the reasoning phase → thinking block
            // auto-collapses (same trigger the IDE uses via `isThinking`).
            content += d.text;
            timeline = appendContent(timeline, d.text);
            isThinking = false;
          } else {
            thinking += d.text;
            timeline = appendThinking(timeline, d.text);
            isThinking = true;
          }
        }
        return { ...m, content, thinking, isThinking, timeline };
      });
    };
    /**
     * Throw the buffered deltas away instead of flushing them.
     *
     * Only for a reply the runtime has abandoned: those tokens are about to be
     * re-sent from the start, so flushing them would render text that is then
     * immediately truncated — one wasted frame of the duplicate we are here to
     * prevent.
     */
    const dropPendingStreamText = () => {
      if (textFlushRaf !== null) {
        cancelAnimationFrame(textFlushRaf);
        textFlushRaf = null;
      }
      if (textFlushTimer !== null) {
        window.clearTimeout(textFlushTimer);
        textFlushTimer = null;
      }
      pendingText.length = 0;
    };
    const queueStreamText = (kind: "content" | "thinking", text: string) => {
      const last = pendingText[pendingText.length - 1];
      if (last && last.kind === kind) last.text += text;
      else pendingText.push({ kind, text });
      if (textFlushRaf === null && textFlushTimer === null) {
        textFlushRaf = requestAnimationFrame(flushStreamText);
        textFlushTimer = window.setTimeout(flushStreamText, 200);
      }
    };

    // Wall-clock timing per tool call, anchored on the runtime's
    // execution-start / result events. Native Rust tools emit execution_start
    // BEFORE their permission gate, so approval windows are recorded
    // separately and only the part overlapping [start, end] is subtracted —
    // a 40-second approval must never read as a 40-second tool. Bridge tools
    // (MCP) start AFTER approval, so their overlap is naturally zero.
    const toolTimings = new Map<
      string,
      { start: number; approval: Array<{ from: number; to: number }> }
    >();
    const markToolStart = (id: string) => {
      if (!toolTimings.has(id)) {
        toolTimings.set(id, { start: performance.now(), approval: [] });
      }
    };
    const settleToolDuration = (id: string): number | undefined => {
      const timing = toolTimings.get(id);
      if (!timing) return undefined;
      toolTimings.delete(id);
      const end = performance.now();
      let approvalWait = 0;
      for (const w of timing.approval) {
        approvalWait += Math.max(
          0,
          Math.min(w.to, end) - Math.max(w.from, timing.start),
        );
      }
      return Math.max(0, end - timing.start - approvalWait);
    };

    const upsertToolCall = (
      tc: ToolCallRequest,
      result?: string | null,
      startedAt?: number,
    ) => {
      // Keep timeline order exact: buffered text lands BEFORE this tool event.
      flushStreamText();
      patchMessage(assistantId, (m) => {
        const calls = m.tool_calls ? [...m.tool_calls] : [];
        const idx = calls.findIndex((c) => c.id === tc.id);
        const next = {
          id: tc.id,
          name: tc.function.name,
          arguments: tc.function.arguments || "",
          result: result !== undefined ? result : idx >= 0 ? calls[idx].result : null,
          durationMs: idx >= 0 ? calls[idx].durationMs : undefined,
          // This object is rebuilt from scratch on every argument delta, so a
          // field that is not carried forward here is a field that is wiped
          // dozens of times per call.
          startedAt: startedAt ?? (idx >= 0 ? calls[idx].startedAt : undefined),
        };
        if (idx >= 0) calls[idx] = next;
        else calls.push(next);
        // A tool starting means the reasoning phase is over — collapse it
        // (mirrors the IDE flipping `isThinking` off once work begins). The
        // tool is also appended to the ORDERED timeline so it renders in the
        // exact spot the model emitted it (between content segments).
        return {
          ...m,
          tool_calls: calls,
          isThinking: false,
          // `clearReconnect` for the case where the recovered attempt opens
          // with a tool call instead of text — the text flush is the usual
          // place the marker goes, and it never runs on that path.
          timeline: upsertToolEvent(clearReconnect(timelineOf(m)), next),
        };
      });
    };
    // `shell_spawn` starts something that outlives the tool call, so the user
    // needs a way to see and stop it. Mirror the spawn into the per-thread
    // background store, which drives the cards docked above the composer; a
    // `shell_kill` settles the matching card so it stops claiming to run.
    const captureBackgroundProcess = (tc: ToolCallRequest, result: string) => {
      if (tc.function.name === "shell_spawn") {
        const spawned = parseSpawnResult(result);
        if (spawned) useAgentBackgroundStore.getState().track(threadId, spawned);
        return;
      }
      if (tc.function.name === "shell_kill") {
        const killed = parseKillResult(result);
        // "stopped", not "exited": the agent ended it deliberately, which is
        // also what the log's closing line says. A row reporting a natural
        // finish for a kill would contradict the file.
        if (killed) useAgentBackgroundStore.getState().settle(killed, "stopped");
      }
    };

    // `generate_image` lands its picture on the Canvas from the Rust side, so
    // the artifact store has not seen it. Re-read the bundle on success (an
    // error result is a sentinel string, never a marker) so the card's "Open in
    // Canvas" finds the entry and the dock's Canvas tab lists it without a
    // reload. Fire-and-forget: the tool already succeeded.
    const captureCanvasWrite = (tc: ToolCallRequest, result: string) => {
      if (tc.function.name !== "generate_image") return;
      if (result.trimStart().startsWith("[error]")) return;
      void useAgentArtifactStore.getState().absorbRuntimeWrite(threadId);
    };

    // The checklist is NOT mirrored from tool-call arguments any more. Rust
    // emits `agent_todo_write` after every todo tool call and
    // `useAgentTaskStore` subscribes to it, so `todo_update` and `todo_write`
    // both move the panel. Parsing args here only ever saw `todo_write`, which
    // is why the panel froze at 0/N while the agent worked the list.

    const setToolResult = (tc: ToolCallRequest, result: string, durationMs?: number) => {
      flushStreamText();
      patchMessage(assistantId, (m) => {
        const calls = (m.tool_calls ?? []).map((c) =>
          c.id === tc.id
            ? { ...c, result, durationMs: durationMs ?? c.durationMs }
            : c,
        );
        const updated = calls.find((c) => c.id === tc.id);
        return {
          ...m,
          tool_calls: calls,
          timeline: updated
            ? upsertToolEvent(timelineOf(m), updated)
            : timelineOf(m),
        };
      });
    };

    // The workspace path and the access rules used to ride here, and they do
    // not belong: neither changes while a conversation runs, so re-sending
    // them every time the checklist or the open files moved was pure repeat.
    // They are stated once in the cached system prompt now — see
    // `formatEnvironment`, which follows OpenCode's split of session-fixed
    // facts from per-turn state.

    // Full element context for the model (located by the snapshot taken above).
    // The block tells the agent to locate each element's source file.
    const selectionBlock = buildSelectionContext(picks);

    // `/`-directive context: skills are resolved from `explicitSkillKeys` in the
    // system prompt, but rules + MCP have no native channel here — so we surface
    // the user's selected project rules verbatim and nudge toward the named MCP
    // servers, both as authoritative IDE context blocks.
    const ruleBlock = await buildRuleContext(
      projectRoot,
      commandSelection.ruleFilenames,
    );
    const mcpBlock = buildMcpDirective(commandSelection.mcpServerNames);
    const imageBlock = buildImageRequest(commandSelection.imageRequested);

    // Standing `.aurora/*.md` project rules — capped, with `/`-attached rules
    // excluded since they already ride verbatim above. They go to the SYSTEM
    // PROMPT (via `promptContext.projectRules`), where every reference agent
    // keeps its instruction files: the same bytes on every request of the
    // conversation, inside the cached prefix. They used to ride in the
    // per-message context on the first message only, which put a standing
    // rule where a one-off fact belongs and lost it after a compaction.
    //
    // The skill catalogue and `/`-attached skills are composed into the
    // system prompt by `composeAgentSystemPrompt` from the same
    // `explicitSkillKeys`; nothing about skills is built here any more.
    const autoRulesBlock = await buildAutoRulesContext(
      projectRoot,
      commandSelection.ruleFilenames,
    );

    // Team policy: when this turn runs in Team mode, the Lead (this model) must
    // KNOW its live worker ceiling — it can't read settings on its own, so
    // without this it can only guess from the last dispatch's echo. `maxTeamSize`
    // is the number of parallel WORKERS the Lead may staff; the Lead is separate.
    const teamBlock =
      executionMode === "team"
        ? `<team_policy>\nAgent Team is ENABLED and you are the Lead. When you convene a team with team_dispatch you may staff UP TO ${settings.maxTeamSize} worker${
            settings.maxTeamSize === 1 ? "" : "s"
          } in parallel — this is the user's current "Maximum workers" setting. You (the Lead) are separate and always present, never counted in that number. If a task needs more workers than that, tell the user to raise it in Settings → Team; do not exceed it. Define each worker's role, task, and scope in the dispatch call.\n</team_policy>`
        : null;

    // What the user actually has open in the right dock. Rides on every turn
    // (it changes as they browse) and costs one line per file, because it
    // carries names and never content.
    //
    // Source is the DOCK TAB list, not the file tree's selection. Opening a
    // file from the tree creates its own tab (`openFileTab`), several files can
    // be open at once, and the tree's `selectedPath` is a different thing that
    // does not survive switching tabs — wiring to it produced a block that was
    // simply never there, which the agent reported verbatim: "this turn didn't
    // include the <open_files> block".
    const dock = useAgentWorkspaceStore.getState();
    const fileTabs = dock.tabs.filter(
      (tab) => tab.kind === "file" && typeof tab.path === "string" && tab.path,
    );
    const activeFilePath =
      fileTabs.find((tab) => tab.id === dock.activeTabId)?.path ?? null;
    const openFilesBlock = buildOpenFilesContext(
      fileTabs.map((tab) => tab.path as string),
      activeFilePath,
    );

    // What belongs to THIS message and nothing else: where the user's
    // attention is and what they attached to it. The runtime saves it on the
    // message as its `aurora_context`, the model reads it after the user's
    // words, and it never changes again. Standing facts (rules, skills, the
    // team policy, the mode) are in the system prompt — putting them here
    // meant a copy of the project rules in every message's saved context.
    const ideContext =
      [openFilesBlock, selectionBlock, ruleBlock, mcpBlock, imageBlock]
        .filter(Boolean)
        .join("\n\n") || null;

    // Per-model reasoning: the active model may carry an effort, toggle, or
    // budget profile set in Provider settings / the composer picker. The
    // provider-neutral profile is already resolved above; the Rust adapter
    // translates it into the selected API format.
    // THIS turn's model row, not the globally-active one: reasoning config
    // (effort tier / thinking budget) hangs off the model, so reading the
    // active row would apply another conversation's reasoning settings here.
    // Track whether the provider ever reported token usage this turn. If it
    // doesn't (many OpenAI-compatible backends skip `stream_options.include_usage`),
    // we fall back to a local tiktoken estimate so the context ring still shows.
    let usageFired = false;
    // The live compaction timeline-event id, set when a compaction starts mid-
    // turn so its completion can flip the same inline marker (before→after,
    // stop shimmer). It rides INSIDE the streaming assistant message's timeline
    // so content streamed after compaction renders below the marker.
    let compactionEventId: string | null = null;

    // Runtime notices already shown inline this turn. A failure the runtime
    // announces first and then fails on (a dropped stream) arrives twice —
    // once as the notice event, once as the rejection — and must only be said
    // once. Scoped per turn so a later turn can legitimately repeat it.
    const noticedMessages = new Set<string>();

    // A DEDICATED service instance for this turn so concurrent turns on other
    // threads keep their own client/config. Registered so `stop()` can target it.
    const agent = new AgentService();
    runningAgents.set(threadId, agent);
    // A new message supersedes the previous turn's reply chips immediately.
    useAgentSuggestStore.getState().clear(threadId);
    agent.setProvider(providerConfig);
    agent.setThreadId(threadId);
    agent.updateConfig({
      reasoning,
      // Backward-compatible mirrors for older runtime payload readers. Both
      // are derived from `reasoning`; no second resolution happens here.
      thinkingEnabled,
      thinkingBudgetTokens,
      executionMode,
      autoApproveTools: settings.autoApproveTools,
      // Pin tools to THIS turn's project (not the global store) so a turn keeps
      // operating on its own directory even after the user switches projects.
      workspacePath: projectRoot,
      // What the conversation is on, as opposed to what the request carries.
      // `applyCursorVariant` above folds the effort tier and Fast into
      // `providerConfig.model`; that composed id is a wire detail and must not
      // become the thread's model, or the row holding this model's context
      // window stops matching it.
      modelSelection,
      // Model → provider → Aurora's default. Set per model in Settings →
      // Providers; stripped in the Rust adapter for models that reject
      // sampling, so a value on a Claude 5 row costs nothing.
      temperature: resolveTemperature(activeModel, providerConfig.defaultTemperature),
      maxTokens:
        providerConfig.defaultMaxTokens ??
        providerConfig.maxOutputTokens ??
        DEFAULT_MAX_OUTPUT_TOKENS,
      // Agentic by design: no artificial tool-call cap — the runtime stops when
      // the model stops requesting tools.
      maxToolIterations: undefined,
      getToolApproval: settings.getToolApproval,
      // Context compaction (Settings → Agent). The runtime summarizes older
      // history into a persistent marker once the projected request crosses
      // the threshold; the summary budget caps the summarization call.
      compactionThresholdPct: settings.compactionThresholdPct,
      compactionSummaryBudget: settings.compactionSummaryBudget,
      // `null` when nothing is pinned (or the pin points at a deleted
      // provider) → the runtime summarizes on the conversation's own model.
      compactionProvider,
      workspaceAccess: settings.workspaceAccess,
      // Read once, here, for BOTH the tool roster and the prompt instruction —
      // this config field is what `AgentService` hands to
      // `composeAgentSystemPrompt` AND what the runtime client forwards to Rust,
      // so a turn can never have the tool without the instruction or vice versa.
      transcriptChapters: settings.transcriptChapters,
      browserTools: settings.browserTools,
      deferTools: settings.deferTools,
      // Aurora Chat's `generate_image` reads these on the Rust side. Read per
      // turn, like every other setting here, so a provider added or fixed in
      // Settings is usable from the very next message.
      imageProviders: executionMode === "chat" ? settings.imageProviders : undefined,
      // From the CONVERSATION, never from `deepResearchNext`. That setting only
      // decides what a new chat is born with; an open chat carries its own
      // answer, and reading the setting here would let flipping it change a
      // conversation that was framed the other way — and throw its prompt cache
      // away in the bargain.
      deepResearch: threadIsDeepResearch(threadId),
    });

    try {
      await agent.chat(
        contentForModel,
        {
          onToken: (token) => {
            // Final-answer text is streaming — the narrator reads "Responding…".
            setActivity({ label: "Responding…" });
            queueStreamText("content", token);
          },
          onThinking: (text) => {
            setActivity({ label: "Thinking…" });
            // A zero-length thinking event carries no renderable text — the
            // Anthropic adapter emits one at `content_block_stop` purely to
            // hand over the block signature, which the UI has no use for.
            // Appending it would open an empty reasoning segment that renders
            // as a bare "…" (AgentThinkingBlock's `content || "…"` fallback),
            // and after a tool row it can't merge into a prior segment so it
            // becomes its own stray row.
            if (!text) return;
            queueStreamText("thinking", text);
          },
          onUsage: (usage) => {
            usageFired = true;
            const context = useAgentContextStore.getState();
            // The context ring wants the LATEST request (each one resends the
            // whole history, so its input size IS the window occupancy). The
            // model travels with it: the ring holds a high-water reading, and
            // a reading from another tokenizer is not comparable to this one.
            context.setUsage(threadId, usage, turnModel);
            // The cost card wants the SUM: a turn makes one request per tool
            // iteration, and only adding them up gives what the turn actually
            // cost. Attributed to the model running this turn so a later
            // model switch prices its own requests, not these.
            context.addTurnUsage(threadId, turnModel, usage);
            // The conversation total is read from the transcript, and the
            // transcript just grew by this request. Marking it stale PER
            // REQUEST — not only at turn end — is what stops "This chat" from
            // reporting a figure that predates the turn you are watching: it
            // used to sit at the last completed turn's total, so a card opened
            // mid-turn showed a chat cost missing both the running turn and any
            // compaction it triggered. Marking is free; the refetch happens
            // only while the card is actually open.
            context.invalidateBreakdown(threadId);
            // The transcript's turn summary counts what this turn generated.
            // Every request of the turn lands on this one streaming message, so
            // they are added up here; a reload reads the same numbers back per
            // message from the session file.
            patchMessage(assistantId, (m) => ({
              ...m,
              usage: {
                input_tokens: (m.usage?.input_tokens ?? 0) + usage.promptTokens,
                output_tokens: (m.usage?.output_tokens ?? 0) + usage.completionTokens,
                estimated: m.usage?.estimated === true || usage.estimated === true || undefined,
              },
            }));
          },
          onQueuedMessageInjected: (text, chips, origin) => {
            // The runtime drained the queue and stapled the user's text onto the
            // tool message it's about to send. Render it inline in the streaming
            // assistant message — after the tool result, before the agent
            // continues — so the order matches what the model saw. No separate
            // user bubble (that would land after the streaming message and read
            // as if the agent replied before the user spoke). Then drop the pill.
            // `text` is the display copy; `chips` re-render the composer pills.
            //
            // The same slot also carries machine events — a background process
            // ending or being stopped. Those are nobody's words, so they get
            // the checklist beat's one-line row instead of the user's, and they
            // never touch the composer pill (they never lit it).
            flushStreamText();
            if (origin === "process") {
              patchMessage(assistantId, (m) => ({
                ...m,
                timeline: appendProcessBeat(timelineOf(m), text),
              }));
              return;
            }
            patchMessage(assistantId, (m) => ({
              ...m,
              timeline: appendUserInjection(timelineOf(m), text, chips),
            }));
            useAgentChatStore.getState().clearQueuedMessage(threadId);
          },
          // Context compaction (Rust runtime). The marker is appended to the
          // live transcript so the user sees it immediately; the authoritative
          // inline marker re-renders from the session JSONL on reopen. The
          // summary text is never sent to the UI — only the before→after drop.
          onCompactionStarted: () => {
            setActivity({ label: "Compacting context…" });
            flushStreamText();
            const id = nextEventId();
            compactionEventId = id;
            // Drop the marker INTO the streaming assistant timeline at the
            // current point, so prior content stays above it and everything the
            // agent streams next lands below it.
            patchMessage(assistantId, (m) => ({
              ...m,
              timeline: appendCompaction(timelineOf(m), id),
            }));
          },
          onCompactionCompleted: (beforeTokens, afterTokens) => {
            setActivity({ label: "Responding…" });
            if (compactionEventId) {
              const id = compactionEventId;
              patchMessage(assistantId, (m) => ({
                ...m,
                timeline: finishCompaction(timelineOf(m), id, {
                  status: "completed",
                  beforeTokens,
                  afterTokens,
                }),
              }));
              compactionEventId = null;
            }
            // Drop the ring immediately to the post-compaction size; the next
            // real usage event replaces it with a measurement. Recorded as a
            // PROJECTION rather than as usage — see `setProjectedUsage`.
            useAgentContextStore.getState().setProjectedUsage(threadId, afterTokens);
          },
          onCompactionFailed: ({ beforeTokens, reason, cancelled }) => {
            setActivity({ label: cancelled ? "Stopped" : "Responding…" });
            if (!compactionEventId) return;
            const id = compactionEventId;
            patchMessage(assistantId, (m) => ({
              ...m,
              timeline: finishCompaction(timelineOf(m), id, {
                status: cancelled ? "cancelled" : "failed",
                beforeTokens,
                reason,
              }),
            }));
            compactionEventId = null;
          },
          onToolCall: (tc) => {
            setActivity(describeToolActivity(tc.function.name, tc.function.arguments || ""));
            upsertToolCall(tc);
          },
          onToolExecutionStart: (tc) => {
            markToolStart(tc.id);
            setActivity(describeToolActivity(tc.function.name, tc.function.arguments || ""));
            // The card's clock starts here, on the same event `markToolStart`
            // anchors the measured duration to, so the running number and the
            // settled one describe the same span.
            upsertToolCall(tc, undefined, Date.now());
          },
          onToolExecutionComplete: (tc, result) => {
            captureBackgroundProcess(tc, result);
            captureCanvasWrite(tc, result);
            setToolResult(tc, result, settleToolDuration(tc.id));
          },
          onToolExecutionError: (tc, error) =>
            setToolResult(tc, `[error] ${error}`, settleToolDuration(tc.id)),
          onToolRejected: (tc, reason) => {
            toolTimings.delete(tc.id);
            setToolResult(tc, `[rejected] ${reason}`);
          },
          onToolApprovalRequired: async (tc) => {
            const approvalBegan = performance.now();
            try {
              const mode = settings.getToolApproval(tc.function.name);
              if (settings.autoApproveTools || mode === "auto") return true;
              if (mode === "deny") return false;
              // always_ask → block on the inline prompt.
              return await new Promise<boolean>((resolve) => {
                approvalResolversRef.current.get(threadId)?.(false);
                approvalResolversRef.current.set(threadId, resolve);
                setPendingApprovals((current) => ({
                  ...current,
                  [threadId]: {
                    id: tc.id,
                    toolName: tc.function.name,
                    args: tc.function.arguments || "",
                  },
                }));
              });
            } finally {
              // Native tools are already timing (execution_start precedes their
              // gate) — log the wait so it's excluded from the tool's duration.
              const approvalEnded = performance.now();
              toolTimings
                .get(tc.id)
                ?.approval.push({ from: approvalBegan, to: approvalEnded });
              // Push the card's clock forward by the same wait. Without this a
              // command approved after thinking about it for a minute would
              // read "1m 4s" while running and then settle to "4s" — the same
              // call contradicting itself as it finishes.
              const waited = Math.max(0, approvalEnded - approvalBegan);
              if (waited > 0) {
                patchMessage(assistantId, (m) => {
                  const calls = (m.tool_calls ?? []).map((c) =>
                    c.id === tc.id && c.startedAt !== undefined
                      ? { ...c, startedAt: c.startedAt + waited }
                      : c,
                  );
                  const updated = calls.find((c) => c.id === tc.id);
                  // The timeline holds the copy the card renders, so patching
                  // `tool_calls` alone would move nothing on screen.
                  return {
                    ...m,
                    tool_calls: calls,
                    timeline: updated
                      ? upsertToolEvent(timelineOf(m), updated)
                      : timelineOf(m),
                  };
                });
              }
            }
          },
          // Something the runtime needs to say that the model did NOT say —
          // most importantly "this reply is cut off at the output limit".
          // Its own marker, never folded into the assistant's text.
          onRuntimeNotice: ({ message }) => {
            noticedMessages.add(message);
            flushStreamText();
            patchMessage(assistantId, (m) => ({
              ...m,
              // Retrying is over — either it worked and this notice is about
              // something else, or it ran out of attempts and THIS is the
              // explanation. Either way a spinner promising another try would
              // be a lie, so it goes.
              timeline: appendNotice(clearReconnect(timelineOf(m)), message),
            }));
          },
          onStreamAttemptStarted: () => {
            flushStreamText();
            // Store patches and timeline appenders replace their values; this
            // immutable snapshot also preserves text merged into an older row.
            patchMessage(assistantId, (m) => {
              streamAttemptCheckpoint = m;
              return m;
            });
          },
          // Restore only this attempt's output. The next flush replaces the
          // reconnect marker with the new response from its first token.
          onPartialReplyDiscarded: ({ attempt, maxAttempts }) => {
            dropPendingStreamText();
            patchMessage(assistantId, (m) => {
              const timeline = beginReconnect(
                timelineOf(m),
                nextEventId(),
                attempt,
                maxAttempts,
                streamAttemptCheckpoint ? timelineOf(streamAttemptCheckpoint) : undefined,
              );
              return {
                ...m,
                timeline,
                // Flat mirrors of the timeline, used by Copy and as the reload
                // fallback. They cannot be un-appended, so they are rebuilt
                // from what survived — otherwise the discarded text is gone
                // from the transcript but still in everything derived from it.
                content: textOf(timeline, "content"),
                thinking: textOf(timeline, "thinking"),
                // Drop abandoned tool IDs from the flat mirror too. Otherwise
                // timeline hydration can resurrect a discarded preview card.
                tool_calls: timeline.flatMap((event) =>
                  event.kind === "tool" ? [event.call] : [],
                ),
                isThinking: false,
              };
            });
            setActivity({ label: "Reconnecting…" });
          },
          onError: (error) => {
            const message =
              error instanceof Error ? error.message : String(error);
            if (/cancel|abort/i.test(message)) return; // user stop → not an error
            // Already shown as an inline notice (the runtime emits the event
            // first, then fails the turn with the same message). Re-appending
            // it as message prose would say it twice, in two different voices.
            if (noticedMessages.has(message)) return;
            const classified = classifyError(
              error instanceof Error ? error : new Error(message),
            );
            const note = `\n\n**${classified.title}**\n\n${classified.message}\n\n${classified.suggestion}`;
            flushStreamText();
            patchMessage(assistantId, (m) => ({
              ...m,
              content: `${m.content || ""}${note}`,
              timeline: appendContent(timelineOf(m), note),
            }));
          },
        },
        undefined,
        ideContext,
        {
          userMessage: contentForModel,
          // Only ever `"process"` for the idle background report — see
          // `SendOptions.origin`. Nothing else about the request changes with
          // it, so the turn appends to the cached prefix like any other.
          userMessageOrigin: options?.origin ?? "user",
          userMessageSummary: options?.summary ?? null,
          workspacePath: projectRoot ?? undefined,
          isFirstMessage: wasDraft,
          // `/`-attached skills → resolved into the system prompt as explicit,
          // authoritative skills for this turn (works for any skill, toggled on
          // or not).
          explicitSkillKeys:
            commandSelection.explicitSkillKeys.length > 0
              ? commandSelection.explicitSkillKeys
              : undefined,
          // Standing facts for the system prompt: the project's rules and,
          // in Team mode, the worker ceiling.
          projectRules: autoRulesBlock,
          teamPolicy: teamBlock,
          // Persist the inspector chips natively onto the user message in the
          // session JSONL so they re-render above the bubble on reopen.
          attachedSelectedElements: selectionPills.length > 0 ? selectionPills : null,
          attachedPromptChips: promptChips.length > 0 ? promptChips : null,
          // Set only when a terminal dispatched this turn (`aurora agent`).
          // Rust uses it to tee the turn's events into the task's transcript
          // so `--follow` watches the same work this window is rendering.
          cliTaskId: options?.cliTaskId ?? target?.cliTaskId ?? null,
        },
      );

      // Provider reported nothing this turn → estimate locally so the context
      // ring still reflects usage (flagged `~` in the UI). Skipped entirely when
      // a real `usage` event already landed. We also PERSIST the estimate so the
      // ring survives reopening the thread (the runtime only persists usage it
      // actually received from the provider).
      if (!usageFired) {
        const liveMsgs =
          useAgentChatStore.getState().liveTurns[threadId]?.messages ?? [];
        const contextWindow = providerConfig.contextWindow || 128_000;
        const estMaxOutput =
          providerConfig.defaultMaxTokens ??
          providerConfig.maxOutputTokens ??
          DEFAULT_MAX_OUTPUT_TOKENS;
        const est = await estimateTurnUsage(
          liveMsgs,
          providerConfig.model,
          contextWindow,
          estMaxOutput,
          agent.getLastPromptOverhead(),
        );
        if (est && !usageFired) {
          useAgentContextStore.getState().setUsage(threadId, est);
          // Persist the same four disjoint slices the live ContextRing sums.
          // Otherwise reopening the thread could replace the live reading with
          // a smaller snapshot that silently dropped output/cache-write tokens.
          const usedTokens =
            est.promptTokens +
            est.completionTokens +
            (est.cacheReadTokens ?? 0) +
            (est.cacheWriteTokens ?? 0);
          void threadService
            .updateUsage(threadId, est, {
              usedTokens,
              contextWindow,
              percentage: Math.min(100, Math.round((usedTokens / contextWindow) * 100)),
            })
            .catch(() => {
              /* best-effort persistence; the live ring already updated */
            });
        }
      }
      // Turn settled cleanly → offer tappable follow-up replies (async, never
      // blocks teardown; errored/cancelled turns skip this by construction).
      maybeSuggestReplies(threadId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!/cancel|abort/i.test(message)) {
        console.error("[agent-window] turn failed:", err);
      }
    } finally {
      const unresolvedApproval = approvalResolversRef.current.get(threadId);
      approvalResolversRef.current.delete(threadId);
      unresolvedApproval?.(false);
      setPendingApprovals((current) => {
        if (!(threadId in current)) return current;
        const next = { ...current };
        delete next[threadId];
        return next;
      });
      // Land any tail of buffered stream text, then close the reasoning phase.
      flushStreamText();
      // The transcript on disk just gained this turn's requests, so the stored
      // conversation total is out of date. Marked rather than re-read: a
      // background turn on a chat nobody is looking at should not pay for a
      // transcript parse. The card re-reads on its next open.
      //
      // In `finally` on purpose — a cancelled or failed turn still spent
      // tokens on every request it completed, and a total that quietly omits
      // them is exactly the kind of wrong this work exists to remove.
      useAgentContextStore.getState().invalidateBreakdown(threadId);
      // Re-stamp the assistant message to the moment the turn SETTLED. It was
      // seeded at send time because there was nothing to stamp yet, and
      // `buildTurns` reads the last assistant message's timestamp as the turn's
      // `endedAt` — so leaving the seed value makes every just-finished turn
      // measure ~0ms and the "Worked 4m" footer silently disappears. It only
      // came back after reopening the thread, because the runtime stamps the
      // PERSISTED message at end-of-stream. This mirrors that on the optimistic
      // message so the live view and the reloaded view agree.
      const settledAt = nowIso();
      patchMessage(assistantId, (m) => ({
        ...m,
        isThinking: false,
        timestamp: settledAt,
        // The turn has settled, so no further attempt is coming — and a live
        // "Connection lost — retrying (2 of 3)" spinner is now a promise
        // nothing will keep. It was only ever cleared by a recovered attempt
        // streaming text or a tool event, or by a runtime notice landing in
        // its place; a turn that ran out of attempts fails through `onError`,
        // which cleared nothing, and a turn cancelled mid-retry returned from
        // `onError` earlier still. Both left the spinner promising a fourth
        // try, above a composer that had correctly gone back to Send — the
        // transcript and the composer disagreeing about whether anything was
        // running. Clearing here covers every way a turn can end, rather than
        // one more path at a time.
        timeline: clearReconnect(timelineOf(m)),
      }));
      const s = useAgentChatStore.getState();
      const settledThread = s.liveTurns[threadId];
      runningAgents.delete(threadId);
      // Order matters: refresh the rail (which pulls THIS thread's now-persisted
      // row into `allThreads`) BEFORE closing the live turn. The rail dedupes a
      // live row against its persisted twin by thread id, so doing the disk
      // refresh first means the row is already present under its persisted form
      // when `endTurn` removes the live one — the chat never blinks out of the
      // rail during the hand-off. (The runtime persisted message #1 up front, so
      // a fresh chat is already listable here; this just swaps the live view for
      // the authoritative on-disk record.)
      //
      // We deliberately do NOT reload the open transcript from disk: the
      // optimistic messages already hold the full turn (thinking + tools +
      // content); a reload would swap every message for fresh ids → React
      // remounts the whole list (tool groups hard-collapse, view jumps up). Disk
      // stays authoritative on the NEXT open of this thread.
      await s.refreshThreads();
      // Close THIS thread's live turn (clears its rail spinner + drops the
      // global `sending` when no other turn remains).
      s.endTurn(threadId);
      // Completion cue: flash the header with this chat's title and — if the
      // turn finished in the background (another chat is open) — drop a "done"
      // dot on its rail row / project until the user opens it.
      s.noteTurnComplete(threadId);
      // The checklist is NOT settled here. Marking whatever the model left open
      // as "completed" invented completions the agent never reported — a task
      // it abandoned would show a tick. An item left in_progress by a finished
      // turn is *paused*, and the panel renders it that way (see
      // `AgentTaskPanel`), which is the truth and is recoverable: the next turn
      // picks the same list back up from disk.

      // Auto-flush a still-pending injection: if the turn ended before the
      // runtime hit a tool-result boundary to drain the queue, the message
      // would otherwise sit in the pill forever. Submit it as a fresh turn so
      // it's never silently lost (mirrors the IDE). Cleared first so it can't
      // double-fire; the Rust slot is also cleared (idempotent).
      const stillQueued = useAgentChatStore.getState().queuedByThread[threadId];
      if (stillQueued) {
        // Clear the Rust slot FIRST (awaited) so the fresh turn below can't
        // drain a stale copy and inject it twice, then resubmit as a new turn.
        // The MODEL copy is what resubmits — a steered message's directive
        // block must not evaporate because the turn ended before a tool
        // boundary; the chips ride along so the bubble renders its pills.
        useAgentChatStore.getState().clearQueuedMessage(threadId);
        await useAgentChatStore.getState().cancelQueuedMessage(threadId);
        if (settledThread) {
          void sendRef.current?.(
            stillQueued.modelText ?? stillQueued.text,
            {
              threadId,
              projectRoot,
              seed: settledThread,
            },
            stillQueued.chips,
          );
        }
      }
    }
  }, []);

  // Keep the ref pointing at the latest `send` so the post-turn auto-flush can
  // resubmit a queued injection without `send` depending on itself.
  sendRef.current = sendTurn;

  const send = useCallback(
    (text: string, fileChips?: AttachedPromptChip[], options?: SendOptions) => {
      // `options` rides alongside the target rather than inside it: a CLI
      // dispatch sends into the OPEN chat (it selects its thread first), so it
      // has no target to attach anything to.
      if (!bound) return sendTurn(text, undefined, fileChips, options);
      // A docked chat addresses its own thread explicitly. The seed is read
      // NOW (not at mount) so the live turn opens on the transcript actually on
      // screen; a live turn already in flight is the newer one, so it wins.
      const live = useAgentChatStore.getState().liveTurns[bound.threadId];
      const seed = live ?? bound.getSeed();
      if (!seed) return Promise.resolve();
      return sendTurn(
        text,
        {
          threadId: bound.threadId,
          projectRoot: bound.projectRoot,
          seed,
          interactive: true,
        },
        fileChips,
        options,
      );
    },
    [sendTurn, bound],
  );

  return {
    sending,
    send,
    compact,
    stop,
    pendingApproval,
    approve,
    approveAlways,
    reject,
  };
}
