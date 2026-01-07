/**
 * Chat Header - Thread title bar with context info
 */

import React from 'react';
import { Plus, History, Loader2, Sparkles, MessageSquare, Zap } from 'lucide-react';
import { useThreadStore } from '../../store/useThreadStore';
import { useChatStore } from '../../store/useChatStore';
import { useContextStore } from '../../store/useContextStore';

const CONTEXT_COLORS = {
  low: '#a3e635',
  medium: '#fbbf24',
  high: '#f87171',
};

interface ChatHeaderProps {
  onNewChat: () => void;
  onOpenHistory: () => void;
}

export const ChatHeader: React.FC<ChatHeaderProps> = ({ onNewChat, onOpenHistory }) => {
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

  const currentThread = currentThreadId ? threads[currentThreadId] : null;
  const hasMessages = currentThread && currentThread.messages.length > 0;
  const title = hasMessages ? currentThread.title : 'New Chat';

  const getContextColor = () => {
    if (isOverLimit || usagePercentage >= 80) return CONTEXT_COLORS.high;
    if (usagePercentage >= 30) return CONTEXT_COLORS.medium;
    return CONTEXT_COLORS.low;
  };

  const formatTokens = (n: number) => {
    if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
    if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
    return n.toLocaleString();
  };

  return (
    <div className="relative shrink-0 z-10">
      <div className="relative flex items-center justify-between gap-3 px-4 py-3 bg-gradient-to-b from-sidebar to-transparent backdrop-blur-sm">

        {/* Left side - Title & Info */}
        <div className="relative flex items-center gap-2.5 min-w-0 flex-1">
          {/* Icon */}
          <div className="relative flex items-center justify-center w-7 h-7 rounded-md bg-gradient-to-br from-primary/10 to-transparent border border-white/5 shrink-0">
            {isLoading ? (
              <Loader2 className="w-3.5 h-3.5 text-primary animate-spin" />
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
                    {totalTurns} turn{totalTurns !== 1 ? 's' : ''}
                  </span>
                )}
                
                {/* Summarized indicator */}
                {summarizedTurns > 0 && (
                  <>
                    <span className="text-[9px] text-text-disabled">|</span>
                    <span 
                      className="flex items-center gap-0.5 text-[9px]"
                      style={{ color: CONTEXT_COLORS.low }}
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
                      style={{ color: getContextColor() }}
                      title={needsSummarization ? 'Summarization recommended' : `${usagePercentage}% of context used`}
                    >
                      {formatTokens(usedContextTokens)}/{formatTokens(contextWindow)}
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
            className="flex items-center justify-center w-7 h-7 rounded-md text-text-secondary hover:text-text-primary hover:bg-white/5 border border-transparent hover:border-border/50 transition-all duration-200"
            title="Chat History (Ctrl+H)"
          >
            <History className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={onNewChat}
            className="flex items-center justify-center w-7 h-7 rounded-md text-primary bg-primary/10 hover:bg-primary/20 border border-white/5 hover:border-white/10 transition-all duration-200"
            title="New Chat"
          >
            <Plus className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
};
