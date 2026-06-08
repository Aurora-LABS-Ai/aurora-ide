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

import React, { useCallback, useEffect, useState } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { Minimize2, Plus, History, PanelRightOpen } from "lucide-react";
import { StreamingDotMatrix } from "../ui/StreamingDotMatrix";
import { useUiStore } from "../../store/useUiStore";
import { useThreadStore } from "../../store/useThreadStore";
import { useChatStore } from "../../store/useChatStore";
import { useSmoothAutoScroll } from "../../hooks/useSmoothAutoScroll";
import { useAgentSend } from "../../hooks/useAgentSend";
import { useWorkspaceStore } from "../../store/useWorkspaceStore";
import { useContextStore } from "../../store/useContextStore";
import { useAuditStore } from "../../store/useAuditStore";
import { useCheckpointStore } from "../../store/useCheckpointStore";
import { useMcpStore } from "../../store/useMcpStore";
import { chatSyncBroadcast } from "../../hooks/useRustChatSync";
import { AgentChangesTree } from "./AgentChangesTree";
import { AgentInputArea } from "./AgentInputArea";
import { ChatMessage } from "../chat/ChatMessage";
import { ThreadHistory } from "../chat/ThreadHistory";
import { WorkspaceAwareEmptyState } from "../chat/WorkspaceAwareEmptyState";
import { AppIcon } from "../ui/AppIcon";

// Auto-load MCP servers on module load — every native tool now
// dispatches in Rust, so only MCP server connections need
// frontend-side bootstrap.
let executorsInitialized = false;
const initExecutors = () => {
  if (!executorsInitialized) {
    useMcpStore.getState().loadServers();
    executorsInitialized = true;
  }
};

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
  const toggleAgentMode = useUiStore((s) => s.toggleAgentMode);
  const isLoading = useChatStore((s) => s.isLoading);
  const pendingApproval = useChatStore((s) => s.pendingApproval);
  const setInputContent = useChatStore((s) => s.setInputContent);

  const currentThreadId = useThreadStore((s) => s.currentThreadId);
  const threads = useThreadStore((s) => s.threads);
  const clearCurrentThread = useThreadStore((s) => s.clearCurrentThread);

  const rootPath = useWorkspaceStore((s) => s.rootPath);

  const [isHistoryOpen, setIsHistoryOpen] = useState(false);
  // Track the user's preference for the changes panel separately from
  // whether there are any changes at all. The panel/toggle only appear
  // when both: (a) the agent has actually touched files for the current
  // thread, AND (b) the user hasn't explicitly hidden it.
  const [isChangesPanelVisible, setIsChangesPanelVisible] = useState(true);

  // Single source of truth for the send pipeline.
  const { handleSend, handleApprove, handleApproveRemember, handleReject } =
    useAgentSend();

  // ───────────────────────────────────────────────────────────────────
  // Show the agent-changes panel ONLY when the agent has actually
  // modified files in the current thread.
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

  const showChangesPanel = hasAgentFileChanges && isChangesPanelVisible;
  const showChangesToggle = hasAgentFileChanges && !isChangesPanelVisible;

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
                    {messages.map((msg, index) => {
                      // Suppress the avatar/header on every assistant
                      // message that follows another assistant message —
                      // the rehydration path produces one Message per
                      // tool-loop iteration, and we want them to render
                      // as a single grouped bubble (matches live
                      // streaming, which writes everything into one
                      // Message's timeline).
                      const prev = index > 0 ? messages[index - 1] : undefined;
                      const hideAssistantHeader =
                        msg.sender === "assistant" &&
                        prev?.sender === "assistant";
                      return (
                        <ChatMessage
                          key={msg.id}
                          message={msg}
                          isStreaming={isLoading}
                          isLastMessage={index === messages.length - 1}
                          toolVariant="timeline"
                          hideAssistantHeader={hideAssistantHeader}
                          pendingApproval={pendingApproval}
                          onApprovePending={handleApprove}
                          onRejectPending={handleReject}
                          onApprovePendingRemember={handleApproveRemember}
                        />
                      );
                    })}
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
              the panel. */}
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
            files AND the user collapsed the panel. */}
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
