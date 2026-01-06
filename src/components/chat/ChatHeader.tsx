/**
 * Chat Header - Styled thread title bar with actions
 */

import React from 'react';
import { Plus, History, Loader2, Sparkles, MessageSquare } from 'lucide-react';
import { useThreadStore } from '../../store/useThreadStore';
import { useChatStore } from '../../store/useChatStore';
import { useContextStore } from '../../store/useContextStore';

interface ChatHeaderProps {
  onNewChat: () => void;
  onOpenHistory: () => void;
}

export const ChatHeader: React.FC<ChatHeaderProps> = ({ onNewChat, onOpenHistory }) => {
  const { currentThreadId, threads } = useThreadStore();
  const { isLoading } = useChatStore();
  const { usagePercentage } = useContextStore();

  const currentThread = currentThreadId ? threads[currentThreadId] : null;
  const hasMessages = currentThread && currentThread.messages.length > 0;
  const title = hasMessages ? currentThread.title : 'New Chat';
  const messageCount = currentThread?.messages.length || 0;

  return (
    <div className="relative shrink-0 z-10">
      {/* Main header card */}
      <div className="relative flex items-center justify-between gap-3 px-4 py-3 bg-gradient-to-b from-sidebar to-transparent backdrop-blur-sm">

        {/* Left side - Title & Info */}
        <div className="relative flex items-center gap-2.5 min-w-0 flex-1">
          {/* Icon/Avatar */}
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
                <span className="text-[9px] text-text-disabled">
                  {messageCount} message{messageCount !== 1 ? 's' : ''}
                </span>
                {usagePercentage > 0 && (
                  <>
                    <span className="text-[9px] text-text-disabled">•</span>
                    <span className={`text-[9px] ${usagePercentage > 80 ? 'text-amber-400' : 'text-text-disabled'}`}>
                      {Math.round(usagePercentage)}% context
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
