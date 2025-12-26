import React, { useRef, useCallback, useState, useEffect } from "react";
import { ChatHistory } from "./ChatHistory";
import { ChatInput } from "./ChatInput";
import { ChatHeader } from "./ChatHeader";
import { ThreadHistory } from "./ThreadHistory";
import { ToolApprovalBanner } from "./ToolApprovalBanner";
import { useChatStore } from "../../store/useChatStore";
import { useThreadStore } from "../../store/useThreadStore";
import { useSettingsStore } from "../../store/useSettingsStore";
import { useWorkspaceStore } from "../../store/useWorkspaceStore";
import { getAgentService, initLLMProvider } from "../../services";
import { registerAllExecutors } from "../../tools";
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
    clearCurrentThread,
  } = useThreadStore();

  const { refreshDirectory, rootPath } = useWorkspaceStore();

  const {
    autoApproveTools,
    thinkingEnabled,
    temperature,
    maxTokens,
    maxToolCallsPerRequest,
    getToolApproval,
    setToolApproval,
    getLLMConfig,
    selectedModel,
  } = useSettingsStore();

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
    // Don't create thread yet - just clear current
    clearCurrentThread();
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
    async (content: string) => {
      // Reset timeline
      timelineRef.current = [];

      // Ensure we have a thread
      let threadId = currentThreadId;
      if (!threadId) {
        threadId = createThread();
      }

      // Add user message
      const userMessage: Message = {
        id: generateId(),
        sender: "user",
        content,
        timestamp: Date.now(),
      };
      addMessageToThread(userMessage);

      setLoading(true);

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

      // Initialize LLM provider with current settings (including maxOutputTokens)
      initLLMProvider({
        baseUrl: llmConfig.baseUrl,
        apiKey: llmConfig.apiKey,
        model: llmConfig.model,
        maxOutputTokens: llmConfig.maxOutputTokens,
        contextWindow: llmConfig.contextWindow,
        supportsThinking: llmConfig.supportsThinking,
        supportsToolStream: llmConfig.supportsToolStream,
        customHeaders: llmConfig.customHeaders,
        customParams: llmConfig.customParams,
        providerType: llmConfig.providerType,
        defaultTemperature: llmConfig.defaultTemperature,
        defaultMaxTokens: llmConfig.defaultMaxTokens,
      });

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

      try {
        const agent = getAgentService();
        agent.updateConfig({
          thinkingEnabled,
          autoApproveTools,
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
              // Update existing tool call arguments
              try {
                const updatedTool = {
                  ...existingToolEvent.tool!,
                  args: JSON.parse(toolCall.function.arguments || "{}"),
                };
                updateTimelineEvent(existingToolEvent.id, {
                  tool: updatedTool,
                });
              } catch {
                // Arguments still streaming
              }
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
          onComplete: (finalMessage) => {
            // Check if we have any content in timeline
            const hasContentEvent = timelineRef.current.some(
              (e) => e.type === "content" && e.content,
            );

            // Check if we have tool calls (meaning this was a tool-using conversation)
            const hasToolCalls = timelineRef.current.some(
              (e) => e.type === "tool",
            );

            // Get the last timeline event
            const lastEvent =
              timelineRef.current[timelineRef.current.length - 1];

            // If we have final content from the API that wasn't streamed, add it
            if (finalMessage?.content && !hasContentEvent) {
              // Close thinking first
              if (currentThinkingEventId) {
                updateTimelineEvent(currentThinkingEventId, {
                  isThinking: false,
                });
                currentThinkingEventId = null;
              }
              addTimelineEvent({
                type: "content",
                content: finalMessage.content,
              });
            }
            // If no content but last event is thinking after tool calls,
            // convert the last thinking to content (DeepSeek behavior)
            else if (
              !hasContentEvent &&
              hasToolCalls &&
              lastEvent?.type === "thinking" &&
              lastEvent.thinking
            ) {
              // Check if it looks like a final response (not just reasoning)
              const thinkingText = lastEvent.thinking;
              const isFinalResponse =
                thinkingText.length > 50 &&
                (/^(Perfect|Great|Done|I've|The file|Here's|I have|Successfully|Based on|Now|So)/i.test(
                  thinkingText,
                ) ||
                  /created|completed|finished|summary|covers|contains/i.test(
                    thinkingText,
                  ));

              if (isFinalResponse) {
                // Convert this thinking event to content
                updateTimelineEvent(lastEvent.id, {
                  type: "content",
                  content: thinkingText,
                  thinking: undefined,
                  isThinking: false,
                });
                currentThinkingEventId = null;
              } else {
                // Just close the thinking block
                if (currentThinkingEventId) {
                  updateTimelineEvent(currentThinkingEventId, {
                    isThinking: false,
                  });
                  currentThinkingEventId = null;
                }
              }
            } else {
              // Just close any open thinking blocks
              if (currentThinkingEventId) {
                updateTimelineEvent(currentThinkingEventId, {
                  isThinking: false,
                });
                currentThinkingEventId = null;
              }
            }

            // Final refresh if there were file operations
            if (hasFileOperation) {
              refreshFileExplorer();
            }
          },
          onError: (error) => {
            // Add error as content
            addTimelineEvent({
              type: "content",
              content: `Error: ${error.message}`,
            });

            if (currentThinkingEventId) {
              updateTimelineEvent(currentThinkingEventId, {
                isThinking: false,
              });
            }
          },
        });
      } catch (error) {
        console.error("Chat error:", error);
        addTimelineEvent({
          type: "content",
          content: `Error: ${error instanceof Error ? error.message : "Unknown error"}`,
        });
      } finally {
        setLoading(false);
        currentMessageIdRef.current = null;
      }
    },
    [
      currentThreadId,
      createThread,
      addMessageToThread,
      updateMessageInThread,
      setLoading,
      thinkingEnabled,
      autoApproveTools,
      temperature,
      maxTokens,
      maxToolCallsPerRequest,
      getToolApproval,
      setPendingApproval,
      addTimelineEvent,
      updateTimelineEvent,
      refreshFileExplorer,
      getLLMConfig,
      selectedModel,
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
    if (pendingToolCallRef.current?.resolve) {
      pendingToolCallRef.current.resolve(false);
      pendingToolCallRef.current = null;
    }
    setPendingApproval(null);
  }, [setPendingApproval]);

  const isEmpty = messages.length === 0;

  return (
    <div
      className={`h-full flex flex-col bg-sidebar ${isDetached ? "" : "border-l border-border"}`}
    >
      {/* Header with New Chat and History buttons */}
      <ChatHeader
        onNewChat={handleNewChat}
        onOpenHistory={() => setIsHistoryOpen(true)}
      />

      {/* Chat Content */}
      {isEmpty ? (
        <div className="flex-1 flex flex-col items-center justify-center text-text-secondary px-4">
          <img 
            src="/app-icon.svg" 
            alt="Aurora" 
            className="w-16 h-16 mb-4"
          />
          <div className="text-lg font-medium text-text-primary mb-1">
            Aurora
          </div>
          <div className="text-xs text-text-disabled mb-6">
            AI-powered coding assistant
          </div>
          
          {/* Suggested prompts */}
          <div className="w-full max-w-sm space-y-2">
            <div className="text-[10px] uppercase tracking-wider text-text-disabled mb-2 text-center">
              Try asking
            </div>
            {[
              "Explain this codebase structure",
              "Find and fix bugs in the current file",
              "Create a new React component",
              "Write unit tests for selected code",
            ].map((prompt, i) => (
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
                className="w-full px-3 py-2 text-left text-xs text-text-secondary bg-input/30 hover:bg-input/50 rounded-lg border border-border/50 hover:border-border transition-colors"
              >
                {prompt}
              </button>
            ))}
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
