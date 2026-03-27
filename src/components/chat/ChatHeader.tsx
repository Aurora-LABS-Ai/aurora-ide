/**
 * Chat Header - Thread title bar with context info
 */

import React from "react";
import {
  Plus,
  History,
  Sparkles,
  MessageSquare,
  Zap,
  Maximize2,
} from "lucide-react";
import { StreamingDotMatrix } from "../ui/StreamingDotMatrix";
import { useThreadStore } from "../../store/useThreadStore";
import { useChatStore } from "../../store/useChatStore";
import { useContextStore } from "../../store/useContextStore";
import { useUiStore } from "../../store/useUiStore";

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

// Agent Mode Toggle Button
const AgentModeToggle: React.FC<{ buttonStyle: React.CSSProperties }> = ({
  buttonStyle,
}) => {
  const { toggleAgentMode } = useUiStore();

  return (
    <button
      onClick={toggleAgentMode}
      className="flex h-7 w-7 items-center justify-center rounded-[10px] text-text-secondary transition-all duration-200 hover:text-primary hover:bg-primary/10"
      style={buttonStyle}
      title="Agent Mode - Full Screen Chat"
    >
      <Maximize2 className="w-3.5 h-3.5" />
    </button>
  );
};

interface ChatHeaderProps {
  onNewChat: () => void;
  onOpenHistory: () => void;
}

export const ChatHeader: React.FC<ChatHeaderProps> = ({
  onNewChat,
  onOpenHistory,
}) => {
  const { currentThreadId, threads } = useThreadStore();
  const { isLoading } = useChatStore();
  const {
    usagePercentage,
    usedContextTokens,
    contextWindow,
    isOverLimit,
    totalTurns,
    summarizedTurns,
    needsSummarization,
  } = useContextStore();

  // Get theme colors at render time
  const contextColors = getContextColors();

  const currentThread = currentThreadId ? threads[currentThreadId] : null;
  const hasMessages = currentThread && currentThread.messages.length > 0;
  const title = hasMessages ? currentThread.title : "New Chat";

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

  const headerButtonStyle: React.CSSProperties = {
    backgroundColor:
      "color-mix(in srgb, var(--aurora-common-secondary) 74%, var(--aurora-title-bar-background) 26%)",
    border:
      "1px solid color-mix(in srgb, var(--aurora-common-border) 58%, transparent)",
    boxShadow: `
      inset 0 1px 0 color-mix(in srgb, var(--aurora-common-primary-foreground) 4%, transparent),
      inset 0 -1px 0 color-mix(in srgb, var(--aurora-common-shadow) 8%, transparent)
    `,
  };

  return (
    <div className="relative shrink-0 z-10">
      <div
        className="relative flex items-center justify-between gap-3 border-b px-4 py-2.5 backdrop-blur-md"
        style={{
          background: `linear-gradient(
            to bottom,
            color-mix(in srgb, var(--aurora-title-bar-background) 82%, var(--aurora-chat-background) 18%) 0%,
            color-mix(in srgb, var(--aurora-title-bar-background) 62%, transparent) 58%,
            color-mix(in srgb, var(--aurora-chat-background) 18%, transparent) 100%
          )`,
          borderColor:
            "color-mix(in srgb, var(--aurora-common-border) 72%, transparent)",
          boxShadow:
            "inset 0 1px 0 color-mix(in srgb, var(--aurora-common-primary-foreground) 4%, transparent)",
        }}
      >
        {/* Left side - Title & Info */}
        <div className="relative flex items-center gap-2.5 min-w-0 flex-1">
          {/* Icon */}
          <div
            className="relative flex h-7 w-7 shrink-0 items-center justify-center rounded-[10px]"
            style={headerButtonStyle}
          >
            {isLoading ? (
              <StreamingDotMatrix className="text-primary" size={14} />
            ) : hasMessages ? (
              <MessageSquare className="w-3.5 h-3.5 text-primary" />
            ) : (
              <Sparkles className="w-3.5 h-3.5 text-primary" />
            )}
          </div>

          {/* Title & Meta */}
          <div className="min-w-0 flex-1">
            <h2 className="text-[12px] font-semibold text-text-primary truncate leading-tight">
              {title}
            </h2>
            {hasMessages && (
              <div className="flex items-center gap-2 mt-0.5">
                {/* Turn count */}
                {totalTurns > 0 && (
                  <span className="text-[9px] text-text-disabled">
                    {totalTurns} turn{totalTurns !== 1 ? "s" : ""}
                  </span>
                )}

                {/* Summarized indicator */}
                {summarizedTurns > 0 && (
                  <>
                    <span className="text-[9px] text-text-disabled">|</span>
                    <span
                      className="flex items-center gap-0.5 text-[9px]"
                      style={{ color: contextColors.low }}
                      title={`${summarizedTurns} turn(s) summarized to save context`}
                    >
                      <Zap size={8} />
                      {summarizedTurns}
                    </span>
                  </>
                )}

                {/* Token usage */}
                {usedContextTokens > 0 && (
                  <>
                    <span className="text-[9px] text-text-disabled">|</span>
                    <span
                      className="text-[9px] font-mono"
                      style={{ color: getUsageColor() }}
                      title={
                        needsSummarization
                          ? "Summarization recommended"
                          : `${usagePercentage}% of context used`
                      }
                    >
                      {formatTokens(usedContextTokens)}/
                      {formatTokens(contextWindow)}
                    </span>
                  </>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Right side - Actions */}
        <div className="relative flex items-center gap-1 shrink-0">
          <button
            onClick={onOpenHistory}
            className="flex h-7 w-7 items-center justify-center rounded-[10px] text-text-secondary transition-all duration-200 hover:text-text-primary hover:bg-input/50"
            style={headerButtonStyle}
            title="Chat History (Ctrl+H)"
          >
            <History className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={onNewChat}
            className="flex h-7 w-7 items-center justify-center rounded-[10px] text-primary transition-all duration-200 hover:bg-primary/20"
            style={{
              ...headerButtonStyle,
              backgroundColor:
                "color-mix(in srgb, var(--aurora-common-primary) 10%, var(--aurora-common-secondary))",
              border:
                "1px solid color-mix(in srgb, var(--aurora-common-primary) 18%, transparent)",
            }}
            title="New Chat"
          >
            <Plus className="w-4 h-4" />
          </button>
          <AgentModeToggle buttonStyle={headerButtonStyle} />
        </div>
      </div>
    </div>
  );
};
