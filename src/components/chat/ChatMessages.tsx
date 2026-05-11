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

import React from "react";
import { ChatMessage } from "./ChatMessage";
import { useChatStore } from "../../store/useChatStore";
import { useSmoothAutoScroll } from "../../hooks/useSmoothAutoScroll";
import type { Message, ToolProposal } from "../../types";

interface ChatMessagesProps {
  messages: Message[];
  pendingApproval?: ToolProposal | null;
  onApprovePending?: () => void;
  onRejectPending?: () => void;
  onApprovePendingRemember?: () => void;
}

export const ChatMessages: React.FC<ChatMessagesProps> = ({
  messages,
  pendingApproval = null,
  onApprovePending,
  onRejectPending,
  onApprovePendingRemember,
}) => {
  const { isLoading } = useChatStore();
  const { containerRef, contentRef, bottomRef, jumpToBottom } =
    useSmoothAutoScroll({
      isStreaming: isLoading,
      initialScrollBehavior: "auto",
      bottomThreshold: 120,
      streamingFollowLerp: 0.22,
    });

  React.useEffect(() => {
    jumpToBottom();
  }, [jumpToBottom, messages.length]);

  return (
    <div
      ref={containerRef}
      className="flex-1 overflow-y-scroll overflow-x-hidden scrollbar-thin"
      style={{
        contain: "strict",
        scrollbarGutter: "stable both-edges",
        scrollBehavior: "smooth",
        overscrollBehavior: "contain",
        WebkitOverflowScrolling: "touch",
      }}
    >
      <div ref={contentRef} className="py-2">
        {messages.map((msg, index) => {
          // Group consecutive assistant messages under a single header —
          // see the comment in AgentModeLayout's matching block. Same
          // bug, same fix.
          const prev = index > 0 ? messages[index - 1] : undefined;
          const hideAssistantHeader =
            msg.sender === "assistant" && prev?.sender === "assistant";
          return (
            <ChatMessage
              key={msg.id}
              message={msg}
              isStreaming={isLoading}
              isLastMessage={index === messages.length - 1}
              hideAssistantHeader={hideAssistantHeader}
              pendingApproval={pendingApproval}
              onApprovePending={onApprovePending}
              onRejectPending={onRejectPending}
              onApprovePendingRemember={onApprovePendingRemember}
            />
          );
        })}
        <div ref={bottomRef} className="h-4" />
      </div>
    </div>
  );
};
