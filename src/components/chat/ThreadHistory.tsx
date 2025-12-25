import React, { useState, useMemo, useEffect } from 'react';
import { X, MessageSquare, Trash2, Search, Plus, Loader2 } from 'lucide-react';
import { useThreadStore, type ThreadSummary } from '../../store/useThreadStore';
import { DeleteConfirmDialog } from './DeleteConfirmDialog';
import clsx from 'clsx';

interface ThreadHistoryProps {
  isOpen: boolean;
  onClose: () => void;
}

const formatDate = (timestamp: number): string => {
  const date = new Date(timestamp);
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  
  // Less than 1 hour
  if (diff < 3600000) {
    const mins = Math.floor(diff / 60000);
    return mins <= 1 ? 'Just now' : `${mins}m`;
  }
  
  // Less than 24 hours
  if (diff < 86400000) {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  
  // Less than 7 days
  if (diff < 604800000) {
    const days = Math.floor(diff / 86400000);
    return days === 1 ? '1d' : `${days}d`;
  }
  
  // Otherwise show date
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
};

const ThreadItem: React.FC<{ 
  thread: ThreadSummary; 
  isActive: boolean;
  onSelect: () => void;
  onDelete: (e: React.MouseEvent) => void;
}> = ({ thread, isActive, onSelect, onDelete }) => {
  return (
    <div
      className={clsx(
        "group flex items-center gap-3 px-4 py-3 rounded-xl cursor-pointer transition-all",
        isActive 
          ? "bg-primary/15 border border-primary/30" 
          : "bg-input/50 hover:bg-input border border-transparent hover:border-border"
      )}
      onClick={onSelect}
    >
      {/* Icon */}
      <div className={clsx(
        "w-9 h-9 rounded-lg flex items-center justify-center shrink-0",
        isActive ? "bg-primary/20" : "bg-sidebar"
      )}>
        <MessageSquare className={clsx(
          "w-4 h-4",
          isActive ? "text-primary" : "text-text-secondary"
        )} />
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between gap-3">
          <h3 className={clsx(
            "text-[13px] font-medium truncate",
            isActive ? "text-primary" : "text-text-primary"
          )}>
            {thread.title || 'Untitled'}
          </h3>
          <span className="text-[11px] text-text-disabled shrink-0 font-mono">
            {formatDate(thread.updatedAt)}
          </span>
        </div>
        
        {thread.preview && (
          <p className="text-[12px] text-text-secondary truncate mt-1">
            {thread.preview}
          </p>
        )}
        
        <div className="flex items-center gap-2 mt-1.5">
          <span className="text-[10px] text-text-disabled bg-sidebar px-2 py-0.5 rounded-full">
            {thread.messageCount} messages
          </span>
        </div>
      </div>

      {/* Delete Button */}
      <button
        onClick={onDelete}
        className="p-2 rounded-lg opacity-0 group-hover:opacity-100 text-text-disabled hover:text-danger hover:bg-danger/10 transition-all shrink-0"
        title="Delete"
      >
        <Trash2 className="w-4 h-4" />
      </button>
    </div>
  );
};

export const ThreadHistory: React.FC<ThreadHistoryProps> = ({ isOpen, onClose }) => {
  const { 
    threadList, 
    currentThreadId, 
    loadThread, 
    deleteThread, 
    createThread,
    loadAllThreadsFromFiles,
    isLoading 
  } = useThreadStore();
  
  const [searchQuery, setSearchQuery] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<ThreadSummary | null>(null);

  // Load threads from files when modal opens
  useEffect(() => {
    if (isOpen) {
      loadAllThreadsFromFiles();
    }
  }, [isOpen, loadAllThreadsFromFiles]);

  // Filter threads based on search
  const filteredThreads = useMemo(() => {
    if (!searchQuery.trim()) return threadList;
    const query = searchQuery.toLowerCase();
    return threadList.filter(thread => 
      thread.title.toLowerCase().includes(query) ||
      thread.preview.toLowerCase().includes(query)
    );
  }, [threadList, searchQuery]);

  // Only show threads with messages
  const threadsWithMessages = useMemo(() => {
    return filteredThreads.filter(t => t.messageCount > 0);
  }, [filteredThreads]);

  // Keyboard shortcut: Escape to close
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen && !deleteTarget) {
        onClose();
      }
    };
    
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose, deleteTarget]);

  const handleNewChat = () => {
    createThread();
    onClose();
  };

  const handleSelectThread = (threadId: string) => {
    loadThread(threadId);
    onClose();
  };

  const handleDeleteClick = (e: React.MouseEvent, thread: ThreadSummary) => {
    e.stopPropagation();
    setDeleteTarget(thread);
  };

  const handleConfirmDelete = async () => {
    if (deleteTarget) {
      await deleteThread(deleteTarget.id);
      setDeleteTarget(null);
    }
  };

  const handleCancelDelete = () => {
    setDeleteTarget(null);
  };

  if (!isOpen) return null;

  return (
    <>
      <div 
        className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 backdrop-blur-sm"
        onClick={onClose}
      >
        <div 
          className="bg-sidebar border border-border rounded-2xl shadow-2xl w-[600px] h-[700px] flex flex-col overflow-hidden animate-in fade-in zoom-in-95 duration-200"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header - Search Bar Only */}
          <div className="p-4 border-b border-border bg-titlebar flex items-center gap-3">
            {/* Search Bar */}
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-disabled" />
              <input
                type="text"
                placeholder="Search conversations..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full bg-input border border-border rounded-xl pl-10 pr-4 py-2.5 text-[13px] text-text-primary placeholder:text-text-disabled focus:outline-none focus:border-primary/50 transition-colors"
                autoFocus
              />
            </div>
            
            {/* New Chat Button */}
            <button
              onClick={handleNewChat}
              className="p-2.5 rounded-xl bg-primary hover:bg-primary/80 text-white transition-colors shrink-0"
              title="New Chat"
            >
              <Plus className="w-5 h-5" />
            </button>
            
            {/* Close Button */}
            <button 
              onClick={onClose}
              className="p-2.5 rounded-xl text-text-secondary hover:bg-input hover:text-text-primary transition-colors shrink-0"
              title="Close (Esc)"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          {/* Thread List */}
          <div className="flex-1 overflow-y-auto p-4 scrollbar-thin">
            {isLoading ? (
              <div className="flex flex-col items-center justify-center h-full text-text-disabled">
                <Loader2 className="w-8 h-8 animate-spin text-primary mb-4" />
                <p className="text-[13px] text-text-secondary">Loading conversations...</p>
              </div>
            ) : threadsWithMessages.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full text-text-disabled">
                <div className="w-16 h-16 rounded-2xl bg-input flex items-center justify-center mb-4">
                  <MessageSquare className="w-8 h-8 opacity-40" />
                </div>
                <p className="text-[14px] font-medium text-text-secondary mb-1">
                  {searchQuery ? 'No matching conversations' : 'No conversations yet'}
                </p>
                <p className="text-[12px] text-text-disabled">
                  {searchQuery ? 'Try a different search term' : 'Start a new chat to begin'}
                </p>
              </div>
            ) : (
              <div className="space-y-2">
                {threadsWithMessages.map((thread) => (
                  <ThreadItem
                    key={thread.id}
                    thread={thread}
                    isActive={thread.id === currentThreadId}
                    onSelect={() => handleSelectThread(thread.id)}
                    onDelete={(e) => handleDeleteClick(e, thread)}
                  />
                ))}
              </div>
            )}
          </div>

          {/* Footer - Shortcut Hint */}
          <div className="px-4 py-2.5 border-t border-border bg-titlebar flex items-center justify-center">
            <span className="text-[11px] text-text-disabled">
              Press <span className="font-mono bg-input px-1.5 py-0.5 rounded mx-1">Ctrl+H</span> to open history
            </span>
          </div>
        </div>
      </div>

      {/* Delete Confirmation Dialog */}
      <DeleteConfirmDialog
        isOpen={!!deleteTarget}
        threadTitle={deleteTarget?.title || ''}
        onConfirm={handleConfirmDelete}
        onCancel={handleCancelDelete}
      />
    </>
  );
};
