/**
 * THEME ARCHITECTURE NOTICE:
 * 
 * This project uses a centralized theme system. DO NOT use hardcoded colors.
 * 
 * Instead of:
 *   - Hardcoded hex values: #ff0000, #1a1a1a
 *   - Hardcoded RGB values: rgb(255, 0, 0)
 *   - Tailwind arbitrary colors: bg-[#1a1a1a], text-[#ff0000]
 * 
 * Use theme tokens via CSS variables:
 *   - CSS: var(--aurora-{category}-{token})
 *   - Tailwind: bg-[var(--aurora-editor-background)]
 *   - Component styles: style={{ background: 'var(--aurora-sidebar-background)' }}
 * 
 * Available categories: editor, sidebar, chat, terminal, statusBar, titleBar, common
 * 
 * See: DOCS/theme-dev.md for full token reference
 * See: src/types/theme.ts for TypeScript interfaces
 * See: src/services/theme-service.ts for theme utilities
 */

import React, { useRef, useCallback, useState, useEffect } from "react";
import { classifyError } from '../../lib/error-classifier';
import { ChatMessages } from "./ChatMessages";
import { ChatInput, type AttachedFile } from "./ChatInput";
import { ChatHeader } from "./ChatHeader";
import { ThreadHistory } from "./ThreadHistory";
import { WorkspaceAwareEmptyState } from "./WorkspaceAwareEmptyState";
import { useChatStore } from "../../store/useChatStore";
import { useThreadStore, setStreamingState } from "../../store/useThreadStore";
import { useSettingsStore } from "../../store/useSettingsStore";
import { useWorkspaceStore } from "../../store/useWorkspaceStore";
import { useContextStore } from "../../store/useContextStore";
import { useAuditStore } from "../../store/useAuditStore";
import { useCheckpointStore } from "../../store/useCheckpointStore";
import { getAgentService, type ProviderConfig, type ToolCallRequest } from "../../services";
import {
  type AgentPromptContext,
  formatSkillCatalogForContext,
  formatSkillReferences,
} from "../../services/agent-prompt";
import {
  filterProjectRulesByAttachment,
  getPromptAttachmentSelection,
  type PromptAttachment,
} from "../../services/prompt-assets";
import { tokenService } from "../../services/token-service";
import { toolRegistry } from "../../tools";
import { registerAllExecutors } from "../../tools";
import {
  buildAttachedContextBlock,
  buildQueryContext,
  getIDEContext,
  getIDEContextLight,
  loadProjectRules,
} from "../../services/context-builder";
import { chatSyncBroadcast } from "../../hooks/useRustChatSync";
import { useTaskStore } from "../../store/useTaskStore";
import { useMcpStore } from "../../store/useMcpStore";
import { parseToolArguments, parseToolArgumentsForDisplay } from "../../lib/tool-arguments";
import { liveFilePreviewService } from "../../services/live-file-preview";
import { getProfessionalToolName } from "../../services/tool-display";
import type {
  ToolProposal,
  ToolCall,
  Message,
  TimelineEvent,
} from "../../types";

// Initialize executors and MCP servers on module load
let executorsInitialized = false;
const initExecutors = () => {
  if (!executorsInitialized) {
    registerAllExecutors();
    // Also load MCP servers (will auto-connect servers with autoStart enabled)
    useMcpStore.getState().loadServers();
    executorsInitialized = true;
  }
};

// Generate unique ID
const generateId = () => Math.random().toString(36).substr(2, 9);

interface ChatPanelProps {
  isDetached?: boolean;
}

interface PendingToolCallState {
  resolve: ((approved: boolean) => void) | null;
  toolCall: ToolCallRequest;
}

export const ChatPanel: React.FC<ChatPanelProps> = ({ isDetached = false }) => {
  const setLoading = useChatStore((state) => state.setLoading);
  const isLoading = useChatStore((state) => state.isLoading);
  const pendingApproval = useChatStore((state) => state.pendingApproval);
  const setPendingApproval = useChatStore((state) => state.setPendingApproval);
  const setInputContent = useChatStore((state) => state.setInputContent);

  const currentThreadId = useThreadStore((state) => state.currentThreadId);
  const threads = useThreadStore((state) => state.threads);
  const createThread = useThreadStore((state) => state.createThread);
  const addMessageToThread = useThreadStore((state) => state.addMessageToThread);
  const updateMessageInThread = useThreadStore((state) => state.updateMessageInThread);
  const updateThreadUsage = useThreadStore((state) => state.updateThreadUsage);
  const clearCurrentThread = useThreadStore((state) => state.clearCurrentThread);

  const refreshDirectory = useWorkspaceStore((state) => state.refreshDirectory);
  const rootPath = useWorkspaceStore((state) => state.rootPath);

  const autoApproveTools = useSettingsStore((state) => state.autoApproveTools);
  const agentExecutionMode = useSettingsStore((state) => state.agentExecutionMode);
  const maxToolCallsPerRequest = useSettingsStore((state) => state.maxToolCallsPerRequest);
  const getToolApproval = useSettingsStore((state) => state.getToolApproval);
  const setToolApproval = useSettingsStore((state) => state.setToolApproval);
  const getLLMConfig = useSettingsStore((state) => state.getLLMConfig);

  // Get provider-specific settings (each model has its own characteristics)
  const llmConfig = getLLMConfig();
  // Get user's thinking toggle preference from settings
  const userThinkingEnabled = useSettingsStore((state) => state.thinkingEnabled);
  // Combine: user wants thinking AND provider supports it
  const thinkingEnabled = userThinkingEnabled && (llmConfig?.supportsThinking ?? false);
  const temperature = llmConfig?.defaultTemperature ?? 1.0;
  const maxTokens = llmConfig?.defaultMaxTokens ?? llmConfig?.maxOutputTokens ?? 8192;

  const [isHistoryOpen, setIsHistoryOpen] = useState(false);
  const currentMessageIdRef = useRef<string | null>(null);
  const pendingToolCallRef = useRef<PendingToolCallState | null>(null);
  const timelineRef = useRef<TimelineEvent[]>([]);

  // Get current thread messages
  const currentThread = currentThreadId ? threads[currentThreadId] : null;
  const messages = currentThread?.messages || [];

  // Initialize executors
  useEffect(() => {
    initExecutors();
  }, []);

  // Initialize checkpoint store when workspace changes
  useEffect(() => {
    if (rootPath) {
      useCheckpointStore.getState().initForWorkspace(rootPath);
    }
  }, [rootPath]);

  // Load checkpoints when thread changes
  useEffect(() => {
    if (currentThreadId) {
      useCheckpointStore.getState().loadCheckpointsForThread(currentThreadId);
    }
  }, [currentThreadId]);

  // Keyboard shortcut: Ctrl+H to open history
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === "h") {
        e.preventDefault();
        setIsHistoryOpen(true);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  const handleNewChat = useCallback(() => {
    // Reset context usage tracking (Rust context engine manages thread contexts separately)
    useContextStore.getState().reset();
    // Don't create thread yet - just clear current
    clearCurrentThread();
    // Broadcast to other windows via Rust
    chatSyncBroadcast.clear();
  }, [clearCurrentThread]);

  // Helper to add timeline event
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

  // RAF-based timeline update for smooth 60fps streaming
  // Uses requestAnimationFrame instead of setTimeout for smooth visual updates
  const pendingRAF = useRef<number | null>(null);

  // Flush pending timeline updates immediately (for important state changes)
  const flushTimelineUpdate = useCallback(() => {
    if (pendingRAF.current) {
      cancelAnimationFrame(pendingRAF.current);
      pendingRAF.current = null;
    }
    if (currentMessageIdRef.current) {
      updateMessageInThread(currentMessageIdRef.current, {
        timeline: [...timelineRef.current],
      });
      // Broadcast to other windows for detached chat support
      chatSyncBroadcast.broadcastStreamUpdate(currentMessageIdRef.current, timelineRef.current);
    }
  }, [updateMessageInThread]);

  // Helper to update timeline event with RAF batching for smooth streaming
  // @param immediate - if true, bypasses RAF for important updates (tool status changes)
  const updateTimelineEvent = useCallback(
    (eventId: string, updates: Partial<TimelineEvent>, immediate = false) => {
      // Always update the ref immediately (this is synchronous, no re-render)
      timelineRef.current = timelineRef.current.map((e) =>
        e.id === eventId ? { ...e, ...updates } : e,
      );

      // Important updates (tool completion, status changes) should render immediately
      if (immediate) {
        flushTimelineUpdate();
        return;
      }

      // Use RAF for smooth 60fps streaming - batches within single frame
      // This is much smoother than setTimeout-based debouncing
      if (!pendingRAF.current) {
        pendingRAF.current = requestAnimationFrame(() => {
          pendingRAF.current = null;
          if (currentMessageIdRef.current) {
            updateMessageInThread(currentMessageIdRef.current, {
              timeline: [...timelineRef.current],
            });
            // Broadcast to other windows for detached chat support
            chatSyncBroadcast.broadcastStreamUpdate(currentMessageIdRef.current, timelineRef.current);
          }
        });
      }
    },
    [updateMessageInThread, flushTimelineUpdate],
  );

  // Helper to refresh file explorer after file operations
  const refreshFileExplorer = useCallback(() => {
    if (rootPath) {
      console.log("Refreshing file explorer for:", rootPath);
    }
    refreshDirectory();
  }, [rootPath, refreshDirectory]);

  const handleSend = useCallback(
    async (
      content: string,
      attachedFiles?: AttachedFile[],
      promptAttachments?: PromptAttachment[]
    ) => {
      // Reset timeline
      timelineRef.current = [];

      // Ensure we have a VALID thread (both ID and thread object must exist)
      let threadId = currentThreadId;
      let isNewThread = false;

      // Check if currentThreadId is set but thread doesn't exist in memory
      // This happens when currentThreadId is persisted but threads object is not
      const threadExists = threadId && threads[threadId];

      if (!threadId || !threadExists) {
        // Clear tasks when creating a new thread - tasks are per-thread
        useTaskStore.getState().clearTasks();
        threadId = createThread();
        isNewThread = true;
        console.log('[ChatPanel] Created new thread because:', !currentThreadId ? 'no currentThreadId' : 'thread not in memory');
      }

      // IMPORTANT: Add user message IMMEDIATELY before any async operations
      // This ensures the message appears in the UI right away, not after context building
      const userMessage: Message = {
        id: generateId(),
        sender: "user",
        content,
        timestamp: Date.now(),
        attachedFiles: attachedFiles?.map(f => ({ path: f.path, name: f.name })),
        attachedPromptAssets: promptAttachments?.map(a => ({ key: a.key, type: a.type, title: a.title })),
      };
      addMessageToThread(userMessage);

      // Create checkpoint for this user message (if enabled for workspace)
      // Pass threadId directly since the store's threadId might not be set yet for new threads
      const checkpointReady =
        rootPath && threadId
          ? useCheckpointStore.getState().createCheckpoint(userMessage.id, threadId)
          : Promise.resolve(true);

      // Build Cursor-style context with IDE state and attached files
      // First message: heavy (user_info, git_status, rules, layout, skills catalog)
      // Follow-up: lightweight (open_files + user_query only)
      const isFirstMessage = isNewThread || !currentThread?.messages || currentThread.messages.length === 0;
      const projectLayoutEnabled = useSettingsStore.getState().projectLayoutEnabled;
      const shouldIncludeLayout = isFirstMessage && projectLayoutEnabled;
      const ideContext = shouldIncludeLayout ? getIDEContext(true) : getIDEContextLight();
      const promptSelection = getPromptAttachmentSelection(promptAttachments ?? []);
      const selectedRules =
        rootPath && promptSelection.ruleFilenames.length > 0
          ? filterProjectRulesByAttachment(
              await loadProjectRules(rootPath),
              promptAttachments ?? []
            )
          : undefined;

      // Build the standalone <attached_context> block for skills/rules the
      // user explicitly attached. We keep this OUT of the user-typed text so
      // the chat bubble shows just what the user wrote on reload — the LLM
      // still sees this block via the `ideContext` sidecar passed to
      // `agent.chat` below.
      const attachedContextBlock = buildAttachedContextBlock(
        promptAttachments?.map(a => ({ type: a.type, title: a.title, key: a.key })),
      );

      // Resolve skills for context (catalog for first message, references for attached skills)
      const promptContext: AgentPromptContext = {
        explicitSkillKeys: promptSelection.explicitSkillKeys,
        isFirstMessage,
        userMessage: content,
        workspacePath: rootPath || undefined,
      };

      // Build skill catalog (first message only) and references (when skills attached)
      // Skills are sent as name+path references, agent reads full content via file_read
      const settings = useSettingsStore.getState();
      let skillCatalog: string | undefined;
      let skillReferences: string | undefined;

      if (settings.skillsEnabled) {
        const { resolveSkillsForPrompt: resolveSkills } = await import("../../services/skills");
        const resolved = await resolveSkills({
          enabledSkillToggles: settings.skillToggles,
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
          skillReferences = formatSkillReferences(resolved.explicitSkills, 'required_skills');
        }
      }

      // Pass the *clean* user-typed text into `buildQueryContext` so that
      // the resulting `ideContext` is purely the IDE/runtime enrichment
      // (user_info, project_rules, project_layout, agent_skills, …). The
      // legacy `formattedContext` is no longer sent to the agent — we only
      // need it for tests/back-compat callers.
      const { ideContext: bareIdeContext, filesWithContent, filesAsPathsOnly } = await buildQueryContext(
        content,
        attachedFiles,
        {
          ...ideContext,
          projectRules: selectedRules,
          skillCatalog,
          skillReferences,
        }
      );

      // Compose the enrichment that travels in the `ideContext` sidecar:
      // bare IDE state + (optional) attached_context block. The agent
      // service prepends the execution-mode block so we don't have to.
      const composedIdeContext: string | null = (() => {
        const parts: string[] = [];
        if (bareIdeContext) parts.push(bareIdeContext);
        if (attachedContextBlock) parts.push(attachedContextBlock);
        return parts.length > 0 ? parts.join("\n\n") : null;
      })();

      // Log when project layout is included
      if (shouldIncludeLayout && ideContext.projectLayout) {
        console.log('[ChatPanel] Including project layout in first message (persistent file map)');
      }

      // Log context info for debugging
      if (attachedFiles && attachedFiles.length > 0) {
        console.log(`[Context] ${filesWithContent.length} files with content, ${filesAsPathsOnly.length} as paths only`);
      }

      setLoading(true);
      chatSyncBroadcast.setLoading(true);
      // FIX: Mark streaming as started - no DB saves until streaming ends
      setStreamingState(true);

      // Get the current LLM config based on selected model
      const llmConfig = getLLMConfig();

      if (!llmConfig) {
        const errorMessage: Message = {
          id: generateId(),
          sender: "assistant",
          content:
            "No models configured. Please add an API key for at least one provider in Settings.",
          timestamp: Date.now(),
        };
        addMessageToThread(errorMessage);
        setLoading(false);
        return;
      }

      console.log("Using LLM config:", llmConfig);

      // Initialize enterprise provider with current settings
      const providerConfig: ProviderConfig = {
        id: llmConfig.id,
        name: llmConfig.name,
        providerType: llmConfig.providerType as ProviderConfig['providerType'] || 'custom',
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

      // Get agent and set provider + thread ID (Rust Context Engine)
      const agent = getAgentService();
      agent.setProvider(providerConfig);
      agent.setThreadId(threadId!);

      // Update context store with provider limits
      const contextStore = useContextStore.getState();
      contextStore.setContextWindow(
        providerConfig.contextWindow,
        providerConfig.maxOutputTokens
      );

      // Token estimation will come from Rust context engine after the request
      console.log(`[ChatPanel] Using Rust Context Engine for thread: ${threadId}`);

      // Create a new assistant message that we'll stream into
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

      // Track current thinking event ID
      let currentThinkingEventId: string | null = null;
      let currentContentEventId: string | null = null;
      let hasFileOperation = false;
      let usageReceivedFromAPI = false;

      // Get audit store for tracking tool executions
      const auditStore = useAuditStore.getState();
      const auditEntryIds = new Map<string, string>(); // toolCallId -> auditEntryId

      try {
        // Agent already obtained above for history access
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

        await agent.chat(content, {
          onToken: (token) => {
            // Close current thinking block when content starts
            if (currentThinkingEventId) {
              updateTimelineEvent(currentThinkingEventId, {
                isThinking: false,
              });
              currentThinkingEventId = null;
            }

            // Add content to timeline
            if (!currentContentEventId) {
              currentContentEventId = addTimelineEvent({
                type: "content",
                content: token,
              });
            } else {
              // Find and update existing content event
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
            // Create or update thinking event
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
            // Close current thinking block when tool call starts
            if (currentThinkingEventId) {
              updateTimelineEvent(currentThinkingEventId, {
                isThinking: false,
              });
              currentThinkingEventId = null; // Reset for next thinking block
            }

            // Reset content event for after tool
            currentContentEventId = null;

            // Check if tool already exists in timeline
            const existingToolEvent = timelineRef.current.find(
              (e) => e.type === "tool" && e.tool?.id === toolCall.id,
            );

            if (!existingToolEvent) {
              // Create new tool event
              const newToolCall: ToolCall = {
                id: toolCall.id,
                name: toolCall.function.name,
                status: "pending",
                args: {},
              };

              newToolCall.args = parseToolArgumentsForDisplay(
                toolCall.function.arguments,
              );

              addTimelineEvent({
                type: "tool",
                tool: newToolCall,
              });

              // Track file operations
              if (
                  [
                    "file_create",
                    "file_write",
                    "search_replace",
                    "multi_search_replace",
                    "file_delete",
                    "folder_create",
                    "folder_move",
                    "folder_delete",
                  ].includes(toolCall.function.name)
              ) {
                hasFileOperation = true;
              }
            } else {
              // Update existing tool call arguments (streaming)
              // Store rawArgs for streaming display even if JSON is incomplete
              const rawArgs = toolCall.function.arguments || '';
              let parsedArgs = existingToolEvent.tool!.args || {};

              const parseResult = parseToolArguments(rawArgs);
              if (parseResult.status !== 'invalid') {
                parsedArgs = parseResult.args;
              } else {
                // JSON still incomplete - keep existing parsed args but update rawArgs
              }

              const updatedTool = {
                ...existingToolEvent.tool!,
                args: parsedArgs,
                rawArgs: rawArgs, // Always store raw for streaming display
              };
              updateTimelineEvent(existingToolEvent.id, {
                tool: updatedTool,
              });
            }

            liveFilePreviewService.updateFromToolCall(toolCall);
          },
          onToolApprovalRequired: async (toolCall) => {
            const toolName = toolCall.function.name;
            const toolSetting = getToolApproval(toolName);

            // Check per-tool settings first
            if (toolSetting === 'auto') {
              return true; // Auto-approve
            }
            if (toolSetting === 'deny') {
              return false; // Auto-deny
            }

            // 'always_ask' - show approval UI
            const proposal: ToolProposal = {
              id: toolCall.id,
              toolName: toolName,
              description: `Execute ${getProfessionalToolName(toolName)}`,
              riskLevel: toolName.startsWith('shell_') || toolName.includes('delete') ? 'high' : 'medium',
              status: "pending",
              parameters: parseToolArgumentsForDisplay(toolCall.function.arguments),
            };

            const pendingState: PendingToolCallState = { toolCall, resolve: null };
            pendingToolCallRef.current = pendingState;

            return new Promise<boolean>((resolve) => {
              pendingState.resolve = resolve;
              setPendingApproval(proposal);
            });
          },
          onToolExecutionStart: (toolCall) => {
            const toolName = toolCall.function.name;
            const parsedArgs = parseToolArgumentsForDisplay(toolCall.function.arguments);
            liveFilePreviewService.markApplying(toolCall.id);

            // Add to audit store
            const riskLevel = toolRegistry.getRiskLevel(toolName);
            const auditId = auditStore.addEntry({
              toolName,
              args: parsedArgs,
              status: 'executing',
              riskLevel,
              threadId: threadId || undefined,
            });
            auditEntryIds.set(toolCall.id, auditId);

            // Find tool event and update status - immediate for responsive UI
            const toolEvent = timelineRef.current.find(
              (e) => e.type === "tool" && e.tool?.id === toolCall.id,
            );
            if (toolEvent) {
              updateTimelineEvent(toolEvent.id, {
                tool: { ...toolEvent.tool!, status: "executing" },
              }, true); // immediate: show "executing" status right away
            }
          },
          onToolExecutionComplete: (toolCall, result) => {
            liveFilePreviewService.complete(toolCall.id);

            // Update audit store entry
            const auditId = auditEntryIds.get(toolCall.id);
            if (auditId) {
              const entry = auditStore.entries.find(e => e.id === auditId);
              const duration = entry ? Date.now() - entry.timestamp : undefined;
              auditStore.updateEntry(auditId, {
                status: 'executed',
                result: result.substring(0, 500),
                duration,
              });
            }

            // Find tool event and update status - immediate for responsive UI
            const toolEvent = timelineRef.current.find(
              (e) => e.type === "tool" && e.tool?.id === toolCall.id,
            );
            if (toolEvent) {
              updateTimelineEvent(toolEvent.id, {
                tool: { ...toolEvent.tool!, status: "complete", result },
              }, true);
            }

            // Refresh file explorer after file operations
            if (hasFileOperation) {
              setTimeout(() => refreshFileExplorer(), 100);
            }
          },
          onToolExecutionError: (toolCall, error) => {
            liveFilePreviewService.fail(toolCall.id);

            const auditId = auditEntryIds.get(toolCall.id);
            if (auditId) {
              const entry = auditStore.entries.find(e => e.id === auditId);
              const duration = entry ? Date.now() - entry.timestamp : undefined;
              auditStore.updateEntry(auditId, {
                status: 'failed',
                result: error.substring(0, 500),
                duration,
              });
            }

            const toolEvent = timelineRef.current.find(
              (e) => e.type === "tool" && e.tool?.id === toolCall.id,
            );
            if (toolEvent) {
              updateTimelineEvent(toolEvent.id, {
                tool: { ...toolEvent.tool!, status: "failed", error },
              }, true);
            }
          },
          onToolRejected: (toolCall, reason) => {
            liveFilePreviewService.fail(toolCall.id);

            const toolEvent = timelineRef.current.find(
              (e) => e.type === "tool" && e.tool?.id === toolCall.id,
            );
            if (toolEvent) {
              updateTimelineEvent(toolEvent.id, {
                tool: { ...toolEvent.tool!, status: "rejected", result: reason },
              }, true);
            }
          },
          onUsage: (usage) => {
            // Update context store with actual usage from API
            usageReceivedFromAPI = true;
            const contextStore = useContextStore.getState();

            // Provider sends camelCase (promptTokens, completionTokens, totalTokens, cacheReadTokens)
            contextStore.updateUsage({
              promptTokens: usage.promptTokens,
              completionTokens: usage.completionTokens,
              totalTokens: usage.totalTokens,
              cacheReadTokens: usage.cacheReadTokens,
              cacheWriteTokens: usage.cacheWriteTokens,
            });

            // Persist to thread DB for conversation continuity
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
              }
            );

            console.log('[ChatPanel] Token usage from API:', usage);
          },
          onComplete: (finalMessage) => {
            // Check if we have any content in timeline
            const hasContentEvent = timelineRef.current.some(
              (e) => e.type === "content" && e.content,
            );

            // Check if we have tool calls (meaning this was a tool-using conversation)
            const hasToolCalls = timelineRef.current.some(
              (e) => e.type === "tool",
            );

            // Close any open thinking blocks first
            if (currentThinkingEventId) {
              updateTimelineEvent(currentThinkingEventId, {
                isThinking: false,
              });
              currentThinkingEventId = null;
            }

            // If we have final content from the API that wasn't streamed, add it
            if (finalMessage?.content && !hasContentEvent) {
              // Handle content that can be string or ContentBlock[]
              const contentStr = typeof finalMessage.content === 'string'
                ? finalMessage.content
                : (Array.isArray(finalMessage.content)
                  ? finalMessage.content
                    .map((block) =>
                      typeof block === 'object' &&
                        block !== null &&
                        'text' in block &&
                        typeof block.text === 'string'
                        ? block.text
                        : ''
                    )
                    .join('')
                  : '');
              if (contentStr) {
                addTimelineEvent({
                  type: "content",
                  content: contentStr,
                });
              }
            }
            // If no content event exists, find the last thinking event after tool calls
            // and convert it to content (handles DeepSeek/GLM behavior where response
            // comes as reasoning_content instead of content)
            else if (!hasContentEvent && hasToolCalls) {
              // Find the last thinking event (the final response)
              const thinkingEvents = timelineRef.current.filter(
                (e) => e.type === "thinking" && e.thinking
              );

              if (thinkingEvents.length > 0) {
                // Get the last thinking event
                const lastThinking = thinkingEvents[thinkingEvents.length - 1];
                const thinkingText = lastThinking.thinking!;

                // If it's substantial content (more than just brief reasoning),
                // convert it to content for display
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

            // Final refresh if there were file operations
            if (hasFileOperation) {
              refreshFileExplorer();
            }

            // Fallback: If no usage was received from API, estimate based on content
            if (!usageReceivedFromAPI) {
              const contextStore = useContextStore.getState();
              // Estimate total response tokens from timeline
              let responseTokens = 0;
              for (const event of timelineRef.current) {
                if (event.type === 'content' && event.content) {
                  responseTokens += tokenService.quickEstimate(event.content).tokens;
                } else if (event.type === 'thinking' && event.thinking) {
                  responseTokens += tokenService.quickEstimate(event.thinking).tokens;
                } else if (event.type === 'tool' && event.tool?.result) {
                  responseTokens += tokenService.quickEstimate(event.tool.result).tokens;
                }
              }
              // Add estimated response tokens to context
              const currentContext = contextStore.usedContextTokens;
              contextStore.setEstimatedContext(currentContext + responseTokens);
              console.log('[ChatPanel] Estimated response tokens (no API usage):', responseTokens);
            }
          },
          onError: (error) => {
            const isCancelled = error.message === 'Request cancelled' ||
              error.name === 'AbortError' ||
              error.message.includes('aborted');

            if (!isCancelled) {
              const classified = classifyError(error);
              const errorContent = `**${classified.title}**\n\n${classified.message}\n\n💡 ${classified.suggestion}`;
              addTimelineEvent({
                type: "content",
                content: errorContent,
              });
            }

            if (currentThinkingEventId) {
              updateTimelineEvent(currentThinkingEventId, {
                isThinking: false,
              });
            }
          },
        }, undefined, composedIdeContext, promptContext);
      } catch (error) {
        // Don't show error if request was cancelled by user
        const isCancelled = error instanceof Error && (
          error.message === 'Request cancelled' ||
          error.name === 'AbortError' ||
          error.message.includes('aborted')
        );

        // Always close any open thinking blocks
        if (currentThinkingEventId) {
          updateTimelineEvent(currentThinkingEventId, {
            isThinking: false,
          });
        }

        if (!isCancelled) {
          console.error("Chat error:", error);
          const classified = classifyError(error instanceof Error ? error : new Error(String(error)));
          addTimelineEvent({
            type: "content",
            content: `**${classified.title}**\n\n${classified.message}\n\n💡 ${classified.suggestion}`,
          });
        } else {
          console.log("[ChatPanel] Request cancelled by user");
        }
      } finally {
        // Sweep: mark any tools still in pending/executing as failed.
        // This is the safety net that prevents tools from being stuck forever,
        // regardless of how/why the request ended (normal, error, cancel, timeout).
        for (const event of timelineRef.current) {
          if (event.type === 'tool' && event.tool &&
              (event.tool.status === 'pending' || event.tool.status === 'executing')) {
            updateTimelineEvent(event.id, {
              tool: { ...event.tool, status: 'failed', error: event.tool.error || 'Request ended before tool completed' },
            }, true);
          }
        }

        liveFilePreviewService.cancelAllActive();

        // CRITICAL: Flush any pending timeline updates BEFORE clearing the message ID
        flushTimelineUpdate();

        // Sync context state from Rust engine (accurate tiktoken counting)
        if (threadId) {
          useContextStore.getState().syncFromRust(threadId);
        }

        setLoading(false);
        chatSyncBroadcast.setLoading(false);
        // FIX: Mark streaming as ended - this triggers the final DB save
        setStreamingState(false);
        currentMessageIdRef.current = null;
      }
    },
    [
      currentThreadId,
      currentThread?.messages,
      threads,
      createThread,
      addMessageToThread,
      updateThreadUsage,
      setLoading,
      autoApproveTools,
      agentExecutionMode,
      maxToolCallsPerRequest,
      thinkingEnabled,
      temperature,
      maxTokens,
      getToolApproval,
      setPendingApproval,
      addTimelineEvent,
      updateTimelineEvent,
      flushTimelineUpdate,
      refreshFileExplorer,
      getLLMConfig,
      rootPath,
      // Provider-specific settings are derived from getLLMConfig.
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
        pending.toolCall.function.arguments
      );

      // Add rejection to audit store
      const auditStore = useAuditStore.getState();
      const riskLevel = toolRegistry.getRiskLevel(toolName);
      auditStore.addEntry({
        toolName,
        args: parsedArgs,
        status: 'rejected',
        riskLevel,
        threadId: currentThreadId || undefined,
      });

      const toolEvent = timelineRef.current.find(
        (e) => e.type === "tool" && e.tool?.id === pending.toolCall.id,
      );
      if (toolEvent) {
        updateTimelineEvent(toolEvent.id, {
          tool: {
            ...toolEvent.tool!,
            status: "rejected",
            result: "User rejected this tool call.",
          },
        }, true); // immediate: show rejection status right away
      }

      liveFilePreviewService.fail(pending.toolCall.id);
    }
    if (pending?.resolve) {
      pending.resolve(false);
      pendingToolCallRef.current = null;
    }
    setPendingApproval(null);
  }, [setPendingApproval, updateTimelineEvent, currentThreadId]);

  const isEmpty = messages.length === 0;

  return (
    <div
      className={`h-full flex flex-col bg-chat-bg ${isDetached ? "" : "border-l border-border"}`}
    >
      {/* Header with New Chat and History buttons */}
      <ChatHeader
        onNewChat={handleNewChat}
        onOpenHistory={() => setIsHistoryOpen(true)}
      />

      {/* Chat Content */}
      {isEmpty ? (
        <WorkspaceAwareEmptyState
          mode="chat"
          rootPath={rootPath}
          onSelectPrompt={setInputContent}
        />
      ) : (
        <ChatMessages
          messages={messages}
          pendingApproval={pendingApproval}
          onApprovePending={handleApprove}
          onRejectPending={handleReject}
          onApprovePendingRemember={handleApproveRemember}
        />
      )}

      <ChatInput onSend={handleSend} disabled={isLoading} />

      {/* Thread History Modal */}
      <ThreadHistory
        isOpen={isHistoryOpen}
        onClose={() => setIsHistoryOpen(false)}
      />
    </div>
  );
};
