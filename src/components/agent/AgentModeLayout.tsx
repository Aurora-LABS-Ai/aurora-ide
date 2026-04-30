/**
 * THEME ARCHITECTURE NOTICE:
 *
 * This component uses the centralized theme system via CSS variables.
 * All colors use var(--aurora-{category}-{token}) format.
 *
 * Agent Mode Layout - Full-screen chat interface with file changes panel
 *
 * See: DOCS/theme-dev.md for full token reference
 */

import React, { useRef, useCallback, useState, useEffect } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import {
  Minimize2,
  Plus,
  History,
  PanelRightOpen,
} from "lucide-react";
import { classifyError } from '../../lib/error-classifier';
import { StreamingDotMatrix } from "../ui/StreamingDotMatrix";
import { useUiStore } from "../../store/useUiStore";
import { useThreadStore, setStreamingState } from "../../store/useThreadStore";
import type { ToolCallRequest } from "../../tools/types";
import { useChatStore } from "../../store/useChatStore";
import { useSmoothAutoScroll } from "../../hooks/useSmoothAutoScroll";
import { useSettingsStore } from "../../store/useSettingsStore";
import { useWorkspaceStore } from "../../store/useWorkspaceStore";
import { useContextStore } from "../../store/useContextStore";
import { useAuditStore } from "../../store/useAuditStore";
import { useCheckpointStore } from "../../store/useCheckpointStore";
import { useTaskStore } from "../../store/useTaskStore";
import { useMcpStore } from "../../store/useMcpStore";
import { getAgentService, type ProviderConfig } from "../../services";
import type { AgentPromptContext } from "../../services/agent-prompt";
import {
  filterProjectRulesByAttachment,
  getPromptAttachmentSelection,
  type PromptAttachment,
} from "../../services/prompt-assets";
import { tokenService } from "../../services/token-service";
import { toolRegistry } from "../../tools";
import { registerAllExecutors } from "../../tools";
import {
  buildQueryContext,
  enrichUserQueryWithAttachments,
  getIDEContext,
  getIDEContextLight,
  loadProjectRules,
} from "../../services/context-builder";
import { chatSyncBroadcast } from "../../hooks/useRustChatSync";
import {
  parseToolArguments,
  parseToolArgumentsForDisplay,
} from "../../lib/tool-arguments";
import { getProfessionalToolName } from "../../services/tool-display";
import { AgentChangesTree } from "./AgentChangesTree";
import { AgentInputArea, type AttachedFile } from "./AgentInputArea";
import { ChatMessage } from "../chat/ChatMessage";
import { ThreadHistory } from "../chat/ThreadHistory";
import { WorkspaceAwareEmptyState } from "../chat/WorkspaceAwareEmptyState";
import { AppIcon } from "../ui/AppIcon";
import type {
  ToolProposal,
  ToolCall,
  Message,
  TimelineEvent,
} from "../../types";

// Initialize executors on module load
let executorsInitialized = false;
const initExecutors = () => {
  if (!executorsInitialized) {
    registerAllExecutors();
    useMcpStore.getState().loadServers();
    executorsInitialized = true;
  }
};

// Generate unique ID
const generateId = () => Math.random().toString(36).substr(2, 9);

// Get theme colors at runtime from CSS variables
const getContextColor = (varName: string, fallback: string): string => {
  if (typeof window === "undefined") return fallback;
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue(varName)
    .trim();
  return value || fallback;
};

const getContextColors = () => ({
  low: getContextColor("--aurora-chat-usage-low", "#22d3ee"),
  medium: getContextColor("--aurora-chat-usage-medium", "#facc15"),
  high: getContextColor("--aurora-chat-usage-high", "#ef4444"),
});

export const AgentModeLayout: React.FC = () => {
  const { toggleAgentMode } = useUiStore();
  const { setLoading, isLoading, pendingApproval, setPendingApproval, setInputContent } =
    useChatStore();
  const {
    currentThreadId,
    threads,
    createThread,
    addMessageToThread,
    updateMessageInThread,
    updateThreadUsage,
    clearCurrentThread,
  } = useThreadStore();
  const { refreshDirectory, rootPath } = useWorkspaceStore();
  const {
    autoApproveTools,
    agentExecutionMode,
    maxToolCallsPerRequest,
    getToolApproval,
    setToolApproval,
    getLLMConfig,
  } = useSettingsStore();
  const { thinkingEnabled: userThinkingEnabled } = useSettingsStore();
  const llmConfig = getLLMConfig();
  const thinkingEnabled =
    userThinkingEnabled && (llmConfig?.supportsThinking ?? false);
  const temperature = llmConfig?.defaultTemperature ?? 1.0;
  const maxTokens =
    llmConfig?.defaultMaxTokens ?? llmConfig?.maxOutputTokens ?? 8192;

  const [isHistoryOpen, setIsHistoryOpen] = useState(false);
  // Track the user's preference for the changes panel separately from
  // whether there are any changes at all. The panel/toggle only appear
  // when both: (a) the agent has actually touched files for the current
  // thread, AND (b) the user hasn't explicitly hidden it.
  //
  // Default `true` so that the very first file edit auto-reveals the
  // panel. After the user collapses it, this flips to `false` and stays
  // false until they re-open it (or until they start a new chat, where
  // we reset it — see handleNewChat).
  const [isChangesPanelVisible, setIsChangesPanelVisible] = useState(true);

  // ───────────────────────────────────────────────────────────────────
  // Show the agent-changes panel ONLY when the agent has actually
  // modified files in the current thread. Without this guard the panel
  // (and the floating "Changes" toggle button) are visible by default
  // even on a brand-new empty chat — which feels unprofessional and
  // wastes horizontal space.
  //
  // We filter the audit entries by current thread so that switching
  // threads (or starting a new chat) hides the panel until that
  // thread's agent actually edits something.
  //
  // The criteria mirror AgentChangesTree's internal filter — keep them
  // in sync if the list of file-mutating tool names ever changes.
  // ───────────────────────────────────────────────────────────────────
  const auditEntries = useAuditStore((s) => s.entries);
  const hasAgentFileChanges = React.useMemo(() => {
    if (!currentThreadId) return false;
    const FILE_OP_TOOLS = new Set([
      "file_create",
      "file_write",
      "file_patch",
      "search_replace",
      "multi_search_replace",
      "file_delete",
    ]);
    return auditEntries.some(
      (e) =>
        e.threadId === currentThreadId &&
        e.status === "executed" &&
        FILE_OP_TOOLS.has(e.toolName) &&
        Boolean(e.args?.path),
    );
  }, [auditEntries, currentThreadId]);

  // Composite states the layout actually consumes.
  const showChangesPanel = hasAgentFileChanges && isChangesPanelVisible;
  const showChangesToggle = hasAgentFileChanges && !isChangesPanelVisible;
  const currentMessageIdRef = useRef<string | null>(null);
  const pendingToolCallRef = useRef<{
    resolve: ((approved: boolean) => void) | null;
    toolCall: ToolCallRequest;
  } | null>(null);
  const timelineRef = useRef<TimelineEvent[]>([]);
  const { containerRef, contentRef, bottomRef, jumpToBottom } =
    useSmoothAutoScroll({
      isStreaming: isLoading,
      initialScrollBehavior: "auto",
      bottomThreshold: 120,
      streamingFollowLerp: 0.22,
    });

  // Context tracking
  const {
    usagePercentage,
    usedContextTokens,
    contextWindow,
    isOverLimit,
    totalTurns,
    summarizedTurns,
  } = useContextStore();
  const contextColors = getContextColors();

  // Get current thread messages
  const currentThread = currentThreadId ? threads[currentThreadId] : null;
  const messages = currentThread?.messages || [];
  const hasMessages = messages.length > 0;
  const title = hasMessages ? currentThread?.title || "Chat" : "New Chat";

  // Initialize executors
  useEffect(() => {
    initExecutors();
  }, []);

  // Initialize checkpoint store
  useEffect(() => {
    if (rootPath) {
      useCheckpointStore.getState().initForWorkspace(rootPath);
    }
  }, [rootPath]);

  useEffect(() => {
    if (currentThreadId) {
      useCheckpointStore.getState().loadCheckpointsForThread(currentThreadId);
    }
  }, [currentThreadId]);

  // Auto scroll
  useEffect(() => {
    jumpToBottom();
  }, [jumpToBottom, messages.length]);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        toggleAgentMode();
      } else if (e.ctrlKey && e.key === "h") {
        e.preventDefault();
        setIsHistoryOpen(true);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [toggleAgentMode]);

  const handleNewChat = useCallback(() => {
    useContextStore.getState().reset();
    clearCurrentThread();
    chatSyncBroadcast.clear();
    // Re-arm the auto-show: if the user hid the panel mid-thread, they
    // still want it to auto-reveal the moment the *new* chat's agent
    // touches a file. Without this reset, a previously-collapsed flag
    // would silently swallow that first reveal.
    setIsChangesPanelVisible(true);
  }, [clearCurrentThread]);

  // RAF-based timeline update
  const pendingRAF = useRef<number | null>(null);

  const flushTimelineUpdate = useCallback(() => {
    if (pendingRAF.current) {
      cancelAnimationFrame(pendingRAF.current);
      pendingRAF.current = null;
    }
    if (currentMessageIdRef.current) {
      updateMessageInThread(currentMessageIdRef.current, {
        timeline: [...timelineRef.current],
      });
    }
  }, [updateMessageInThread]);

  const addTimelineEvent = useCallback(
    (event: Omit<TimelineEvent, "id" | "timestamp">) => {
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
          if (currentMessageIdRef.current) {
            updateMessageInThread(currentMessageIdRef.current, {
              timeline: [...timelineRef.current],
            });
          }
        });
      }
    },
    [updateMessageInThread, flushTimelineUpdate],
  );

  const refreshFileExplorer = useCallback(() => {
    if (rootPath) {
      console.log("Refreshing file explorer for:", rootPath);
    }
    refreshDirectory();
  }, [rootPath, refreshDirectory]);

  // Handle send (reusing ChatPanel logic)
  const handleSend = useCallback(
    async (
      content: string,
      attachedFiles?: AttachedFile[],
      promptAttachments?: PromptAttachment[],
    ) => {
      timelineRef.current = [];
      let threadId = currentThreadId;
      let isNewThread = false;
      const threadExists = threadId && threads[threadId];

      if (!threadId || !threadExists) {
        useTaskStore.getState().clearTasks();
        threadId = createThread();
        isNewThread = true;
      }

      const userMessage: Message = {
        id: generateId(),
        sender: "user",
        content,
        timestamp: Date.now(),
        attachedFiles: attachedFiles?.map(f => ({ path: f.path, name: f.name })),
        attachedPromptAssets: promptAttachments?.map(a => ({ key: a.key, type: a.type, title: a.title })),
      };
      addMessageToThread(userMessage);

      const checkpointReady =
        rootPath && threadId
          ? useCheckpointStore
              .getState()
              .createCheckpoint(userMessage.id, threadId)
          : Promise.resolve(true);

      const isFirstMessage =
        isNewThread ||
        !currentThread?.messages ||
        currentThread.messages.length === 0;
      const projectLayoutEnabled =
        useSettingsStore.getState().projectLayoutEnabled;
      const shouldIncludeLayout = isFirstMessage && projectLayoutEnabled;
      const ideContext = shouldIncludeLayout
        ? getIDEContext(true)
        : getIDEContextLight();
      const promptSelection = getPromptAttachmentSelection(
        promptAttachments ?? [],
      );
      const selectedRules =
        rootPath && promptSelection.ruleFilenames.length > 0
          ? filterProjectRulesByAttachment(
              await loadProjectRules(rootPath),
              promptAttachments ?? [],
            )
          : undefined;

      // Enrich user query with explicit skill/rule attachment annotations
      // so the LLM knows which assets the user specifically referenced
      const enrichedContent = enrichUserQueryWithAttachments(
        content,
        promptAttachments?.map(a => ({ type: a.type, title: a.title, key: a.key })),
      );

      const { formattedContext } = await buildQueryContext(
        enrichedContent,
        attachedFiles,
        {
          ...ideContext,
          projectRules: selectedRules,
        },
      );
      const promptContext: AgentPromptContext = {
        explicitSkillKeys: promptSelection.explicitSkillKeys,
        userMessage: content,
        workspacePath: rootPath || undefined,
      };

      setLoading(true);
      chatSyncBroadcast.setLoading(true);
      setStreamingState(true);

      const llmConfig = getLLMConfig();
      if (!llmConfig) {
        const errorMessage: Message = {
          id: generateId(),
          sender: "assistant",
          content: "No models configured. Please add an API key in Settings.",
          timestamp: Date.now(),
        };
        addMessageToThread(errorMessage);
        setLoading(false);
        return;
      }

      const providerConfig: ProviderConfig = {
        id: llmConfig.id,
        name: llmConfig.name,
        providerType:
          (llmConfig.providerType as ProviderConfig["providerType"]) ||
          "custom",
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
      let hasFileOperation = false;
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
          maxToolIterations: maxToolCallsPerRequest,
          getToolApproval,
        });

        await agent.chat(
          formattedContext,
          {
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
                const existingEvent = timelineRef.current.find(
                  (e) => e.id === currentContentEventId,
                );
                if (existingEvent) {
                  updateTimelineEvent(currentContentEventId, {
                    content: (existingEvent.content || "") + token,
                  });
                }
              }
            },
            onThinking: (thinking) => {
              if (!currentThinkingEventId) {
                currentThinkingEventId = addTimelineEvent({
                  type: "thinking",
                  thinking: thinking,
                  isThinking: true,
                });
              } else {
                const existingEvent = timelineRef.current.find(
                  (e) => e.id === currentThinkingEventId,
                );
                if (existingEvent) {
                  updateTimelineEvent(currentThinkingEventId, {
                    thinking: (existingEvent.thinking || "") + thinking,
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

              const existingToolEvent = timelineRef.current.find(
                (e) => e.type === "tool" && e.tool?.id === toolCall.id,
              );

              if (!existingToolEvent) {
                const newToolCall: ToolCall = {
                  id: toolCall.id,
                  name: toolCall.function.name,
                  status: "pending",
                  args: {},
                };
                newToolCall.args = parseToolArgumentsForDisplay(
                  toolCall.function.arguments,
                );
                addTimelineEvent({ type: "tool", tool: newToolCall });

                if (
                  [
                    "file_create",
                    "file_write",
                    "file_delete",
                    "folder_create",
                    "folder_move",
                    "folder_delete",
                  ].includes(toolCall.function.name)
                ) {
                  hasFileOperation = true;
                }
              } else {
                const rawArgs = toolCall.function.arguments || "";
                let parsedArgs = existingToolEvent.tool!.args || {};
                const parseResult = parseToolArguments(rawArgs);
                if (parseResult.status !== "invalid") {
                  parsedArgs = parseResult.args;
                }
                const updatedTool = {
                  ...existingToolEvent.tool!,
                  args: parsedArgs,
                  rawArgs,
                };
                updateTimelineEvent(existingToolEvent.id, {
                  tool: updatedTool,
                });
              }
            },
            onToolApprovalRequired: async (toolCall) => {
              const toolName = toolCall.function.name;
              const toolSetting = getToolApproval(toolName);
              if (toolSetting === "auto") return true;
              if (toolSetting === "deny") return false;

              const proposal: ToolProposal = {
                id: toolCall.id,
                toolName: toolName,
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

              const pendingToolCall: {
                resolve: ((approved: boolean) => void) | null;
                toolCall: ToolCallRequest;
              } = { toolCall, resolve: null };
              pendingToolCallRef.current = pendingToolCall;
              return new Promise<boolean>((resolve) => {
                pendingToolCall.resolve = resolve;
                setPendingApproval(proposal);
              });
            },
            onToolExecutionStart: (toolCall) => {
              const toolName = toolCall.function.name;
              const parsedArgs = parseToolArgumentsForDisplay(
                toolCall.function.arguments,
              );
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
                updateTimelineEvent(
                  toolEvent.id,
                  { tool: { ...toolEvent.tool!, status: "executing" } },
                  true,
                );
              }
            },
            onToolExecutionComplete: (toolCall, result) => {
              const auditId = auditEntryIds.get(toolCall.id);
              if (auditId) {
                const entry = auditStore.entries.find((e) => e.id === auditId);
                const duration = entry
                  ? Date.now() - entry.timestamp
                  : undefined;
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
                updateTimelineEvent(
                  toolEvent.id,
                  { tool: { ...toolEvent.tool!, status: "complete", result } },
                  true,
                );
              }
              if (hasFileOperation) {
                setTimeout(() => refreshFileExplorer(), 100);
              }
            },
            onToolExecutionError: (toolCall, error) => {
              const auditId = auditEntryIds.get(toolCall.id);
              if (auditId) {
                const entry = auditStore.entries.find((e) => e.id === auditId);
                const duration = entry
                  ? Date.now() - entry.timestamp
                  : undefined;
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
              const contextStore = useContextStore.getState();
              contextStore.updateUsage({
                promptTokens: usage.promptTokens,
                completionTokens: usage.completionTokens,
                totalTokens: usage.totalTokens,
                cacheReadTokens: usage.cacheReadTokens,
                cacheWriteTokens: usage.cacheWriteTokens,
              });
              const newContextState = useContextStore.getState();
              updateThreadUsage(
                {
                  promptTokens: usage.promptTokens,
                  completionTokens: usage.completionTokens,
                  totalTokens: usage.totalTokens,
                  cacheReadTokens: usage.cacheReadTokens,
                  cacheWriteTokens: usage.cacheWriteTokens,
                },
                {
                  usedTokens: newContextState.usedContextTokens,
                  contextWindow: newContextState.contextWindow,
                  percentage: newContextState.usagePercentage,
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
                          .map((b) =>
                            "text" in b
                              ? (b as { text?: string }).text || ""
                              : "",
                          )
                          .join("")
                      : "";
                if (contentStr) {
                  addTimelineEvent({ type: "content", content: contentStr });
                }
              } else if (!hasContentEvent && hasToolCalls) {
                const thinkingEvents = timelineRef.current.filter(
                  (e) => e.type === "thinking" && e.thinking,
                );
                if (thinkingEvents.length > 0) {
                  const lastThinking =
                    thinkingEvents[thinkingEvents.length - 1];
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

              if (hasFileOperation) {
                refreshFileExplorer();
              }

              if (!usageReceivedFromAPI) {
                const contextStore = useContextStore.getState();
                let responseTokens = 0;
                for (const event of timelineRef.current) {
                  if (event.type === "content" && event.content) {
                    responseTokens += tokenService.quickEstimate(
                      event.content,
                    ).tokens;
                  } else if (event.type === "thinking" && event.thinking) {
                    responseTokens += tokenService.quickEstimate(
                      event.thinking,
                    ).tokens;
                  } else if (event.type === "tool" && event.tool?.result) {
                    responseTokens += tokenService.quickEstimate(
                      event.tool.result,
                    ).tokens;
                  }
                }
                const currentContext = contextStore.usedContextTokens;
                contextStore.setEstimatedContext(
                  currentContext + responseTokens,
                );
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
          undefined,
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
          const classified = classifyError(error instanceof Error ? error : new Error(String(error)));
          addTimelineEvent({
            type: "content",
            content: `**${classified.title}**\n\n${classified.message}\n\n💡 ${classified.suggestion}`,
          });
        }
      } finally {
        // Sweep: mark any tools still in pending/executing as failed.
        for (const event of timelineRef.current) {
          if (
            event.type === "tool" &&
            event.tool &&
            (event.tool.status === "pending" ||
              event.tool.status === "executing")
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
      currentThreadId,
      currentThread,
      createThread,
      addMessageToThread,
      updateThreadUsage,
      setLoading,
      autoApproveTools,
      agentExecutionMode,
      maxToolCallsPerRequest,
      getToolApproval,
      setPendingApproval,
      addTimelineEvent,
      updateTimelineEvent,
      flushTimelineUpdate,
      refreshFileExplorer,
      getLLMConfig,
      thinkingEnabled,
      temperature,
      maxTokens,
      threads,
      rootPath,
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
    setToolApproval(pendingApproval.toolName, "auto");
    handleApprove();
  }, [handleApprove, pendingApproval, setToolApproval]);

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
        threadId: currentThreadId || undefined,
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
    }
    if (pending?.resolve) {
      pending.resolve(false);
      pendingToolCallRef.current = null;
    }
    setPendingApproval(null);
  }, [setPendingApproval, updateTimelineEvent, currentThreadId]);

  const getUsageColor = () => {
    if (isOverLimit || usagePercentage >= 80) return contextColors.high;
    if (usagePercentage >= 30) return contextColors.medium;
    return contextColors.low;
  };

  const formatTokens = (n: number) => {
    if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
    if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
    return n.toLocaleString();
  };

  const isEmpty = messages.length === 0;

  // Slim, wrapperless header buttons. Idle has no chrome — just the icon.
  // Hover applies a subtle primary tint background.
  const renderHeaderButton = (
    onClick: () => void,
    icon: React.ReactNode,
    title: string,
    variant: "ghost" | "primary" = "ghost",
  ) => {
    const isPrimary = variant === "primary";
    return (
      <button
        onClick={onClick}
        className="flex h-6 w-6 items-center justify-center transition-colors outline-none focus:outline-none"
        style={{
          background: isPrimary
            ? "color-mix(in srgb, var(--aurora-common-primary) 8%, transparent)"
            : "transparent",
          color: isPrimary
            ? "var(--aurora-common-primary)"
            : "var(--aurora-common-muted-foreground)",
          border: "none",
          borderRadius: 5,
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.backgroundColor = isPrimary
            ? "color-mix(in srgb, var(--aurora-common-primary) 16%, transparent)"
            : "color-mix(in srgb, var(--aurora-common-primary) 8%, transparent)";
          if (!isPrimary) {
            e.currentTarget.style.color = "var(--aurora-common-primary)";
          }
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.backgroundColor = isPrimary
            ? "color-mix(in srgb, var(--aurora-common-primary) 8%, transparent)"
            : "transparent";
          if (!isPrimary) {
            e.currentTarget.style.color =
              "var(--aurora-common-muted-foreground)";
          }
        }}
        title={title}
      >
        {icon}
      </button>
    );
  };

  return (
    <div
      className="h-full flex flex-col"
      style={{ background: "var(--aurora-editor-background)" }}
    >
      {/* Header — slim, wrapperless buttons, single-line title row */}
      <div
        className="flex h-9 items-center justify-between border-b px-3 shrink-0"
        style={{
          background:
            "color-mix(in srgb, var(--aurora-title-bar-background) 78%, var(--aurora-editor-background) 22%)",
          borderColor:
            "color-mix(in srgb, var(--aurora-common-border) 70%, transparent)",
        }}
      >
        {/* Left - Title (single-line for compactness) */}
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <div className="flex h-4 w-4 shrink-0 items-center justify-center">
            {isLoading ? (
              <StreamingDotMatrix className="text-primary" size={13} />
            ) : (
              <img
                src="/empty.png"
                alt=""
                aria-hidden="true"
                className="h-4 w-4 object-contain"
              />
            )}
          </div>
          <h2
            className="text-[12px] font-semibold truncate leading-none"
            style={{ color: "var(--aurora-title-bar-foreground)" }}
          >
            {title}
          </h2>
          {hasMessages && (
            <div className="flex items-center gap-1.5 shrink-0 leading-none">
              {totalTurns > 0 && (
                <span
                  className="text-[10px]"
                  style={{ color: "var(--aurora-common-muted-foreground)" }}
                >
                  {totalTurns}t
                </span>
              )}
              {summarizedTurns > 0 && (
                <>
                  <span
                    className="text-[10px] opacity-50"
                    style={{ color: "var(--aurora-common-muted-foreground)" }}
                  >
                    ·
                  </span>
                  <span
                    className="text-[10px]"
                    style={{ color: contextColors.low }}
                    title={`${summarizedTurns} turn(s) summarized`}
                  >
                    Σ{summarizedTurns}
                  </span>
                </>
              )}
              {usedContextTokens > 0 && (
                <>
                  <span
                    className="text-[10px] opacity-50"
                    style={{ color: "var(--aurora-common-muted-foreground)" }}
                  >
                    ·
                  </span>
                  <span
                    className="text-[10px] font-mono"
                    style={{ color: getUsageColor() }}
                  >
                    {formatTokens(usedContextTokens)}/
                    {formatTokens(contextWindow)}
                  </span>
                </>
              )}
            </div>
          )}
        </div>

        {/* Right - Actions */}
        <div className="flex items-center gap-0.5 shrink-0">
          {renderHeaderButton(
            () => setIsHistoryOpen(true),
            <AppIcon icon={History} size={13} />,
            "Chat history (Ctrl+H)",
          )}
          {renderHeaderButton(
            handleNewChat,
            <AppIcon icon={Plus} size={14} />,
            "New chat",
            "primary",
          )}
          {renderHeaderButton(
            toggleAgentMode,
            <AppIcon icon={Minimize2} size={13} />,
            "Exit Agent Mode (Esc)",
          )}
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 min-h-0 min-w-0 overflow-hidden relative">
        <PanelGroup
          direction="horizontal"
          id="agent-mode-panel-group"
          // Re-key the PanelGroup whenever the side panel mounts or
          // unmounts so react-resizable-panels re-allocates sizes from
          // scratch instead of leaving the chat panel pinned at 75%.
          key={showChangesPanel ? "with-changes" : "no-changes"}
        >
          {/* Center - Chat */}
          <Panel
            id="agent-chat-panel"
            order={1}
            defaultSize={showChangesPanel ? 75 : 100}
            minSize={50}
          >
            <div
              className="h-full min-w-0 overflow-hidden flex flex-col"
              style={{ background: "var(--aurora-chat-background)" }}
            >
              {/* Messages Area */}
              {isEmpty ? (
                <WorkspaceAwareEmptyState
                  mode="agent"
                  rootPath={rootPath}
                  onSelectPrompt={setInputContent}
                />
              ) : (
                <div
                  ref={containerRef}
                  className="flex-1 min-h-0 min-w-0 overflow-y-scroll overflow-x-hidden px-4 md:px-8 lg:px-16 xl:px-24 scrollbar-thin"
                  style={{
                    scrollbarGutter: "stable both-edges",
                    scrollBehavior: "smooth",
                    overscrollBehavior: "contain",
                    WebkitOverflowScrolling: "touch",
                  }}
                >
                  <div ref={contentRef} className="max-w-4xl mx-auto py-6">
                    {messages.map((msg, index) => (
                      <ChatMessage
                        key={msg.id}
                        message={msg}
                        isStreaming={isLoading}
                        isLastMessage={index === messages.length - 1}
                        toolVariant="timeline"
                        pendingApproval={pendingApproval}
                        onApprovePending={handleApprove}
                        onRejectPending={handleReject}
                        onApprovePendingRemember={handleApproveRemember}
                      />
                    ))}
                    <div ref={bottomRef} className="h-4" />
                  </div>
                </div>
              )}

              {/* Input - Fixed at bottom, centered */}
              <div
                className="shrink-0 min-w-0 overflow-x-hidden px-4 md:px-8 lg:px-16 py-4"
                style={{ background: "var(--aurora-chat-background)" }}
              >
                <AgentInputArea onSend={handleSend} disabled={isLoading} />
              </div>
            </div>
          </Panel>

          {/* Right side panel — only rendered when the agent has actually
              edited files in this thread AND the user hasn't collapsed
              the panel. Both conditions must be true; otherwise nothing
              on the right side is rendered (no panel, no resize handle,
              no floating toggle). */}
          {showChangesPanel && (
            <>
              <PanelResizeHandle
                className="w-[1px] hover:w-1 transition-all"
                style={{ background: "var(--aurora-common-border)" }}
              />

              {/* Right - File Changes */}
              <Panel
                id="agent-changes-panel"
                order={2}
                defaultSize={25}
                minSize={15}
                maxSize={40}
              >
                <AgentChangesTree
                  onCollapse={() => setIsChangesPanelVisible(false)}
                />
              </Panel>
            </>
          )}
        </PanelGroup>

        {/* Floating "show changes" tab — only when the agent has touched
            files AND the user collapsed the panel. On a fresh chat (no
            file ops yet) this is hidden too, so the chat view stays
            uncluttered. */}
        {showChangesToggle && (
          <button
            onClick={() => setIsChangesPanelVisible(true)}
            className="absolute top-3 right-3 z-20 flex h-7 items-center gap-1.5 px-2 transition-all outline-none focus:outline-none"
            style={{
              backgroundColor:
                "color-mix(in srgb, var(--aurora-sidebar-background) 92%, var(--aurora-chat-surface) 8%)",
              border:
                "1px solid color-mix(in srgb, var(--aurora-common-border) 65%, transparent)",
              borderRadius: 6,
              color: "var(--aurora-common-muted-foreground)",
              boxShadow:
                "0 4px 10px color-mix(in srgb, var(--aurora-common-shadow) 12%, transparent)",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.color = "var(--aurora-common-primary)";
              e.currentTarget.style.borderColor =
                "color-mix(in srgb, var(--aurora-common-primary) 35%, transparent)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.color =
                "var(--aurora-common-muted-foreground)";
              e.currentTarget.style.borderColor =
                "color-mix(in srgb, var(--aurora-common-border) 65%, transparent)";
            }}
            title="Show changes panel"
          >
            <PanelRightOpen className="w-3.5 h-3.5" />
            <span className="text-[10.5px] font-semibold tracking-tight">
              Changes
            </span>
          </button>
        )}
      </div>

      {/* Thread History Modal */}
      <ThreadHistory
        isOpen={isHistoryOpen}
        onClose={() => setIsHistoryOpen(false)}
      />
    </div>
  );
};

export default AgentModeLayout;
