/**
 * Chat Header — slim, professional thread title bar.
 *
 * Buttons are wrapperless at idle: no border, no background, just the icon.
 * Hover applies a subtle primary tint (theme-driven). The "New Chat" button
 * keeps a faint primary tint at idle so the primary action stands out
 * without dominating the header. All chrome is driven by CSS variables.
 */

import React from "react";
import { Plus, History, Maximize2 } from "lucide-react";
import { StreamingDotMatrix } from "../ui/StreamingDotMatrix";
import { useThreadStore } from "../../store/useThreadStore";
import { useChatStore } from "../../store/useChatStore";
import { useContextStore } from "../../store/useContextStore";
import { useUiStore } from "../../store/useUiStore";
import { AppIcon } from "../ui/AppIcon";

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

interface HeaderIconButtonProps {
  onClick: () => void;
  title: string;
  variant?: "ghost" | "primary";
  children: React.ReactNode;
}

const HeaderIconButton: React.FC<HeaderIconButtonProps> = ({
  onClick,
  title,
  variant = "ghost",
  children,
}) => {
  const isPrimary = variant === "primary";
  return (
    <button
      onClick={onClick}
      title={title}
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
          e.currentTarget.style.color = "var(--aurora-common-muted-foreground)";
        }
      }}
    >
      {children}
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
  const { toggleAgentMode } = useUiStore();
  const {
    usagePercentage,
    usedContextTokens,
    contextWindow,
    isOverLimit,
    totalTurns,
    summarizedTurns,
    needsSummarization,
  } = useContextStore();

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

  return (
    <div className="relative shrink-0 z-10">
      <div
        className="relative flex h-9 items-center justify-between gap-2 border-b px-3"
        style={{
          background:
            "color-mix(in srgb, var(--aurora-title-bar-background) 78%, var(--aurora-chat-background) 22%)",
          borderColor:
            "color-mix(in srgb, var(--aurora-common-border) 70%, transparent)",
        }}
      >
        {/* Left side - Title & Info */}
        <div className="flex items-center gap-2 min-w-0 flex-1">
          {/* Status icon — wrapperless */}
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

          {/* Title & Meta — single-line layout for max compactness */}
          <div className="min-w-0 flex-1 flex items-center gap-2">
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
        <div className="flex items-center gap-0.5 shrink-0">
          <HeaderIconButton
            onClick={onOpenHistory}
            title="Chat history (Ctrl+H)"
          >
            <AppIcon icon={History} size={13} />
          </HeaderIconButton>
          <HeaderIconButton
            onClick={onNewChat}
            title="New chat"
            variant="primary"
          >
            <AppIcon icon={Plus} size={14} />
          </HeaderIconButton>
          <HeaderIconButton
            onClick={toggleAgentMode}
            title="Agent Mode — full-screen chat"
          >
            <AppIcon icon={Maximize2} size={13} />
          </HeaderIconButton>
        </div>
      </div>
    </div>
  );
};
