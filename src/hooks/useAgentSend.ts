/**
 * useAgentSend — single source of truth for the chat composer's
 * "send a turn to the agent" pipeline.
 *
 * The same ~500-line `handleSend` once lived in multiple in-IDE chat
 * surfaces; maintaining near-identical copies caused drift bugs (lost
 * skill-catalog injection, the `isFirstMessage` flag, the cross-window
 * stream broadcast). This hook unifies that lifecycle so the IDE chat
 * pipeline lives in exactly one place.
 *
 * The hook owns:
 *  - the streaming message id ref (so the timeline event stream lands
 *    on the right assistant message even if React re-renders),
 *  - the timeline ref + RAF-batched flush (smooth 60fps streaming),
 *  - the per-turn approval/queue/abort plumbing,
 *  - the audit-store bridging,
 *  - the cross-window broadcast (`chatSyncBroadcast.broadcastStreamUpdate`).
 *
 * `ChatPanel` consumes the handlers returned here (the standalone Agent
 * Window has its own `useAgentWindowSend`). The hook intentionally avoids
 * JSX so it can be unit-tested in isolation.
 */

import { useCallback, useEffect, useRef } from "react";

import { classifyError } from "../lib/error-classifier";
import { parseToolArguments, parseToolArgumentsForDisplay } from "../lib/tool-arguments";
import { liveFilePreviewService } from "../services/live-file-preview";
import { getAgentService, type ProviderConfig, type ToolCallRequest } from "../services";
import {
  type AgentPromptContext,
  formatSkillCatalogForContext,
  formatSkillReferences,
} from "../services/agent-prompt";
import {
  filterProjectRulesByAttachment,
  getPromptAttachmentSelection,
  type PromptAttachment,
} from "../services/prompt-assets";
import {
  buildAttachedContextBlock,
  buildQueryContext,
  getIDEContext,
  getIDEContextLight,
  loadProjectRules,
} from "../services/context-builder";
import { getWorkspaceSkillToggles } from "../services/skills";
import { tokenService, stripImagePayloads, IMAGE_TOKEN_COST } from "../services/token-service";
import { getProfessionalToolName } from "../services/tool-display";
import { toolRegistry } from "../tools";
import { chatSyncBroadcast } from "./useRustChatSync";
import { useAuditStore } from "../store/useAuditStore";
import { useChatStore } from "../store/useChatStore";
import { useCheckpointStore } from "../store/useCheckpointStore";
import { useContextStore } from "../store/useContextStore";
import { useSettingsStore } from "../store/useSettingsStore";
import { useTaskStore } from "../store/useTaskStore";
import { setStreamingState, useThreadStore } from "../store/useThreadStore";
import { useWorkspaceStore } from "../store/useWorkspaceStore";
import type {
  Message,
  TimelineEvent,
  ToolCall,
  ToolProposal,
} from "../types";
import type { SelectedElementEntry } from "../store/useChatStore";

export interface AttachedFile {
  path: string;
  name: string;
}

interface PendingToolCallState {
  resolve: ((approved: boolean) => void) | null;
  toolCall: ToolCallRequest;
}

export interface UseAgentSendApi {
  handleSend: (
    content: string,
    attachedFiles?: AttachedFile[],
    promptAttachments?: PromptAttachment[],
    selectedElements?: SelectedElementEntry[],
  ) => Promise<void>;
  handleApprove: () => void;
  handleApproveRemember: () => void;
  handleReject: () => void;
}

const generateId = (): string => Math.random().toString(36).substr(2, 9);

export function useAgentSend(): UseAgentSendApi {
  const currentMessageIdRef = useRef<string | null>(null);
  const pendingToolCallRef = useRef<PendingToolCallState | null>(null);
  const timelineRef = useRef<TimelineEvent[]>([]);
  const pendingRAF = useRef<number | null>(null);

  const setLoading = useChatStore((s) => s.setLoading);
  const isLoading = useChatStore((s) => s.isLoading);
  const pendingApproval = useChatStore((s) => s.pendingApproval);
  const setPendingApproval = useChatStore((s) => s.setPendingApproval);

  const addMessageToThread = useThreadStore((s) => s.addMessageToThread);
  const updateMessageInThread = useThreadStore((s) => s.updateMessageInThread);
  const updateThreadUsage = useThreadStore((s) => s.updateThreadUsage);

  const flushTimelineUpdate = useCallback(() => {
    if (pendingRAF.current) {
      cancelAnimationFrame(pendingRAF.current);
      pendingRAF.current = null;
    }
    if (!currentMessageIdRef.current) return;
    updateMessageInThread(currentMessageIdRef.current, {
      timeline: [...timelineRef.current],
    });
    chatSyncBroadcast.broadcastStreamUpdate(
      currentMessageIdRef.current,
      timelineRef.current,
    );
  }, [updateMessageInThread]);

  const addTimelineEvent = useCallback(
    (event: Omit<TimelineEvent, "id" | "timestamp">): string => {
      const newEvent: TimelineEvent = {
        ...event,
        id: generateId(),
        timestamp: Date.now(),
      };
      timelineRef.current = [...timelineRef.current, newEvent];

      if (currentMessageIdRef.current) {
        updateMessageInThread(currentMessageIdRef.current, {
          timeline: [...timelineRef.current],
        });
      }
      return newEvent.id;
    },
    [updateMessageInThread],
  );

  const updateTimelineEvent = useCallback(
    (eventId: string, updates: Partial<TimelineEvent>, immediate = false) => {
      timelineRef.current = timelineRef.current.map((e) =>
        e.id === eventId ? { ...e, ...updates } : e,
      );

      if (immediate) {
        flushTimelineUpdate();
        return;
      }

      if (!pendingRAF.current) {
        pendingRAF.current = requestAnimationFrame(() => {
          pendingRAF.current = null;
          if (!currentMessageIdRef.current) return;
          updateMessageInThread(currentMessageIdRef.current, {
            timeline: [...timelineRef.current],
          });
          chatSyncBroadcast.broadcastStreamUpdate(
            currentMessageIdRef.current,
            timelineRef.current,
          );
        });
      }
    },
    [flushTimelineUpdate, updateMessageInThread],
  );

  const handleSend = useCallback(
    async (
      content: string,
      attachedFiles?: AttachedFile[],
      promptAttachments?: PromptAttachment[],
      selectedElements?: SelectedElementEntry[],
    ) => {
      // Fresh per-turn timeline.
      timelineRef.current = [];

      // Resolve the settings the agent needs once — keeps the in-flight
      // turn coherent even if the user toggles the model selector
      // between click and chat() resolution.
      const settings = useSettingsStore.getState();
      const llmConfig = settings.getLLMConfig();
      const autoApproveTools = settings.autoApproveTools;
      // The Agent Team runs only in the Agent Window now — the in-IDE chat is
      // Agent/Plan only. Clamp any stale persisted "team" so the IDE never
      // exposes team-control tools or the Lead prompt.
      const agentExecutionMode =
        settings.agentExecutionMode === "team"
          ? "agent"
          : settings.agentExecutionMode;
      const getToolApproval = settings.getToolApproval;
      const userThinkingEnabled = settings.thinkingEnabled;
      const thinkingEnabled =
        userThinkingEnabled && (llmConfig?.supportsThinking ?? false);
      const temperature = llmConfig?.defaultTemperature ?? 1.0;
      const maxTokens =
        llmConfig?.defaultMaxTokens ?? llmConfig?.maxOutputTokens ?? 8192;

      // Thread bootstrap — create or rehydrate.
      const threadStore = useThreadStore.getState();
      let threadId = threadStore.currentThreadId;
      const threadExists = threadId && threadStore.threads[threadId];
      let isNewThread = false;

      if (!threadId || !threadExists) {
        useTaskStore.getState().clearTasks();
        threadId = threadStore.createThread();
        isNewThread = true;
      }

      const currentThread = threadId
        ? useThreadStore.getState().threads[threadId]
        : null;

      // Build the user-facing message bubble FIRST so the UI updates
      // immediately, regardless of how slow the IDE-context build is.
      const userMessage: Message = {
        id: generateId(),
        sender: "user",
        content,
        timestamp: Date.now(),
        attachedFiles: attachedFiles?.map((f) => ({ path: f.path, name: f.name })),
        attachedPromptAssets: promptAttachments?.map((a) => ({
          key: a.key,
          type: a.type,
          title: a.title,
        })),
        attachedSelectedElements: selectedElements?.map((entry) => ({
          index: entry.index,
          selector: entry.element.selector,
          tagName: entry.element.tagName,
          url: entry.element.url,
          text: entry.element.text,
          source: entry.element.source,
          note: entry.element.note,
        })),
      };
      addMessageToThread(userMessage);

      const rootPath = useWorkspaceStore.getState().rootPath;

      const checkpointReady =
        rootPath && threadId
          ? useCheckpointStore
              .getState()
              .createCheckpoint(userMessage.id, threadId)
          : Promise.resolve(true);

      // First-message context is heavier (skills catalog, project
      // layout, project rules); follow-ups only ship open files +
      // user_query so the per-turn payload stays small.
      const isFirstMessage =
        isNewThread ||
        !currentThread?.messages ||
        // The user message we just added IS the only message in the
        // thread when this is the first turn of a rehydrated thread —
        // count <= 1 so we still treat it as the first turn.
        currentThread.messages.length <= 1;

      const projectLayoutEnabled = settings.projectLayoutEnabled;
      const shouldIncludeLayout = isFirstMessage && projectLayoutEnabled;
      const ideContextBase = shouldIncludeLayout
        ? getIDEContext(true)
        : getIDEContextLight();

      const promptSelection = getPromptAttachmentSelection(promptAttachments ?? []);
      const selectedRules =
        rootPath && promptSelection.ruleFilenames.length > 0
          ? filterProjectRulesByAttachment(
              await loadProjectRules(rootPath),
              promptAttachments ?? [],
            )
          : undefined;

      const attachedContextBlock = buildAttachedContextBlock(
        promptAttachments?.map((a) => ({ type: a.type, title: a.title, key: a.key })),
      );

      // Skills resolution — `skillCatalog` is the first-message-only
      // catalog of all enabled skills; `skillReferences` is the
      // shortlist of skills the user explicitly attached this turn.
      let skillCatalog: string | undefined;
      let skillReferences: string | undefined;

      if (settings.skillsEnabled) {
        const { resolveSkillsForPrompt: resolveSkills } = await import(
          "../services/skills"
        );
        const resolved = await resolveSkills({
          enabledSkillToggles: getWorkspaceSkillToggles(
            settings.skillToggles,
            rootPath,
          ),
          explicitSkillKeys: promptSelection.explicitSkillKeys,
          skillsEnabled: settings.skillsEnabled,
          userMessage: content,
          workspacePath: rootPath || undefined,
        });

        if (isFirstMessage) {
          skillCatalog = formatSkillCatalogForContext({
            enabledSkills: resolved.enabledSkills,
            totalSkillCount: resolved.allSkills.length,
          });
        }

        if (resolved.explicitSkills.length > 0) {
          skillReferences = formatSkillReferences(
            resolved.explicitSkills,
            "required_skills",
          );
        }
      }

      const { ideContext: bareIdeContext } = await buildQueryContext(
        content,
        attachedFiles,
        {
          ...ideContextBase,
          projectRules: selectedRules,
          skillCatalog,
          skillReferences,
          selectedElements: selectedElements?.map((entry) => entry.element),
        },
      );

      // Compose the enrichment that travels in the `ideContext` sidecar.
      const composedIdeContext: string | null = (() => {
        const parts: string[] = [];
        if (bareIdeContext) parts.push(bareIdeContext);
        if (attachedContextBlock) parts.push(attachedContextBlock);
        return parts.length > 0 ? parts.join("\n\n") : null;
      })();

      const promptContext: AgentPromptContext = {
        explicitSkillKeys: promptSelection.explicitSkillKeys,
        isFirstMessage,
        userMessage: content,
        workspacePath: rootPath || undefined,
      };

      // No provider → bail out with a friendly assistant message.
      if (!llmConfig) {
        const errorMessage: Message = {
          id: generateId(),
          sender: "assistant",
          content:
            "No models configured. Please add an API key for at least one provider in Settings.",
          timestamp: Date.now(),
        };
        addMessageToThread(errorMessage);
        return;
      }

      setLoading(true);
      chatSyncBroadcast.setLoading(true);
      setStreamingState(true);

      const providerConfig: ProviderConfig = {
        id: llmConfig.id,
        name: llmConfig.name,
        providerType:
          (llmConfig.providerType as ProviderConfig["providerType"]) || "custom",
        baseUrl: llmConfig.baseUrl,
        apiKey: llmConfig.apiKey,
        model: llmConfig.model,
        contextWindow: llmConfig.contextWindow || 128000,
        maxOutputTokens: llmConfig.maxOutputTokens || 8192,
        supportsThinking: llmConfig.supportsThinking ?? false,
        supportsToolStream: llmConfig.supportsToolStream ?? false,
        supportsVision: llmConfig.supportsVision ?? false,
        defaultTemperature: llmConfig.defaultTemperature,
        defaultMaxTokens: llmConfig.defaultMaxTokens,
        customHeaders: llmConfig.customHeaders,
        customParams: llmConfig.customParams,
      };

      const agent = getAgentService();
      agent.setProvider(providerConfig);
      agent.setThreadId(threadId!);

      const contextStore = useContextStore.getState();
      contextStore.setContextWindow(
        providerConfig.contextWindow,
        providerConfig.maxOutputTokens,
      );

      const assistantMessageId = generateId();
      currentMessageIdRef.current = assistantMessageId;

      const assistantMessage: Message = {
        id: assistantMessageId,
        sender: "assistant",
        content: "",
        timestamp: Date.now(),
        timeline: [],
      };
      addMessageToThread(assistantMessage);

      let currentThinkingEventId: string | null = null;
      let currentContentEventId: string | null = null;
      let usageReceivedFromAPI = false;

      const auditStore = useAuditStore.getState();
      const auditEntryIds = new Map<string, string>();

      try {
        agent.updateConfig({
          thinkingEnabled,
          executionMode: agentExecutionMode,
          autoApproveTools,
          beforeToolExecution: async () => {
            await checkpointReady;
          },
          temperature,
          maxTokens,
          maxToolIterations: undefined,
          getToolApproval,
        });

        await agent.chat(
          content,
          {
            onQueuedMessageInjected: (injectedText) => {
              if (currentThinkingEventId) {
                updateTimelineEvent(currentThinkingEventId, {
                  isThinking: false,
                });
                currentThinkingEventId = null;
              }
              currentContentEventId = null;
              addTimelineEvent({
                type: "user_injection",
                userInjection: injectedText,
              });
            },
            onToken: (token) => {
              if (currentThinkingEventId) {
                updateTimelineEvent(currentThinkingEventId, {
                  isThinking: false,
                });
                currentThinkingEventId = null;
              }

              if (!currentContentEventId) {
                currentContentEventId = addTimelineEvent({
                  type: "content",
                  content: token,
                });
              } else {
                const existing = timelineRef.current.find(
                  (e) => e.id === currentContentEventId,
                );
                if (existing) {
                  updateTimelineEvent(currentContentEventId, {
                    content: (existing.content || "") + token,
                  });
                }
              }
            },
            onThinking: (thinking) => {
              if (!currentThinkingEventId) {
                currentThinkingEventId = addTimelineEvent({
                  type: "thinking",
                  thinking,
                  isThinking: true,
                });
              } else {
                const existing = timelineRef.current.find(
                  (e) => e.id === currentThinkingEventId,
                );
                if (existing) {
                  updateTimelineEvent(currentThinkingEventId, {
                    thinking: (existing.thinking || "") + thinking,
                  });
                }
              }
            },
            onToolCall: (toolCall) => {
              if (currentThinkingEventId) {
                updateTimelineEvent(currentThinkingEventId, {
                  isThinking: false,
                });
                currentThinkingEventId = null;
              }
              currentContentEventId = null;

              const existing = timelineRef.current.find(
                (e) => e.type === "tool" && e.tool?.id === toolCall.id,
              );

              if (!existing) {
                const newToolCall: ToolCall = {
                  id: toolCall.id,
                  name: toolCall.function.name,
                  status: "pending",
                  args: parseToolArgumentsForDisplay(
                    toolCall.function.arguments,
                  ),
                };
                addTimelineEvent({ type: "tool", tool: newToolCall });
              } else {
                const rawArgs = toolCall.function.arguments || "";
                let parsedArgs = existing.tool!.args || {};
                const parseResult = parseToolArguments(rawArgs);
                if (parseResult.status !== "invalid") {
                  parsedArgs = parseResult.args;
                }
                updateTimelineEvent(existing.id, {
                  tool: {
                    ...existing.tool!,
                    args: parsedArgs,
                    rawArgs,
                  },
                });
              }

              liveFilePreviewService.updateFromToolCall(toolCall);
            },
            onToolApprovalRequired: async (toolCall) => {
              const toolName = toolCall.function.name;
              const setting = getToolApproval(toolName);
              if (setting === "auto") return true;
              if (setting === "deny") return false;

              const proposal: ToolProposal = {
                id: toolCall.id,
                toolName,
                description: `Execute ${getProfessionalToolName(toolName)}`,
                riskLevel:
                  toolName.startsWith("shell_") || toolName.includes("delete")
                    ? "high"
                    : "medium",
                status: "pending",
                parameters: parseToolArgumentsForDisplay(
                  toolCall.function.arguments,
                ),
              };

              const pending: PendingToolCallState = { toolCall, resolve: null };
              pendingToolCallRef.current = pending;
              return new Promise<boolean>((resolve) => {
                pending.resolve = resolve;
                setPendingApproval(proposal);
              });
            },
            onToolExecutionStart: (toolCall) => {
              const toolName = toolCall.function.name;
              const parsedArgs = parseToolArgumentsForDisplay(
                toolCall.function.arguments,
              );
              liveFilePreviewService.markApplying(toolCall.id);

              const riskLevel = toolRegistry.getRiskLevel(toolName);
              const auditId = auditStore.addEntry({
                toolName,
                args: parsedArgs,
                status: "executing",
                riskLevel,
                threadId: threadId || undefined,
              });
              auditEntryIds.set(toolCall.id, auditId);

              const toolEvent = timelineRef.current.find(
                (e) => e.type === "tool" && e.tool?.id === toolCall.id,
              );
              if (toolEvent) {
                // Ride the RAF batch instead of forcing a synchronous
                // flush. An immediate flush re-renders the whole streaming
                // message on the main thread for every tool that starts —
                // which, interleaved with token streaming, is a big source
                // of the frame drops during agent runs.
                updateTimelineEvent(toolEvent.id, {
                  tool: { ...toolEvent.tool!, status: "executing" },
                });
              }
            },
            onToolExecutionComplete: (toolCall, result) => {
              liveFilePreviewService.complete(toolCall.id);

              const auditId = auditEntryIds.get(toolCall.id);
              if (auditId) {
                const entry = auditStore.entries.find((e) => e.id === auditId);
                const duration = entry ? Date.now() - entry.timestamp : undefined;
                auditStore.updateEntry(auditId, {
                  status: "executed",
                  result: result.substring(0, 500),
                  duration,
                });
              }

              const toolEvent = timelineRef.current.find(
                (e) => e.type === "tool" && e.tool?.id === toolCall.id,
              );
              if (toolEvent) {
                // Batched (no immediate flush): a large terminal dump or
                // file_read result used to force a synchronous re-render +
                // result-view layout on the main thread the instant the
                // tool finished, freezing the whole app. The RAF batch
                // coalesces it, and the unconditional flush at turn end
                // guarantees the final state still lands.
                updateTimelineEvent(toolEvent.id, {
                  tool: { ...toolEvent.tool!, status: "complete", result },
                });
              }
            },
            onToolExecutionError: (toolCall, error) => {
              liveFilePreviewService.fail(toolCall.id);

              const auditId = auditEntryIds.get(toolCall.id);
              if (auditId) {
                const entry = auditStore.entries.find((e) => e.id === auditId);
                const duration = entry ? Date.now() - entry.timestamp : undefined;
                auditStore.updateEntry(auditId, {
                  status: "failed",
                  result: error.substring(0, 500),
                  duration,
                });
              }

              const toolEvent = timelineRef.current.find(
                (e) => e.type === "tool" && e.tool?.id === toolCall.id,
              );
              if (toolEvent) {
                updateTimelineEvent(
                  toolEvent.id,
                  { tool: { ...toolEvent.tool!, status: "failed", error } },
                  true,
                );
              }
            },
            onToolRejected: (toolCall, reason) => {
              liveFilePreviewService.fail(toolCall.id);

              const toolEvent = timelineRef.current.find(
                (e) => e.type === "tool" && e.tool?.id === toolCall.id,
              );
              if (toolEvent) {
                updateTimelineEvent(
                  toolEvent.id,
                  {
                    tool: {
                      ...toolEvent.tool!,
                      status: "rejected",
                      result: reason,
                    },
                  },
                  true,
                );
              }
            },
            onUsage: (usage) => {
              usageReceivedFromAPI = true;
              const ctx = useContextStore.getState();
              ctx.updateUsage({
                promptTokens: usage.promptTokens,
                completionTokens: usage.completionTokens,
                totalTokens: usage.totalTokens,
                cacheReadTokens: usage.cacheReadTokens,
                cacheWriteTokens: usage.cacheWriteTokens,
              });
              const next = useContextStore.getState();
              updateThreadUsage(
                {
                  promptTokens: usage.promptTokens,
                  completionTokens: usage.completionTokens,
                  totalTokens: usage.totalTokens,
                  cacheReadTokens: usage.cacheReadTokens,
                  cacheWriteTokens: usage.cacheWriteTokens,
                },
                {
                  usedTokens: next.usedContextTokens,
                  contextWindow: next.contextWindow,
                  percentage: next.usagePercentage,
                },
              );
            },
            onComplete: (finalMessage) => {
              const hasContentEvent = timelineRef.current.some(
                (e) => e.type === "content" && e.content,
              );
              const hasToolCalls = timelineRef.current.some(
                (e) => e.type === "tool",
              );

              if (currentThinkingEventId) {
                updateTimelineEvent(currentThinkingEventId, {
                  isThinking: false,
                });
                currentThinkingEventId = null;
              }

              if (finalMessage?.content && !hasContentEvent) {
                const contentStr =
                  typeof finalMessage.content === "string"
                    ? finalMessage.content
                    : Array.isArray(finalMessage.content)
                      ? finalMessage.content
                          .map((block) =>
                            typeof block === "object" &&
                            block !== null &&
                            "text" in block &&
                            typeof (block as { text?: unknown }).text === "string"
                              ? (block as { text: string }).text
                              : "",
                          )
                          .join("")
                      : "";
                if (contentStr) {
                  addTimelineEvent({ type: "content", content: contentStr });
                }
              } else if (!hasContentEvent && hasToolCalls) {
                // Fallback for DeepSeek / GLM-style providers that
                // return their final answer as `reasoning_content`
                // instead of `content`. Convert the last thinking
                // block to content so the user sees the response.
                const thinkingEvents = timelineRef.current.filter(
                  (e) => e.type === "thinking" && e.thinking,
                );
                if (thinkingEvents.length > 0) {
                  const lastThinking = thinkingEvents[thinkingEvents.length - 1];
                  const thinkingText = lastThinking.thinking!;
                  if (thinkingText.length > 30) {
                    updateTimelineEvent(lastThinking.id, {
                      type: "content",
                      content: thinkingText,
                      thinking: undefined,
                      isThinking: false,
                    });
                  }
                }
              }
              if (!usageReceivedFromAPI) {
                const ctx = useContextStore.getState();
                let responseTokens = 0;
                let images = 0;
                // Strip image payloads (screenshots, pasted images) BEFORE
                // estimating — a base64 blob counted as text would overcount the
                // context ~10x. Each stripped image bills a flat allowance.
                const estimate = (text: string) => {
                  const clean = stripImagePayloads(text);
                  images += clean.images;
                  responseTokens += tokenService.quickEstimate(clean.text).tokens;
                };
                for (const event of timelineRef.current) {
                  if (event.type === "content" && event.content) {
                    estimate(event.content);
                  } else if (event.type === "thinking" && event.thinking) {
                    estimate(event.thinking);
                  } else if (event.type === "tool" && event.tool?.result) {
                    estimate(event.tool.result);
                  }
                }
                responseTokens += images * IMAGE_TOKEN_COST;
                ctx.setEstimatedContext(ctx.usedContextTokens + responseTokens);
              }
            },
            onError: (error) => {
              const isCancelled =
                error.message === "Request cancelled" ||
                error.name === "AbortError" ||
                error.message.includes("aborted");

              if (!isCancelled) {
                const classified = classifyError(error);
                addTimelineEvent({
                  type: "content",
                  content: `**${classified.title}**\n\n${classified.message}\n\n💡 ${classified.suggestion}`,
                });
              }

              if (currentThinkingEventId) {
                updateTimelineEvent(currentThinkingEventId, {
                  isThinking: false,
                });
              }
            },
          },
          undefined,
          composedIdeContext,
          promptContext,
        );
      } catch (error) {
        const isCancelled =
          error instanceof Error &&
          (error.message === "Request cancelled" ||
            error.name === "AbortError" ||
            error.message.includes("aborted"));

        if (currentThinkingEventId) {
          updateTimelineEvent(currentThinkingEventId, { isThinking: false });
        }

        if (!isCancelled) {
          console.error("Chat error:", error);
          const classified = classifyError(
            error instanceof Error ? error : new Error(String(error)),
          );
          addTimelineEvent({
            type: "content",
            content: `**${classified.title}**\n\n${classified.message}\n\n💡 ${classified.suggestion}`,
          });
        }
      } finally {
        // Sweep: any tool that's still pending/executing when the turn
        // ends is now stuck — mark it failed so the bubble doesn't
        // spin forever (cancellation, abort, timeout all land here).
        for (const event of timelineRef.current) {
          if (
            event.type === "tool" &&
            event.tool &&
            (event.tool.status === "pending" || event.tool.status === "executing")
          ) {
            updateTimelineEvent(
              event.id,
              {
                tool: {
                  ...event.tool,
                  status: "failed",
                  error:
                    event.tool.error || "Request ended before tool completed",
                },
              },
              true,
            );
          }
        }

        liveFilePreviewService.cancelAllActive();

        flushTimelineUpdate();

        if (threadId) {
          useContextStore.getState().syncFromRust(threadId);
        }

        setLoading(false);
        chatSyncBroadcast.setLoading(false);
        setStreamingState(false);
        currentMessageIdRef.current = null;
      }
    },
    [
      addMessageToThread,
      addTimelineEvent,
      flushTimelineUpdate,
      setLoading,
      setPendingApproval,
      updateThreadUsage,
      updateTimelineEvent,
    ],
  );

  const handleApprove = useCallback(() => {
    if (pendingToolCallRef.current?.resolve) {
      pendingToolCallRef.current.resolve(true);
      pendingToolCallRef.current = null;
    }
    setPendingApproval(null);
  }, [setPendingApproval]);

  const handleApproveRemember = useCallback(() => {
    if (!pendingApproval) return;
    useSettingsStore.getState().setToolApproval(pendingApproval.toolName, "auto");
    handleApprove();
  }, [handleApprove, pendingApproval]);

  const handleReject = useCallback(() => {
    const pending = pendingToolCallRef.current;
    if (pending?.toolCall) {
      const toolName = pending.toolCall.function.name;
      const parsedArgs = parseToolArgumentsForDisplay(
        pending.toolCall.function.arguments,
      );
      const auditStore = useAuditStore.getState();
      const riskLevel = toolRegistry.getRiskLevel(toolName);
      auditStore.addEntry({
        toolName,
        args: parsedArgs,
        status: "rejected",
        riskLevel,
        threadId: useThreadStore.getState().currentThreadId || undefined,
      });

      const toolEvent = timelineRef.current.find(
        (e) => e.type === "tool" && e.tool?.id === pending.toolCall.id,
      );
      if (toolEvent) {
        updateTimelineEvent(
          toolEvent.id,
          {
            tool: {
              ...toolEvent.tool!,
              status: "rejected",
              result: "User rejected this tool call.",
            },
          },
          true,
        );
      }

      liveFilePreviewService.fail(pending.toolCall.id);
    }
    if (pending?.resolve) {
      pending.resolve(false);
      pendingToolCallRef.current = null;
    }
    setPendingApproval(null);
  }, [setPendingApproval, updateTimelineEvent]);

  // Auto-flush the mid-turn queue on the isLoading true→false
  // transition. The Rust runtime usually drains the queue at the next
  // tool-result boundary, but if the turn ends without ever hitting a
  // tool-result the queued message would otherwise sit in the pill
  // forever — this catches that case and submits the queued text as a
  // fresh turn so it's never silently lost.
  const prevIsLoadingRef = useRef(isLoading);
  useEffect(() => {
    const wasLoading = prevIsLoadingRef.current;
    prevIsLoadingRef.current = isLoading;
    if (!wasLoading || isLoading) return;
    const queued = useChatStore.getState().queuedMessage;
    if (!queued) return;
    useChatStore.getState().clearQueuedMessageLocal();
    const tid = useThreadStore.getState().currentThreadId;
    if (tid) {
      void useChatStore.getState().cancelQueuedMessage(tid);
    }
    void handleSend(queued.text);
  }, [isLoading, handleSend]);

  return {
    handleSend,
    handleApprove,
    handleApproveRemember,
    handleReject,
  };
}
