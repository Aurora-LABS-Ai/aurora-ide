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
} from "../../services";
import { useSettingsStore } from "../../store/useSettingsStore";
import {
  DEFAULT_MAX_OUTPUT_TOKENS,
  resolveModelRequestKnobs,
  withProviderDefaults,
} from "../../services/model-request-config";
import { classifyError } from "../../lib/error-classifier";
import type {
  AttachedPromptChip,
  DbMessage,
  TokenUsage,
} from "../../services/thread-service";
import {
  BASE_AGENT_SYSTEM_PROMPT,
  formatSkillCatalogForContext,
  formatSkillReferences,
} from "../../services/agent-prompt";
import { getWorkspaceSkillToggles, resolveSkillsForPrompt } from "../../services/skills";
import {
  tokenService,
  stripImagePayloads,
  IMAGE_TOKEN_COST,
  type ChatMessageForCount,
} from "../../services/token-service";
import { runLocalTitle, runReplySuggestions } from "../adapters/prompt-refine";
import { resolveThreadModel } from "../lib/thread-model";
import {
  refinePathsConfigured,
  replySuggestionsReady,
  useAgentRefineStore,
} from "../store/useAgentRefineStore";
import { useAgentSuggestStore } from "../store/useAgentSuggestStore";
import { useAgentChatStore } from "../store/useAgentChatStore";
import { useAgentContextStore } from "../store/useAgentContextStore";
import {
  parseKillResult,
  parseSpawnResult,
  useAgentBackgroundStore,
} from "../store/useAgentBackgroundStore";
import {
  composerImages,
  composerKey,
  useAgentAttachmentStore,
} from "../store/useAgentAttachmentStore";
import {
  buildCommandSelection,
  composerCommands,
  useAgentCommandStore,
} from "../store/useAgentCommandStore";
import { loadProjectRules } from "../../services/context-builder";
import { appendImageMarkers } from "../lib/image-markers";
import {
  buildSelectionContext,
  buildSelectionPills,
  useAgentSelectionStore,
} from "../store/useAgentSelectionStore";
import {
  appendCompaction,
  appendContent,
  appendNotice,
  appendThinking,
  appendUserInjection,
  nextEventId,
  updateCompaction,
  upsertToolEvent,
  type TimelineEvent,
} from "../components/timeline";
import { describeToolActivity, type AgentActivity } from "../components/activity";
import { isDirectiveCommand } from "../adapters/prompt-commands";

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

export interface AgentWindowSend {
  /** True while a turn is streaming. */
  sending: boolean;
  /** Send (or resend) a turn. No-op on empty text or while already sending. */
  send: (text: string, fileChips?: AttachedPromptChip[]) => Promise<void>;
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
  const s = useSettingsStore.getState();
  if (s.titleMakerMode === "off" || !firstMessage.trim()) return;

  try {
    let title: string;
    if (s.titleMakerMode === "local") {
      const refine = useAgentRefineStore.getState();
      if (!refinePathsConfigured(refine)) return;
      title = await runLocalTitle(`title_${threadId}`, firstMessage, {
        llamaDir: refine.llamaDir,
        modelPath: refine.modelPath,
        device: refine.device,
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

  void runReplySuggestions(`suggest_${threadId}_${Date.now()}`, userText, text, {
    llamaDir: refine.llamaDir,
    modelPath: refine.modelPath,
    device: refine.device,
  })
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
  seed: import("../../services/thread-service").DbThread;
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
  getSeed: () => import("../../services/thread-service").DbThread | null;
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
    ((raw: string, target?: BackgroundSendTarget, fileChips?: AttachedPromptChip[]) => Promise<void>) | null
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
    if (tool) useSettingsStore.getState().setToolApproval(tool, "auto");
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

    const settings = useSettingsStore.getState();
    // Compaction is a real model call on this conversation's history, so it
    // rides the conversation's own model — not whichever one is selected now.
    const llmConfig = settings.getLLMConfigFor(resolveThreadModel(threadId));
    if (!llmConfig) return;

    // A docked chat compacts against ITS project, not the window's current
    // scope — the window may have been re-scoped since the tab was opened.
    const projectRoot = bound ? bound.projectRoot : store.projectRoot;
    const executionMode =
      settings.teamEnabled && settings.agentExecutionMode !== "plan"
        ? "team"
        : settings.agentExecutionMode;
    const markerId = genId();
    let markerStarted = false;

    store.beginTurn(threadId, seed, projectRoot);
    store.setThreadActivity(threadId, { label: "Compacting context…" });

    const agent = new AgentService();
    runningAgents.set(threadId, agent);
    agent.setProvider(withProviderDefaults(llmConfig));
    agent.setThreadId(threadId);
    agent.updateConfig({
      executionMode,
      workspacePath: projectRoot,
      maxTokens:
        llmConfig.defaultMaxTokens ?? llmConfig.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
      compactionThresholdPct: settings.compactionThresholdPct,
      compactionSummaryBudget: settings.compactionSummaryBudget,
      allowOutsideWorkspace: settings.allowOutsideWorkspace,
    });

    const completeMarker = (beforeTokens: number, afterTokens: number) => {
      if (!markerStarted) {
        markerStarted = true;
        store.appendTurnMessage(threadId, {
          id: markerId,
          role: "compaction",
          content: JSON.stringify({ beforeTokens, afterTokens, running: false }),
          timestamp: nowIso(),
        });
      } else {
        store.patchTurnMessage(threadId, markerId, (message) => ({
          ...message,
          content: JSON.stringify({ beforeTokens, afterTokens, running: false }),
        }));
      }
      useAgentContextStore.getState().setUsage(threadId, {
        promptTokens: afterTokens,
        completionTokens: 0,
        totalTokens: afterTokens,
        cacheReadTokens: 0,
        estimated: true,
      });
    };

    try {
      const result = await agent.compactThread({
        onCompactionStarted: () => {
          markerStarted = true;
          store.appendTurnMessage(threadId, {
            id: markerId,
            role: "compaction",
            content: JSON.stringify({
              beforeTokens: 0,
              afterTokens: 0,
              running: true,
            }),
            timestamp: nowIso(),
          });
        },
        onCompactionCompleted: completeMarker,
      });
      if (result && !markerStarted) {
        completeMarker(result.beforeTokens, result.afterTokens);
      }
    } catch (error) {
      console.error("[agent-window] manual compaction failed:", error);
    } finally {
      runningAgents.delete(threadId);
      await store.refreshThreads();
      store.endTurn(threadId);
    }
  }, [bound, targetThreadId]);

  const sendTurn = useCallback(async (
    raw: string,
    target?: BackgroundSendTarget,
    fileChips: AttachedPromptChip[] = [],
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
    // message, so the model sees it inline (parity with the IDE). We deliberately
    // do NOT consume staged attachments / selection / `/` commands here — those
    // belong to a fresh turn, not a quick mid-flight note.
    if (fromComposer) {
      const chat = useAgentChatStore.getState();
      const liveThreadId = target?.threadId ?? chat.currentThreadId;
      if (liveThreadId && chat.liveTurns[liveThreadId]) {
        void chat.enqueueMessage(liveThreadId, content);
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

    const settings = useSettingsStore.getState();

    // Execution mode for this turn. The agent window has NO separate "Lead" and
    // no mode toggle — the chat model in the selector IS the Lead. So enabling
    // Team in Settings is the whole opt-in: the model runs in Team mode (which is
    // what exposes the `team_*` tools + the Lead guidance so it can actually
    // dispatch a team), except in read-only Plan mode where mutations are off.
    const executionMode =
      settings.teamEnabled && settings.agentExecutionMode !== "plan"
        ? "team"
        : settings.agentExecutionMode;

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
    const modelSelection = resolveThreadModel(threadId);
    const llmConfig = settings.getLLMConfigFor(modelSelection);

    // Capture the project for THIS turn now — the user may navigate to another
    // project while it runs, and tools must stay rooted at the originating one.
    const projectRoot = target?.projectRoot ?? store.projectRoot;

    // Open a LIVE turn keyed to this thread. Streaming targets `liveTurns[id]`,
    // so navigating away mid-turn doesn't drop the in-flight work — it keeps
    // running and re-attaches when the user opens this chat again.
    store.beginTurn(threadId, target?.seed, projectRoot);

    // The checklist is NOT cleared here. Rust owns it and it is durable per
    // thread, so a multi-turn task list must survive into the next turn — the
    // agent is still working through it, and `todo_write` replaces it when a
    // genuinely new list starts.

    // Optimistic user bubble — the runtime re-persists this verbatim, so the
    // reload at the end reconciles it to the authoritative id.
    store.appendTurnMessage(threadId, {
      id: genId(),
      role: "user",
      content: contentForModel,
      attachedSelectedElements: selectionPills.length > 0 ? selectionPills : undefined,
      attachedCommands: commandChips.length > 0 ? commandChips : undefined,
      attachedPromptChips: promptChips.length > 0 ? promptChips : undefined,
      timestamp: nowIso(),
    });

    // AI title maker — ONLY for the first message of a NEW chat (never existing
    // threads). Fire-and-forget so it never blocks the turn; on success it
    // replaces the derived title in meta + UI, on any error the derived title
    // stands. Disabled or unconfigured → skipped entirely (no-op).
    if (wasDraft) {
      void maybeGenerateTitle(threadId, content);
    }

    if (!llmConfig) {
      store.appendTurnMessage(threadId, {
        id: genId(),
        role: "assistant",
        content:
          "No model is configured. Add a provider and API key in the IDE's Settings, then try again.",
        timestamp: nowIso(),
      });
      store.endTurn(threadId);
      return;
    }

    // The streaming assistant target.
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
        let timeline = timelineOf(m);
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

    const upsertToolCall = (tc: ToolCallRequest, result?: string | null) => {
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
          timeline: upsertToolEvent(timelineOf(m), next),
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

    const providerConfig = withProviderDefaults(llmConfig);

    // Minimal, authoritative context: the runtime roots tools at this path; the
    // model just needs to KNOW the path so it can reason about / explore it.
    const baseContext = projectRoot
      ? `<workspace_root>${projectRoot}</workspace_root>\nYou are working inside this project directory. Use your tools (workspace_tree, file_read, grep, …) to explore and edit files here.${
          settings.allowOutsideWorkspace
            ? "\nThe user has ALLOWED reading files outside this workspace: when given an absolute path elsewhere on disk, read it with file_read (pass a `paths` array to read several at once) instead of refusing. Edits and new files still stay inside the workspace."
            : ""
        }`
      : null;

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

    // Standing `.aurora/*.md` project rules ride automatically on the FIRST
    // message of a chat (IDE parity) — capped, with `/`-attached rules
    // excluded since they already ride verbatim above.
    const autoRulesBlock = wasDraft
      ? await buildAutoRulesContext(projectRoot, commandSelection.ruleFilenames)
      : null;

    // Skills: the agent window runtime composes the system prompt but does NOT
    // inject the equipped-skill catalog (`composeAgentSystemPrompt` resolves the
    // skills then discards them). So we surface them here, exactly like the IDE's
    // `useAgentSend` — without this, equipping a skill on the Skills page is a
    // no-op and the agent only ever sees its 6 built-ins. The catalog (id +
    // description + 5-line preview, capped at 10) rides on EVERY turn so toggling
    // a skill mid-conversation takes effect immediately; `/`-attached skills ride
    // as authoritative `required_skills`.
    let skillCatalogBlock: string | null = null;
    let skillReferencesBlock: string | null = null;
    if (settings.skillsEnabled || commandSelection.explicitSkillKeys.length > 0) {
      try {
        const resolvedSkills = await resolveSkillsForPrompt({
          enabledSkillToggles: getWorkspaceSkillToggles(
            settings.skillToggles,
            projectRoot,
          ),
          explicitSkillKeys:
            commandSelection.explicitSkillKeys.length > 0
              ? commandSelection.explicitSkillKeys
              : undefined,
          skillsEnabled: settings.skillsEnabled,
          userMessage: contentForModel,
          workspacePath: projectRoot ?? undefined,
        });
        if (resolvedSkills.enabledSkills.length > 0) {
          skillCatalogBlock = formatSkillCatalogForContext({
            enabledSkills: resolvedSkills.enabledSkills,
            totalSkillCount: resolvedSkills.allSkills.length,
          });
        }
        if (resolvedSkills.explicitSkills.length > 0) {
          skillReferencesBlock = formatSkillReferences(
            resolvedSkills.explicitSkills,
            "required_skills",
          );
        }
      } catch (err) {
        console.warn("[agent-window] skill resolution failed:", err);
      }
    }

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

    const ideContext =
      [
        baseContext,
        autoRulesBlock,
        selectionBlock,
        ruleBlock,
        mcpBlock,
        skillCatalogBlock,
        skillReferencesBlock,
        teamBlock,
      ]
        .filter(Boolean)
        .join("\n\n") || null;

    // Per-model reasoning: the active model may carry a reasoning level (set in
    // Provider settings / the composer picker). Effort tiers are forwarded as
    // `reasoning_effort`; a toggle model drives whether thinking is on at all;
    // a budget model additionally carries the token budget the user chose.
    // THIS turn's model row, not the globally-active one: reasoning config
    // (effort tier / thinking budget) hangs off the model, so reading the
    // active row would apply another conversation's reasoning settings here.
    const activeModel = useSettingsStore.getState().getModelFor(modelSelection);
    // Shared with the provider settings connection test so a "working"
    // test and a working turn can never mean different things.
    const { thinkingEnabled, thinkingBudgetTokens } = resolveModelRequestKnobs(
      providerConfig,
      activeModel,
      settings.thinkingEnabled,
    );

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
      thinkingEnabled,
      thinkingBudgetTokens,
      executionMode,
      autoApproveTools: settings.autoApproveTools,
      // Pin tools to THIS turn's project (not the global store) so a turn keeps
      // operating on its own directory even after the user switches projects.
      workspacePath: projectRoot,
      temperature: llmConfig.defaultTemperature ?? 1.0,
      maxTokens:
        llmConfig.defaultMaxTokens ?? llmConfig.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
      // Agentic by design: no artificial tool-call cap — the runtime stops when
      // the model stops requesting tools.
      maxToolIterations: undefined,
      getToolApproval: settings.getToolApproval,
      // Context compaction (Settings → Agent). The runtime summarizes older
      // history into a persistent marker once the projected request crosses
      // the threshold; the summary budget caps the summarization call.
      compactionThresholdPct: settings.compactionThresholdPct,
      compactionSummaryBudget: settings.compactionSummaryBudget,
      allowOutsideWorkspace: settings.allowOutsideWorkspace,
      // Read once, here, for BOTH the tool roster and the prompt instruction —
      // this config field is what `AgentService` hands to
      // `composeAgentSystemPrompt` AND what the runtime client forwards to Rust,
      // so a turn can never have the tool without the instruction or vice versa.
      transcriptChapters: settings.transcriptChapters,
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
            useAgentContextStore.getState().setUsage(threadId, usage);
          },
          onQueuedMessageInjected: (text) => {
            // The runtime drained the queue and stapled the user's text onto the
            // tool message it's about to send. Render it inline in the streaming
            // assistant message — after the tool result, before the agent
            // continues — so the order matches what the model saw. No separate
            // user bubble (that would land after the streaming message and read
            // as if the agent replied before the user spoke). Then drop the pill.
            flushStreamText();
            patchMessage(assistantId, (m) => ({
              ...m,
              timeline: appendUserInjection(timelineOf(m), text),
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
            if (compactionEventId) {
              const id = compactionEventId;
              patchMessage(assistantId, (m) => ({
                ...m,
                timeline: updateCompaction(timelineOf(m), id, beforeTokens, afterTokens),
              }));
              compactionEventId = null;
            }
            // Drop the ring immediately to the post-compaction size; the next
            // real usage event refines it. Flagged estimated (our number).
            useAgentContextStore.getState().setUsage(threadId, {
              promptTokens: afterTokens,
              completionTokens: 0,
              totalTokens: afterTokens,
              cacheReadTokens: 0,
              estimated: true,
            });
          },
          onToolCall: (tc) => {
            setActivity(describeToolActivity(tc.function.name, tc.function.arguments || ""));
            upsertToolCall(tc);
          },
          onToolExecutionStart: (tc) => {
            markToolStart(tc.id);
            setActivity(describeToolActivity(tc.function.name, tc.function.arguments || ""));
            upsertToolCall(tc);
          },
          onToolExecutionComplete: (tc, result) => {
            captureBackgroundProcess(tc, result);
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
              toolTimings
                .get(tc.id)
                ?.approval.push({ from: approvalBegan, to: performance.now() });
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
              timeline: appendNotice(timelineOf(m), message),
            }));
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
          workspacePath: projectRoot ?? undefined,
          isFirstMessage: wasDraft,
          // `/`-attached skills → resolved into the system prompt as explicit,
          // authoritative skills for this turn (works for any skill, toggled on
          // or not).
          explicitSkillKeys:
            commandSelection.explicitSkillKeys.length > 0
              ? commandSelection.explicitSkillKeys
              : undefined,
          // Persist the inspector chips natively onto the user message in the
          // session JSONL so they re-render above the bubble on reopen.
          attachedSelectedElements: selectionPills.length > 0 ? selectionPills : null,
          attachedPromptChips: promptChips.length > 0 ? promptChips : null,
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
        const contextWindow = llmConfig.contextWindow || 128_000;
        const estMaxOutput =
          llmConfig.defaultMaxTokens ?? llmConfig.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
        const est = await estimateTurnUsage(
          liveMsgs,
          llmConfig.model,
          contextWindow,
          estMaxOutput,
          agent.getLastPromptOverhead(),
        );
        if (est && !usageFired) {
          useAgentContextStore.getState().setUsage(threadId, est);
          const usedTokens = est.promptTokens + (est.cacheReadTokens ?? 0);
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
      // Re-stamp the assistant message to the moment the turn SETTLED. It was
      // seeded at send time because there was nothing to stamp yet, and
      // `buildTurns` reads the last assistant message's timestamp as the turn's
      // `endedAt` — so leaving the seed value makes every just-finished turn
      // measure ~0ms and the "Worked 4m" footer silently disappears. It only
      // came back after reopening the thread, because the runtime stamps the
      // PERSISTED message at end-of-stream. This mirrors that on the optimistic
      // message so the live view and the reloaded view agree.
      const settledAt = nowIso();
      patchMessage(assistantId, (m) => ({ ...m, isThinking: false, timestamp: settledAt }));
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
        useAgentChatStore.getState().clearQueuedMessage(threadId);
        await useAgentChatStore.getState().cancelQueuedMessage(threadId);
        if (settledThread) {
          void sendRef.current?.(stillQueued.text, {
            threadId,
            projectRoot,
            seed: settledThread,
          });
        }
      }
    }
  }, []);

  // Keep the ref pointing at the latest `send` so the post-turn auto-flush can
  // resubmit a queued injection without `send` depending on itself.
  sendRef.current = sendTurn;

  const send = useCallback(
    (text: string, fileChips?: AttachedPromptChip[]) => {
      if (!bound) return sendTurn(text, undefined, fileChips);
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
