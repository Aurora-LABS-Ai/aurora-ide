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

import React, { useCallback, useEffect, useState } from "react";
import { ChatMessages } from "./ChatMessages";
import { ChatInput } from "./ChatInput";
import { ChatHeader } from "./ChatHeader";
import { ThreadHistory } from "./ThreadHistory";
import { WorkspaceAwareEmptyState } from "./WorkspaceAwareEmptyState";
import { useChatStore } from "../../store/useChatStore";
import { useThreadStore } from "../../store/useThreadStore";
import { useWorkspaceStore } from "../../store/useWorkspaceStore";
import { useContextStore } from "../../store/useContextStore";
import { useCheckpointStore } from "../../store/useCheckpointStore";
import { chatSyncBroadcast } from "../../hooks/useRustChatSync";
import { useMcpStore } from "../../store/useMcpStore";
import { useAgentSend } from "../../hooks/useAgentSend";

// Auto-load MCP servers once per session — every native tool now
// dispatches in Rust, so the only "executors" we still wire are the
// MCP servers (their tools round-trip through the frontend bridge in
// `agent-runtime-client::dispatchToolPending`).
let executorsInitialized = false;
const initExecutors = () => {
  if (!executorsInitialized) {
    useMcpStore.getState().loadServers();
    executorsInitialized = true;
  }
};

interface ChatPanelProps {
  isDetached?: boolean;
}

export const ChatPanel: React.FC<ChatPanelProps> = ({ isDetached = false }) => {
  const isLoading = useChatStore((state) => state.isLoading);
  const pendingApproval = useChatStore((state) => state.pendingApproval);
  const setInputContent = useChatStore((state) => state.setInputContent);

  const currentThreadId = useThreadStore((state) => state.currentThreadId);
  const threads = useThreadStore((state) => state.threads);
  const clearCurrentThread = useThreadStore((state) => state.clearCurrentThread);

  const rootPath = useWorkspaceStore((state) => state.rootPath);

  const [isHistoryOpen, setIsHistoryOpen] = useState(false);

  // Single source of truth for the send pipeline (used by both
  // ChatPanel and AgentModeLayout — see `useAgentSend.ts` for why this
  // was extracted).
  const { handleSend, handleApprove, handleApproveRemember, handleReject } =
    useAgentSend();

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
