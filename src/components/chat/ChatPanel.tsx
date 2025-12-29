import React, { useRef, useCallback, useState, useEffect } from "react";
import { Search, Bug, Sparkles, TestTube } from 'lucide-react';
import { ChatHistory } from "./ChatHistory";
import { ChatInput, type AttachedFile } from "./ChatInput";
import { ChatHeader } from "./ChatHeader";
import { ThreadHistory } from "./ThreadHistory";
import { ToolApprovalBanner } from "./ToolApprovalBanner";
import { useChatStore } from "../../store/useChatStore";
import { useThreadStore } from "../../store/useThreadStore";
import { useSettingsStore } from "../../store/useSettingsStore";
import { useWorkspaceStore } from "../../store/useWorkspaceStore";
import { useContextStore } from "../../store/useContextStore";
import { useAuditStore } from "../../store/useAuditStore";
import { getAgentService, type ProviderConfig } from "../../services";
import { estimateTokens, estimateToolsTokens } from "../../services/token-estimator";
import { toolRegistry } from "../../tools";
import { registerAllExecutors } from "../../tools";
import { buildQueryContext, getIDEContext } from "../../services/context-builder";
import { convertThreadToApiHistory } from "../../services/thread-converter";
import { chatSyncBroadcast } from "../../hooks/useRustChatSync";
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
    executorsInitialized = true;
  }
};

// Generate unique ID
const generateId = () => Math.random().toString(36).substr(2, 9);

interface ChatPanelProps {
  isDetached?: boolean;
}

export const ChatPanel: React.FC<ChatPanelProps> = ({ isDetached = false }) => {
  const { setLoading, isLoading, pendingApproval, setPendingApproval } =
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
    maxToolCallsPerRequest,
    getToolApproval,
    setToolApproval,
    getLLMConfig,
    selectedModel,
  } = useSettingsStore();

  // Get provider-specific settings (each model has its own characteristics)
  const llmConfig = getLLMConfig();
  // Get user's thinking toggle preference from settings
  const { thinkingEnabled: userThinkingEnabled } = useSettingsStore();
  // Combine: user wants thinking AND provider supports it
  const thinkingEnabled = userThinkingEnabled && (llmConfig?.supportsThinking ?? false);
  const temperature = llmConfig?.defaultTemperature ?? 1.0;
  const maxTokens = llmConfig?.defaultMaxTokens ?? llmConfig?.maxOutputTokens ?? 8192;

  const [isHistoryOpen, setIsHistoryOpen] = useState(false);
  const currentMessageIdRef = useRef<string | null>(null);
  const pendingToolCallRef = useRef<any>(null);
  const timelineRef = useRef<TimelineEvent[]>([]);

  // Get current thread messages
  const currentThread = currentThreadId ? threads[currentThreadId] : null;
  const messages = currentThread?.messages || [];

  // Initialize executors
  useEffect(() => {
    initExecutors();
  }, []);

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
    // Clear agent history for new chat
    const agent = getAgentService();
    agent.clearHistory();
    // Reset context usage tracking
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

  // Helper to update timeline event
  const updateTimelineEvent = useCallback(
    (eventId: string, updates: Partial<TimelineEvent>) => {
      timelineRef.current = timelineRef.current.map((e) =>
        e.id === eventId ? { ...e, ...updates } : e,
      );

      if (currentMessageIdRef.current) {
        updateMessageInThread(currentMessageIdRef.current, {
          timeline: [...timelineRef.current],
        });
      }
    },
    [updateMessageInThread],
  );

  // Helper to refresh file explorer after file operations
  const refreshFileExplorer = useCallback(() => {
    if (rootPath) {
      console.log("Refreshing file explorer for:", rootPath);
    }
    refreshDirectory();
  }, [rootPath, refreshDirectory]);

  const handleSend = useCallback(
    async (content: string, attachedFiles?: AttachedFile[]) => {
      // Reset timeline
      timelineRef.current = [];

      // Ensure we have a thread
      let threadId = currentThreadId;
      if (!threadId) {
        threadId = createThread();
      }

      // Build Cursor-style context with IDE state and attached files
      const ideContext = getIDEContext();
      const { formattedContext, filesWithContent, filesAsPathsOnly } = await buildQueryContext(
        content,
        attachedFiles,
        ideContext
      );

      // Log context info for debugging
      if (attachedFiles && attachedFiles.length > 0) {
        console.log(`[Context] ${filesWithContent.length} files with content, ${filesAsPathsOnly.length} as paths only`);
      }

      // Add user message (show original content to user, but send full context to AI)
      const displayContent = attachedFiles && attachedFiles.length > 0
        ? `[${attachedFiles.map(f => f.name).join(', ')}]\n\n${content}`
        : content;

      const userMessage: Message = {
        id: generateId(),
        sender: "user",
        content: displayContent,
        timestamp: Date.now(),
      };
      addMessageToThread(userMessage);

      setLoading(true);
      chatSyncBroadcast.setLoading(true);

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
        supportsVision: false,
        defaultTemperature: llmConfig.defaultTemperature,
        defaultMaxTokens: llmConfig.defaultMaxTokens,
        customHeaders: llmConfig.customHeaders,
        customParams: llmConfig.customParams,
      };

      // Get agent and set provider (enterprise system)
      const agent = getAgentService();
      agent.setProvider(providerConfig);

      // CRITICAL: Sync thread history to agent for conversation continuity
      // This enables the AI to remember previous messages when resuming a thread
      // We sync BEFORE adding the current user message (which happens in addMessageToThread above)
      if (currentThread?.messages && currentThread.messages.length > 0) {
        // Exclude the message we just added (it's the last one with our current timestamp)
        const previousMessages = currentThread.messages.filter(
          m => m.id !== userMessage.id
        );
        if (previousMessages.length > 0) {
          const apiHistory = convertThreadToApiHistory(previousMessages);
          agent.setHistory(apiHistory);
          console.log(`[ChatPanel] Thread history synced: ${previousMessages.length} UI messages → ${apiHistory.length} API messages`);
        }
      }

      // Update context store with provider limits
      const contextStore = useContextStore.getState();
      contextStore.setContextWindow(
        providerConfig.contextWindow,
        providerConfig.maxOutputTokens
      );

      // Get conversation history
      const conversationHistory = agent.getHistory();

      // Get all available tools for token estimation
      const availableTools = toolRegistry.getToolDefinitions();

      // Estimate FULL request context (system prompt + history + new message + tools)
      // This gives an accurate picture of what's being sent to the LLM
      const systemPromptTokens = estimateTokens(
        "Aurora system prompt (~2000 chars)", // Approximate system prompt
        'text'
      ) + 500; // Add buffer for system prompt

      // Simple token estimation for history - just count content
      let historyTokens = 0;
      for (const m of conversationHistory) {
        // Handle content that can be string or ContentBlock[]
        const contentStr = typeof m.content === 'string'
          ? m.content
          : (Array.isArray(m.content)
            ? m.content.map(b => 'text' in b ? b.text : '').join('')
            : '');
        historyTokens += estimateTokens(contentStr || '', 'mixed');
      }

      const newMessageTokens = estimateTokens(formattedContext, 'mixed');
      const toolsTokens = estimateToolsTokens(availableTools);

      const totalEstimatedTokens = systemPromptTokens + historyTokens + newMessageTokens + toolsTokens;

      console.log('[ChatPanel] Context estimation on send:', {
        systemPrompt: systemPromptTokens,
        history: historyTokens,
        newMessage: newMessageTokens,
        tools: toolsTokens,
        total: totalEstimatedTokens,
      });

      // Update context store with estimated context BEFORE sending
      contextStore.setEstimatedContext(totalEstimatedTokens);

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
          autoApproveTools,
          temperature,
          maxTokens,
          maxToolIterations: maxToolCallsPerRequest,
          getToolApproval,
        });

        await agent.chat(formattedContext, {
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

              try {
                newToolCall.args = JSON.parse(
                  toolCall.function.arguments || "{}",
                );
              } catch {
                newToolCall.args = { raw: toolCall.function.arguments };
              }

              addTimelineEvent({
                type: "tool",
                tool: newToolCall,
              });

              // Track file operations
              if (
                [
                  "file_create",
                  "file_write",
                  "file_delete",
                  "folder_create",
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

              try {
                parsedArgs = JSON.parse(rawArgs);
              } catch {
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
              description: `Execute ${toolName}`,
              riskLevel: toolName.startsWith('shell_') || toolName.includes('delete') ? 'high' : 'medium',
              status: "pending",
              parameters: JSON.parse(toolCall.function.arguments || "{}"),
            };

            pendingToolCallRef.current = { toolCall, resolve: null as any };

            return new Promise<boolean>((resolve) => {
              pendingToolCallRef.current.resolve = resolve;
              setPendingApproval(proposal);
            });
          },
          onToolExecutionStart: (toolCall) => {
            const toolName = toolCall.function.name;
            let parsedArgs = {};
            try {
              parsedArgs = JSON.parse(toolCall.function.arguments || '{}');
            } catch {
              parsedArgs = { raw: toolCall.function.arguments };
            }

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

            // Find tool event and update status
            const toolEvent = timelineRef.current.find(
              (e) => e.type === "tool" && e.tool?.id === toolCall.id,
            );
            if (toolEvent) {
              updateTimelineEvent(toolEvent.id, {
                tool: { ...toolEvent.tool!, status: "executing" },
              });
            }
          },
          onToolExecutionComplete: (toolCall, result) => {
            // Update audit store entry
            const auditId = auditEntryIds.get(toolCall.id);
            if (auditId) {
              const entry = auditStore.entries.find(e => e.id === auditId);
              const duration = entry ? Date.now() - entry.timestamp : undefined;
              auditStore.updateEntry(auditId, {
                status: 'executed',
                result: result.substring(0, 500), // Truncate for storage
                duration,
              });
            }

            // Find tool event and update status
            const toolEvent = timelineRef.current.find(
              (e) => e.type === "tool" && e.tool?.id === toolCall.id,
            );
            if (toolEvent) {
              updateTimelineEvent(toolEvent.id, {
                tool: { ...toolEvent.tool!, status: "complete", result },
              });
            }

            // Refresh file explorer after file operations
            if (hasFileOperation) {
              setTimeout(() => refreshFileExplorer(), 100);
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
                  ? finalMessage.content.map(b => 'text' in b ? (b as any).text : '').join('')
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
                  responseTokens += estimateTokens(event.content, 'mixed');
                } else if (event.type === 'thinking' && event.thinking) {
                  responseTokens += estimateTokens(event.thinking, 'mixed');
                } else if (event.type === 'tool' && event.tool?.result) {
                  responseTokens += estimateTokens(event.tool.result, 'json');
                }
              }
              // Add estimated response tokens to context
              const currentContext = contextStore.usedContextTokens;
              contextStore.setEstimatedContext(currentContext + responseTokens);
              console.log('[ChatPanel] Estimated response tokens (no API usage):', responseTokens);
            }
          },
          onError: (error) => {
            // Don't show error if request was cancelled by user
            const isCancelled = error.message === 'Request cancelled' ||
              error.name === 'AbortError' ||
              error.message.includes('aborted');

            if (!isCancelled) {
              addTimelineEvent({
                type: "content",
                content: `Error: ${error.message}`,
              });
            }

            if (currentThinkingEventId) {
              updateTimelineEvent(currentThinkingEventId, {
                isThinking: false,
              });
            }
          },
        });
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

        // If cancelled, mark any executing tools as cancelled
        if (isCancelled) {
          for (const event of timelineRef.current) {
            if (event.type === 'tool' && event.tool?.status === 'executing') {
              updateTimelineEvent(event.id, {
                tool: { ...event.tool, status: 'cancelled' as any },
              });
            }
          }
        }

        if (!isCancelled) {
          console.error("Chat error:", error);
          addTimelineEvent({
            type: "content",
            content: `Error: ${error instanceof Error ? error.message : "Unknown error"}`,
          });
        } else {
          console.log("[ChatPanel] Request cancelled by user");
        }
      } finally {
        setLoading(false);
        chatSyncBroadcast.setLoading(false);
        currentMessageIdRef.current = null;
      }
    },
    [
      currentThreadId,
      createThread,
      addMessageToThread,
      updateMessageInThread,
      setLoading,
      autoApproveTools,
      maxToolCallsPerRequest,
      getToolApproval,
      setPendingApproval,
      addTimelineEvent,
      updateTimelineEvent,
      refreshFileExplorer,
      getLLMConfig,
      selectedModel,
      // Provider-specific settings are derived from getLLMConfig/selectedModel
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
      let parsedArgs = {};
      try {
        parsedArgs = JSON.parse(pending.toolCall.function.arguments || '{}');
      } catch {
        parsedArgs = { raw: pending.toolCall.function.arguments };
      }

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
        });
      }
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
      className={`h-full flex flex-col bg-[#111111] ${isDetached ? "" : "border-l border-white/5"}`}
    >
      {/* Header with New Chat and History buttons */}
      <ChatHeader
        onNewChat={handleNewChat}
        onOpenHistory={() => setIsHistoryOpen(true)}
      />

      {/* Chat Content */}
      {isEmpty ? (
        <div className="flex-1 flex flex-col items-center justify-center px-6 relative overflow-hidden">
          {/* Ambient Background Gradient */}
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-64 h-64 bg-primary/5 rounded-full blur-[100px] pointer-events-none" />

          <div className="relative z-10 flex flex-col items-center max-w-sm w-full">
            <div className="w-20 h-20 mb-6 relative group cursor-default">
              <div className="absolute inset-0 bg-primary/20 rounded-2xl blur-xl group-hover:bg-primary/30 transition-all duration-500" />
              <img
                src="/app-icon.svg"
                alt="Aurora"
                className="relative z-10 w-full h-full drop-shadow-xl transform group-hover:scale-105 transition-transform duration-500"
              />
            </div>

            <h1 className="text-2xl font-bold text-white mb-2 tracking-tight">
              Aurora
            </h1>
            <p className="text-sm text-zinc-400 text-center mb-10 leading-relaxed max-w-[280px]">
              Your advanced AI engineering companion for complex tasks.
            </p>

            {/* Suggested prompts grid */}
            <div className="w-full grid grid-cols-1 gap-2.5">
              {[
                { Icon: Search, label: "Analyze Codebase", prompt: "Explain the architecture of this project", color: "text-blue-400" },
                { Icon: Bug, label: "Find Bugs", prompt: "Scan the current file for potential bugs", color: "text-red-400" },
                { Icon: Sparkles, label: "Generate Feature", prompt: "Create a new React component for...", color: "text-purple-400" },
                { Icon: TestTube, label: "Write Tests", prompt: "Write unit tests for the selected code", color: "text-emerald-400" },
              ].map(({ Icon, label, prompt, color }, i) => (
                <button
                  key={i}
                  onClick={() => {
                    const input = document.querySelector('textarea[placeholder*="Message"]') as HTMLTextAreaElement;
                    if (input) {
                      input.value = prompt;
                      input.dispatchEvent(new Event('input', { bubbles: true }));
                      input.focus();
                    }
                  }}
                  className="group flex items-center gap-3 px-3 py-2.5 text-left bg-white/[0.03] hover:bg-white/[0.06] border border-white/5 hover:border-white/10 rounded-xl transition-all duration-200"
                >
                  <div className={`p-1.5 rounded-lg bg-white/5 group-hover:bg-white/10 transition-colors ${color}`}>
                    <Icon size={14} strokeWidth={2.5} />
                  </div>
                  <span className="text-[13px] font-medium text-zinc-300 group-hover:text-white transition-colors">
                    {label}
                  </span>
                </button>
              ))}
            </div>
          </div>
        </div>
      ) : (
        <ChatHistory messages={messages} />
      )}

      {/* Tool Approval Banner */}
      {pendingApproval && (
        <ToolApprovalBanner
          proposal={pendingApproval}
          onApprove={handleApprove}
          onReject={handleReject}
          onApproveRemember={handleApproveRemember}
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
