import React from 'react';
import { Plus, History, Loader2 } from 'lucide-react';
import { useThreadStore } from '../../store/useThreadStore';
import { useChatStore } from '../../store/useChatStore';

interface ChatHeaderProps {
  onNewChat: () => void;
  onOpenHistory: () => void;
}

export const ChatHeader: React.FC<ChatHeaderProps> = ({ onNewChat, onOpenHistory }) => {
  const { currentThreadId, threads } = useThreadStore();
  const { isLoading } = useChatStore();
  
  const currentThread = currentThreadId ? threads[currentThreadId] : null;
  const hasMessages = currentThread && currentThread.messages.length > 0;
  const title = hasMessages ? currentThread.title : 'New Chat';

  return (
    <div className="h-9 px-3 flex items-center justify-between border-b border-border bg-panel-header shrink-0">
      {/* Title */}
      <div className="flex items-center gap-2 min-w-0">
        {isLoading && (
          <Loader2 className="w-3 h-3 text-primary animate-spin shrink-0" />
        )}
        <h2 className="text-[12px] font-medium text-text-primary truncate">
          {title}
        </h2>
      </div>

      {/* Actions */}
      <div className="flex items-center gap-0.5 shrink-0">
        <button
          onClick={onOpenHistory}
          className="p-1.5 rounded text-text-secondary hover:text-text-primary hover:bg-input transition-colors"
          title="Chat History (Ctrl+H)"
        >
          <History className="w-3.5 h-3.5" />
        </button>
        <button
          onClick={onNewChat}
          className="p-1.5 rounded text-text-secondary hover:text-primary hover:bg-primary/10 transition-colors"
          title="New Chat"
        >
          <Plus className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
};
