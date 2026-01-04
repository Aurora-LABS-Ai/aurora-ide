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

import React, { useState, useMemo, useEffect, useRef } from 'react';
import { MessageSquare, Trash2, Search, Plus, Loader2, CornerDownLeft } from 'lucide-react';
import { useThreadStore, type ThreadSummary } from '../../store/useThreadStore';
import { useTaskStore } from '../../store/useTaskStore';
import { DeleteConfirmDialog } from './DeleteConfirmDialog';
import { motion, AnimatePresence } from 'framer-motion';
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
  isSelected: boolean;
  isActive: boolean;
  onSelect: () => void;
  onDelete: (e: React.MouseEvent) => void;
  onMouseEnter: () => void;
}> = ({ thread, isSelected, isActive, onSelect, onDelete, onMouseEnter }) => {
  return (
    <div
      className={clsx(
        "group px-3 py-2 flex items-center gap-3 cursor-pointer text-sm",
        isSelected ? "bg-primary/20 text-zinc-100" : "text-zinc-400 hover:bg-white/[0.03]"
      )}
      onClick={onSelect}
      onMouseEnter={onMouseEnter}
    >
      <MessageSquare size={14} className={isSelected ? "text-primary" : "opacity-50"} />
      
      <div className="flex-1 truncate flex items-center justify-between">
        <div className="flex items-center gap-2 min-w-0">
          <span className="truncate">{thread.title || 'Untitled'}</span>
          {isActive && (
            <span className="text-[9px] bg-primary/30 text-primary px-1.5 py-0.5 rounded shrink-0">current</span>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0 ml-2">
          <span className="text-[10px] opacity-50">{thread.messageCount} msgs</span>
          <span className="text-[10px] opacity-50">{formatDate(thread.updatedAt)}</span>
        </div>
      </div>
      
      <button
        onClick={onDelete}
        className="p-1 rounded opacity-0 group-hover:opacity-100 text-text-disabled hover:text-danger hover:bg-danger/10 transition-all shrink-0"
        title="Delete"
      >
        <Trash2 size={12} />
      </button>
      
      {isSelected && <CornerDownLeft size={12} className="opacity-50" />}
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
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [deleteTarget, setDeleteTarget] = useState<ThreadSummary | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Load threads from files when modal opens
  useEffect(() => {
    if (isOpen) {
      loadAllThreadsFromFiles();
      setSearchQuery('');
      setSelectedIndex(0);
      setTimeout(() => inputRef.current?.focus(), 50);
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

  // Reset selected index when search changes
  useEffect(() => {
    setSelectedIndex(0);
  }, [searchQuery]);

  // Keyboard navigation
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex(i => Math.min(i + 1, threadsWithMessages.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex(i => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (threadsWithMessages[selectedIndex]) {
        handleSelectThread(threadsWithMessages[selectedIndex].id);
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      if (!deleteTarget) onClose();
    }
  };

  const handleNewChat = () => {
    // Clear tasks when creating a new thread - tasks are per-thread
    useTaskStore.getState().clearTasks();
    createThread();
    onClose();
  };

  const handleSelectThread = (threadId: string) => {
    // Clear tasks when switching threads - tasks are per-thread
    useTaskStore.getState().clearTasks();
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
      <AnimatePresence>
        <div 
          className="fixed inset-0 z-[100] flex items-start justify-center pt-[15vh]"
          onMouseDown={onClose}
        >
          <motion.div
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95 }}
            transition={{ duration: 0.1 }}
            className="w-[600px] max-w-full bg-sidebar border border-border rounded-xl shadow-2xl shadow-black/50 flex flex-col overflow-hidden"
            onMouseDown={(e) => e.stopPropagation()}
          >
            {/* Header - Search Bar */}
            <div className="flex items-center px-3 py-3 border-b border-white/5 bg-white/[0.02]">
              <Search size={16} className="text-text-secondary mr-2" />
              <input
                ref={inputRef}
                type="text"
                className="flex-1 bg-transparent border-none outline-none text-sm text-text-primary placeholder:text-text-disabled"
                placeholder="Search conversations..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={handleKeyDown}
              />
              <button
                onClick={handleNewChat}
                className="p-1.5 rounded-md bg-primary/80 hover:bg-primary text-white transition-colors mr-2"
                title="New Chat"
              >
                <Plus size={14} />
              </button>
              <div className="text-[10px] text-zinc-500 bg-white/5 px-2 py-0.5 rounded">ESC to close</div>
            </div>

            {/* Thread List */}
            <div className="max-h-[350px] overflow-y-auto py-1 custom-scrollbar" ref={listRef}>
              {isLoading ? (
                <div className="px-4 py-8 text-center">
                  <Loader2 className="w-5 h-5 animate-spin text-primary mx-auto mb-2" />
                  <span className="text-xs text-text-disabled">Loading conversations...</span>
                </div>
              ) : threadsWithMessages.length === 0 ? (
                <div className="px-4 py-8 text-center text-xs text-text-disabled">
                  {searchQuery ? 'No matching conversations' : 'No conversations yet. Start a new chat!'}
                </div>
              ) : (
                threadsWithMessages.map((thread, index) => (
                  <ThreadItem
                    key={thread.id}
                    thread={thread}
                    isSelected={index === selectedIndex}
                    isActive={thread.id === currentThreadId}
                    onSelect={() => handleSelectThread(thread.id)}
                    onDelete={(e) => handleDeleteClick(e, thread)}
                    onMouseEnter={() => setSelectedIndex(index)}
                  />
                ))
              )}
            </div>

            {/* Footer */}
            <div className="px-3 py-1.5 bg-white/[0.02] border-t border-white/5 text-[10px] text-zinc-400 flex justify-between">
              <span>Thread History</span>
              <span>{threadsWithMessages.length} conversations</span>
            </div>
          </motion.div>
        </div>
      </AnimatePresence>

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
