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

import React, { useRef, useCallback, useState, useEffect } from 'react';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { Minimize2, Plus, History, Loader2, Sparkles, MessageSquare, Zap } from 'lucide-react';
import { useUiStore } from '../../store/useUiStore';
import { useThreadStore, setStreamingState } from '../../store/useThreadStore';
import { useChatStore } from '../../store/useChatStore';
import { useSettingsStore } from '../../store/useSettingsStore';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { useContextStore } from '../../store/useContextStore';
import { useAuditStore } from '../../store/useAuditStore';
import { useCheckpointStore } from '../../store/useCheckpointStore';
import { useTaskStore } from '../../store/useTaskStore';
import { useMcpStore } from '../../store/useMcpStore';
import { getAgentService, type ProviderConfig } from '../../services';
import { tokenService } from '../../services/token-service';
import { toolRegistry } from '../../tools';
import { registerAllExecutors } from '../../tools';
import { buildQueryContext, getIDEContext, getIDEContextLight } from '../../services/context-builder';
import { chatSyncBroadcast } from '../../hooks/useRustChatSync';
import { AgentChangesTree } from './AgentChangesTree';
import { AgentInputArea, type AttachedFile } from './AgentInputArea';
import { ChatMessage } from '../chat/ChatMessage';
import { ThreadHistory } from '../chat/ThreadHistory';
import { ToolApprovalBanner } from '../chat/ToolApprovalBanner';
import type { ToolProposal, ToolCall, Message, TimelineEvent } from '../../types';

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
  if (typeof window === 'undefined') return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
  return value || fallback;
};

const getContextColors = () => ({
  low: getContextColor('--aurora-chat-usage-low', '#22d3ee'),
  medium: getContextColor('--aurora-chat-usage-medium', '#facc15'),
  high: getContextColor('--aurora-chat-usage-high', '#ef4444'),
});

export const AgentModeLayout: React.FC = () => {
  const { toggleAgentMode } = useUiStore();
  const { setLoading, isLoading, pendingApproval, setPendingApproval } = useChatStore();
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
  const { thinkingEnabled: userThinkingEnabled } = useSettingsStore();
  const llmConfig = getLLMConfig();
  const thinkingEnabled = userThinkingEnabled && (llmConfig?.supportsThinking ?? false);
  const temperature = llmConfig?.defaultTemperature ?? 1.0;
  const maxTokens = llmConfig?.defaultMaxTokens ?? llmConfig?.maxOutputTokens ?? 8192;

  const [isHistoryOpen, setIsHistoryOpen] = useState(false);
  const currentMessageIdRef = useRef<string | null>(null);
  const pendingToolCallRef = useRef<any>(null);
  const timelineRef = useRef<TimelineEvent[]>([]);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Context tracking
  const {
    usagePercentage,
    usedContextTokens,
    contextWindow,
    isOverLimit,
    totalTurns,
    summarizedTurns,
    needsSummarization: _needsSummarization,
  } = useContextStore();
  const contextColors = getContextColors();

  // Get current thread messages
  const currentThread = currentThreadId ? threads[currentThreadId] : null;
  const messages = currentThread?.messages || [];
  const hasMessages = messages.length > 0;
  const title = hasMessages ? currentThread?.title || 'Chat' : 'New Chat';

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
    if (bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, isLoading]);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        toggleAgentMode();
      } else if (e.ctrlKey && e.key === 'h') {
        e.preventDefault();
        setIsHistoryOpen(true);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [toggleAgentMode]);

  const handleNewChat = useCallback(() => {
    useContextStore.getState().reset();
    clearCurrentThread();
    chatSyncBroadcast.clear();
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
    (event: Omit<TimelineEvent, 'id' | 'timestamp'>) => {
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
    [updateMessageInThread]
  );

  const updateTimelineEvent = useCallback(
    (eventId: string, updates: Partial<TimelineEvent>, immediate = false) => {
      timelineRef.current = timelineRef.current.map((e) =>
        e.id === eventId ? { ...e, ...updates } : e
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
    [updateMessageInThread, flushTimelineUpdate]
  );

  const refreshFileExplorer = useCallback(() => {
    if (rootPath) {
      console.log('Refreshing file explorer for:', rootPath);
    }
    refreshDirectory();
  }, [rootPath, refreshDirectory]);

  // Handle send (reusing ChatPanel logic)
  const handleSend = useCallback(
    async (content: string, attachedFiles?: AttachedFile[]) => {
      timelineRef.current = [];
      let threadId = currentThreadId;
      let isNewThread = false;
      const threadExists = threadId && threads[threadId];

      if (!threadId || !threadExists) {
        useTaskStore.getState().clearTasks();
        threadId = createThread();
        isNewThread = true;
      }

      const displayContent =
        attachedFiles && attachedFiles.length > 0
          ? `[${attachedFiles.map((f) => f.name).join(', ')}]\n\n${content}`
          : content;

      const userMessage: Message = {
        id: generateId(),
        sender: 'user',
        content: displayContent,
        timestamp: Date.now(),
      };
      addMessageToThread(userMessage);

      if (rootPath && threadId) {
        await useCheckpointStore.getState().createCheckpoint(userMessage.id, threadId);
      }

      const isFirstMessage = isNewThread || !currentThread?.messages || currentThread.messages.length === 0;
      const projectLayoutEnabled = useSettingsStore.getState().projectLayoutEnabled;
      const shouldIncludeLayout = isFirstMessage && projectLayoutEnabled;
      const ideContext = shouldIncludeLayout ? getIDEContext(true) : getIDEContextLight();

      const { formattedContext } = await buildQueryContext(
        content,
        attachedFiles,
        ideContext
      );

      setLoading(true);
      chatSyncBroadcast.setLoading(true);
      setStreamingState(true);

      const llmConfig = getLLMConfig();
      if (!llmConfig) {
        const errorMessage: Message = {
          id: generateId(),
          sender: 'assistant',
          content: 'No models configured. Please add an API key in Settings.',
          timestamp: Date.now(),
        };
        addMessageToThread(errorMessage);
        setLoading(false);
        return;
      }

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

      const agent = getAgentService();
      agent.setProvider(providerConfig);
      agent.setThreadId(threadId!);

      const contextStore = useContextStore.getState();
      contextStore.setContextWindow(providerConfig.contextWindow, providerConfig.maxOutputTokens);

      const assistantMessageId = generateId();
      currentMessageIdRef.current = assistantMessageId;

      const assistantMessage: Message = {
        id: assistantMessageId,
        sender: 'assistant',
        content: '',
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
          autoApproveTools,
          temperature,
          maxTokens,
          maxToolIterations: maxToolCallsPerRequest,
          getToolApproval,
        });

        await agent.chat(formattedContext, {
          onToken: (token) => {
            if (currentThinkingEventId) {
              updateTimelineEvent(currentThinkingEventId, { isThinking: false });
              currentThinkingEventId = null;
            }
            if (!currentContentEventId) {
              currentContentEventId = addTimelineEvent({ type: 'content', content: token });
            } else {
              const existingEvent = timelineRef.current.find((e) => e.id === currentContentEventId);
              if (existingEvent) {
                updateTimelineEvent(currentContentEventId, {
                  content: (existingEvent.content || '') + token,
                });
              }
            }
          },
          onThinking: (thinking) => {
            if (!currentThinkingEventId) {
              currentThinkingEventId = addTimelineEvent({
                type: 'thinking',
                thinking: thinking,
                isThinking: true,
              });
            } else {
              const existingEvent = timelineRef.current.find((e) => e.id === currentThinkingEventId);
              if (existingEvent) {
                updateTimelineEvent(currentThinkingEventId, {
                  thinking: (existingEvent.thinking || '') + thinking,
                });
              }
            }
          },
          onToolCall: (toolCall) => {
            if (currentThinkingEventId) {
              updateTimelineEvent(currentThinkingEventId, { isThinking: false });
              currentThinkingEventId = null;
            }
            currentContentEventId = null;

            const existingToolEvent = timelineRef.current.find(
              (e) => e.type === 'tool' && e.tool?.id === toolCall.id
            );

            if (!existingToolEvent) {
              const newToolCall: ToolCall = {
                id: toolCall.id,
                name: toolCall.function.name,
                status: 'pending',
                args: {},
              };
              try {
                newToolCall.args = JSON.parse(toolCall.function.arguments || '{}');
              } catch {
                newToolCall.args = { raw: toolCall.function.arguments };
              }
              addTimelineEvent({ type: 'tool', tool: newToolCall });

              if (
                ['file_create', 'file_write', 'file_delete', 'folder_create', 'folder_delete'].includes(
                  toolCall.function.name
                )
              ) {
                hasFileOperation = true;
              }
            } else {
              const rawArgs = toolCall.function.arguments || '';
              let parsedArgs = existingToolEvent.tool!.args || {};
              try {
                parsedArgs = JSON.parse(rawArgs);
              } catch {}
              const updatedTool = { ...existingToolEvent.tool!, args: parsedArgs, rawArgs };
              updateTimelineEvent(existingToolEvent.id, { tool: updatedTool });
            }
          },
          onToolApprovalRequired: async (toolCall) => {
            const toolName = toolCall.function.name;
            const toolSetting = getToolApproval(toolName);
            if (toolSetting === 'auto') return true;
            if (toolSetting === 'deny') return false;

            const proposal: ToolProposal = {
              id: toolCall.id,
              toolName: toolName,
              description: `Execute ${toolName}`,
              riskLevel: toolName.startsWith('shell_') || toolName.includes('delete') ? 'high' : 'medium',
              status: 'pending',
              parameters: JSON.parse(toolCall.function.arguments || '{}'),
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
            const riskLevel = toolRegistry.getRiskLevel(toolName);
            const auditId = auditStore.addEntry({
              toolName,
              args: parsedArgs,
              status: 'executing',
              riskLevel,
              threadId: threadId || undefined,
            });
            auditEntryIds.set(toolCall.id, auditId);

            const toolEvent = timelineRef.current.find(
              (e) => e.type === 'tool' && e.tool?.id === toolCall.id
            );
            if (toolEvent) {
              updateTimelineEvent(toolEvent.id, { tool: { ...toolEvent.tool!, status: 'executing' } }, true);
            }
          },
          onToolExecutionComplete: (toolCall, result) => {
            const auditId = auditEntryIds.get(toolCall.id);
            if (auditId) {
              const entry = auditStore.entries.find((e) => e.id === auditId);
              const duration = entry ? Date.now() - entry.timestamp : undefined;
              auditStore.updateEntry(auditId, {
                status: 'executed',
                result: result.substring(0, 500),
                duration,
              });
            }

            const toolEvent = timelineRef.current.find(
              (e) => e.type === 'tool' && e.tool?.id === toolCall.id
            );
            if (toolEvent) {
              updateTimelineEvent(toolEvent.id, { tool: { ...toolEvent.tool!, status: 'complete', result } }, true);
            }
            if (hasFileOperation) {
              setTimeout(() => refreshFileExplorer(), 100);
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
              }
            );
          },
          onComplete: (finalMessage) => {
            const hasContentEvent = timelineRef.current.some((e) => e.type === 'content' && e.content);
            const hasToolCalls = timelineRef.current.some((e) => e.type === 'tool');

            if (currentThinkingEventId) {
              updateTimelineEvent(currentThinkingEventId, { isThinking: false });
              currentThinkingEventId = null;
            }

            if (finalMessage?.content && !hasContentEvent) {
              const contentStr =
                typeof finalMessage.content === 'string'
                  ? finalMessage.content
                  : Array.isArray(finalMessage.content)
                  ? finalMessage.content.map((b) => ('text' in b ? (b as any).text : '')).join('')
                  : '';
              if (contentStr) {
                addTimelineEvent({ type: 'content', content: contentStr });
              }
            } else if (!hasContentEvent && hasToolCalls) {
              const thinkingEvents = timelineRef.current.filter((e) => e.type === 'thinking' && e.thinking);
              if (thinkingEvents.length > 0) {
                const lastThinking = thinkingEvents[thinkingEvents.length - 1];
                const thinkingText = lastThinking.thinking!;
                if (thinkingText.length > 30) {
                  updateTimelineEvent(lastThinking.id, {
                    type: 'content',
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
                if (event.type === 'content' && event.content) {
                  responseTokens += tokenService.quickEstimate(event.content).tokens;
                } else if (event.type === 'thinking' && event.thinking) {
                  responseTokens += tokenService.quickEstimate(event.thinking).tokens;
                } else if (event.type === 'tool' && event.tool?.result) {
                  responseTokens += tokenService.quickEstimate(event.tool.result).tokens;
                }
              }
              const currentContext = contextStore.usedContextTokens;
              contextStore.setEstimatedContext(currentContext + responseTokens);
            }
          },
          onError: (error) => {
            const isCancelled =
              error.message === 'Request cancelled' ||
              error.name === 'AbortError' ||
              error.message.includes('aborted');
            if (!isCancelled) {
              addTimelineEvent({ type: 'content', content: `Error: ${error.message}` });
            }
            if (currentThinkingEventId) {
              updateTimelineEvent(currentThinkingEventId, { isThinking: false });
            }
          },
        });
      } catch (error) {
        const isCancelled =
          error instanceof Error &&
          (error.message === 'Request cancelled' ||
            error.name === 'AbortError' ||
            error.message.includes('aborted'));
        if (currentThinkingEventId) {
          updateTimelineEvent(currentThinkingEventId, { isThinking: false });
        }
        if (isCancelled) {
          for (const event of timelineRef.current) {
            if (event.type === 'tool' && event.tool?.status === 'executing') {
              updateTimelineEvent(event.id, { tool: { ...event.tool, status: 'cancelled' as any } });
            }
          }
        }
        if (!isCancelled) {
          console.error('Chat error:', error);
          addTimelineEvent({
            type: 'content',
            content: `Error: ${error instanceof Error ? error.message : 'Unknown error'}`,
          });
        }
      } finally {
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
      flushTimelineUpdate,
      refreshFileExplorer,
      getLLMConfig,
      selectedModel,
      rootPath,
    ]
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
    setToolApproval(pendingApproval.toolName, 'auto');
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
        (e) => e.type === 'tool' && e.tool?.id === pending.toolCall.id
      );
      if (toolEvent) {
        updateTimelineEvent(
          toolEvent.id,
          { tool: { ...toolEvent.tool!, status: 'rejected', result: 'User rejected this tool call.' } },
          true
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

  return (
    <div
      className="h-full flex flex-col"
      style={{ background: 'var(--aurora-editor-background)' }}
    >
      {/* Header */}
      <div
        className="h-10 px-4 flex items-center justify-between border-b shrink-0"
        style={{
          background: 'var(--aurora-titleBar-background)',
          borderColor: 'var(--aurora-common-border)',
        }}
      >
        {/* Left - Title */}
        <div className="flex items-center gap-2.5">
          {isLoading ? (
            <Loader2 className="w-4 h-4 animate-spin" style={{ color: 'var(--aurora-common-primary)' }} />
          ) : hasMessages ? (
            <MessageSquare className="w-4 h-4" style={{ color: 'var(--aurora-common-primary)' }} />
          ) : (
            <Sparkles className="w-4 h-4" style={{ color: 'var(--aurora-common-primary)' }} />
          )}
          <div>
            <h2
              className="text-sm font-semibold"
              style={{ color: 'var(--aurora-titleBar-foreground)' }}
            >
              {title}
            </h2>
            {hasMessages && (
              <div className="flex items-center gap-2 text-[10px]">
                {totalTurns > 0 && (
                  <span style={{ color: 'var(--aurora-common-mutedForeground)' }}>
                    {totalTurns} turn{totalTurns !== 1 ? 's' : ''}
                  </span>
                )}
                {summarizedTurns > 0 && (
                  <>
                    <span style={{ color: 'var(--aurora-common-mutedForeground)' }}>|</span>
                    <span style={{ color: contextColors.low }} className="flex items-center gap-0.5">
                      <Zap size={8} />
                      {summarizedTurns}
                    </span>
                  </>
                )}
                {usedContextTokens > 0 && (
                  <>
                    <span style={{ color: 'var(--aurora-common-mutedForeground)' }}>|</span>
                    <span className="font-mono" style={{ color: getUsageColor() }}>
                      {formatTokens(usedContextTokens)}/{formatTokens(contextWindow)}
                    </span>
                  </>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Right - Actions */}
        <div className="flex items-center gap-1">
          <button
            onClick={() => setIsHistoryOpen(true)}
            className="w-7 h-7 rounded-md flex items-center justify-center transition-all duration-200 hover:bg-white/5"
            style={{ 
              color: 'var(--aurora-common-mutedForeground)',
              border: '1px solid transparent',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.color = 'var(--aurora-titleBar-foreground)';
              e.currentTarget.style.borderColor = 'var(--aurora-common-border)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.color = 'var(--aurora-common-mutedForeground)';
              e.currentTarget.style.borderColor = 'transparent';
            }}
            title="Chat History (Ctrl+H)"
          >
            <History className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={handleNewChat}
            className="w-7 h-7 rounded-md flex items-center justify-center transition-all duration-200"
            style={{
              background: 'rgba(var(--aurora-common-primary-rgb, 6, 182, 212), 0.1)',
              color: 'var(--aurora-common-primary)',
              border: '1px solid rgba(255, 255, 255, 0.05)',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = 'rgba(var(--aurora-common-primary-rgb, 6, 182, 212), 0.2)';
              e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.1)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'rgba(var(--aurora-common-primary-rgb, 6, 182, 212), 0.1)';
              e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.05)';
            }}
            title="New Chat"
          >
            <Plus className="w-4 h-4" />
          </button>
          <button
            onClick={toggleAgentMode}
            className="w-7 h-7 rounded-md flex items-center justify-center transition-all duration-200 hover:bg-white/5"
            style={{ 
              color: 'var(--aurora-common-mutedForeground)',
              border: '1px solid transparent',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.color = 'var(--aurora-common-primary)';
              e.currentTarget.style.borderColor = 'rgba(var(--aurora-common-primary-rgb, 6, 182, 212), 0.2)';
              e.currentTarget.style.background = 'rgba(var(--aurora-common-primary-rgb, 6, 182, 212), 0.1)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.color = 'var(--aurora-common-mutedForeground)';
              e.currentTarget.style.borderColor = 'transparent';
              e.currentTarget.style.background = 'transparent';
            }}
            title="Exit Agent Mode (Esc)"
          >
            <Minimize2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 min-h-0">
        <PanelGroup direction="horizontal" id="agent-mode-panel-group">
          {/* Center - Chat */}
          <Panel id="agent-chat-panel" order={1} defaultSize={75} minSize={50}>
            <div
              className="h-full flex flex-col"
              style={{ background: 'var(--aurora-chat-background)' }}
            >
              {/* Messages Area */}
              {isEmpty ? (
                <div className="flex-1 flex flex-col items-center justify-center px-6">
                  <div className="flex flex-col items-center max-w-lg w-full">
                    <div className="w-20 h-20 mb-6">
                      <img
                        src="/app-icon.svg"
                        alt="Aurora"
                        className="w-full h-full"
                      />
                    </div>
                    <h1
                      className="text-2xl font-semibold mb-2 tracking-tight"
                      style={{ color: 'var(--aurora-editor-foreground)' }}
                    >
                      Aurora Agent
                    </h1>
                    <p
                      className="text-sm text-center leading-relaxed max-w-[320px]"
                      style={{ color: 'var(--aurora-common-mutedForeground)' }}
                    >
                      Your advanced AI engineering companion for complex tasks.
                    </p>
                  </div>
                </div>
              ) : (
                <div className="flex-1 min-h-0 overflow-y-auto px-4 md:px-8 lg:px-16 xl:px-24 scrollbar-thin">
                  <div className="max-w-4xl mx-auto py-6">
                    {messages.map((msg, index) => (
                      <ChatMessage
                        key={msg.id}
                        message={msg}
                        isStreaming={isLoading}
                        isLastMessage={index === messages.length - 1}
                        toolVariant="cards"
                      />
                    ))}
                    <div ref={bottomRef} className="h-4" />
                  </div>
                </div>
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

              {/* Input - Fixed at bottom, centered */}
              <div 
                className="shrink-0 px-4 md:px-8 lg:px-16 py-4"
                style={{ background: 'var(--aurora-chat-background)' }}
              >
                <AgentInputArea onSend={handleSend} disabled={isLoading} />
              </div>
            </div>
          </Panel>

          <PanelResizeHandle
            className="w-[1px] hover:w-1 transition-all"
            style={{ background: 'var(--aurora-common-border)' }}
          />

          {/* Right - File Changes */}
          <Panel id="agent-changes-panel" order={2} defaultSize={25} minSize={15} maxSize={40}>
            <AgentChangesTree />
          </Panel>
        </PanelGroup>
      </div>

      {/* Thread History Modal */}
      <ThreadHistory isOpen={isHistoryOpen} onClose={() => setIsHistoryOpen(false)} />
    </div>
  );
};

export default AgentModeLayout;
