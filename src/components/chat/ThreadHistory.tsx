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

import React, { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import { MessageSquare, Trash2, Search, Plus, Loader2, CornerDownLeft, CheckSquare, Square, X } from 'lucide-react';
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
  isHighlighted: boolean;
  isActive: boolean;
  isChecked: boolean;
  isSelectMode: boolean;
  onSelect: () => void;
  onDelete: (e: React.MouseEvent) => void;
  onMouseEnter: () => void;
  onToggleCheck: (e: React.MouseEvent) => void;
}> = ({ thread, isHighlighted, isActive, isChecked, isSelectMode, onSelect, onDelete, onMouseEnter, onToggleCheck }) => {
  return (
    <div
      className={clsx(
        "group px-3 py-2 flex items-center gap-2 cursor-pointer text-sm",
        isHighlighted ? "bg-primary/20 text-text-primary" : "text-text-secondary hover:bg-white/[0.03]",
        isChecked && "bg-primary/10"
      )}
      onClick={isSelectMode ? onToggleCheck : onSelect}
      onMouseEnter={onMouseEnter}
    >
      {/* Checkbox - always visible in select mode, otherwise on hover */}
      <button
        onClick={onToggleCheck}
        className={clsx(
          "p-0.5 rounded transition-all shrink-0",
          isSelectMode || isChecked ? "opacity-100" : "opacity-0 group-hover:opacity-60",
          isChecked ? "text-primary" : "text-muted-foreground hover:text-text-primary"
        )}
      >
        {isChecked ? <CheckSquare size={14} /> : <Square size={14} />}
      </button>

      <MessageSquare size={14} className={isHighlighted ? "text-primary" : "opacity-50"} />
      
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
      
      {!isSelectMode && (
        <button
          onClick={onDelete}
          className="p-1 rounded opacity-0 group-hover:opacity-100 text-text-disabled hover:text-danger hover:bg-danger/10 transition-all shrink-0"
          title="Delete"
        >
          <Trash2 size={12} />
        </button>
      )}
      
      {isHighlighted && !isSelectMode && <CornerDownLeft size={12} className="opacity-50" />}
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
  const [selectedThreadIds, setSelectedThreadIds] = useState<Set<string>>(new Set());
  const [isDeleting, setIsDeleting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const isSelectMode = selectedThreadIds.size > 0;

  // Load threads from files when modal opens
  useEffect(() => {
    if (isOpen) {
      loadAllThreadsFromFiles();
      setSearchQuery('');
      setSelectedIndex(0);
      setSelectedThreadIds(new Set()); // Clear selection when opening
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [isOpen, loadAllThreadsFromFiles]);

  // Toggle thread selection
  const toggleThreadSelection = useCallback((threadId: string, e?: React.MouseEvent) => {
    e?.stopPropagation();
    setSelectedThreadIds(prev => {
      const next = new Set(prev);
      if (next.has(threadId)) {
        next.delete(threadId);
      } else {
        next.add(threadId);
      }
      return next;
    });
  }, []);

  // Clear selection
  const clearSelection = useCallback(() => {
    setSelectedThreadIds(new Set());
  }, []);

  // Delete selected threads
  const deleteSelected = useCallback(async () => {
    if (selectedThreadIds.size === 0) return;
    setIsDeleting(true);
    try {
      // Delete all selected threads
      for (const threadId of selectedThreadIds) {
        await deleteThread(threadId);
      }
      setSelectedThreadIds(new Set());
    } catch (error) {
      console.error('Failed to delete threads:', error);
    } finally {
      setIsDeleting(false);
    }
  }, [selectedThreadIds, deleteThread]);

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
      if (isSelectMode) {
        // In select mode, toggle current item
        if (threadsWithMessages[selectedIndex]) {
          toggleThreadSelection(threadsWithMessages[selectedIndex].id);
        }
      } else if (threadsWithMessages[selectedIndex]) {
        handleSelectThread(threadsWithMessages[selectedIndex].id);
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      if (isSelectMode) {
        clearSelection();
      } else if (!deleteTarget) {
        onClose();
      }
    } else if (e.key === ' ' && threadsWithMessages[selectedIndex]) {
      // Space to toggle selection
      e.preventDefault();
      toggleThreadSelection(threadsWithMessages[selectedIndex].id);
    } else if (e.key === 'a' && (e.ctrlKey || e.metaKey)) {
      // Ctrl+A to select all
      e.preventDefault();
      setSelectedThreadIds(new Set(threadsWithMessages.map(t => t.id)));
    } else if (e.key === 'Delete' && isSelectMode) {
      // Delete key to delete selected
      e.preventDefault();
      deleteSelected();
    }
  };

  const handleNewChat = () => {
    // Clear tasks when creating a new thread - tasks are per-thread
    useTaskStore.getState().clearTasks();
    createThread();
    onClose();
  };

  const handleSelectThread = async (threadId: string) => {
    // Clear tasks when switching threads - tasks are per-thread
    useTaskStore.getState().clearTasks();
    // CRITICAL: Wait for thread to fully load before closing modal
    // This prevents race conditions where user sends message before history is loaded
    await loadThread(threadId);
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
            {/* Header - Search Bar or Selection Bar */}
            {isSelectMode ? (
              <div className="flex items-center px-3 py-2.5 border-b border-white/5 bg-primary/10">
                <button
                  onClick={clearSelection}
                  className="p-1 rounded hover:bg-white/10 text-text-secondary hover:text-text-primary transition-colors mr-2"
                  title="Clear selection"
                >
                  <X size={16} />
                </button>
                <span className="text-sm text-text-primary flex-1">
                  {selectedThreadIds.size} selected
                </span>
                <button
                  onClick={() => setSelectedThreadIds(new Set(threadsWithMessages.map(t => t.id)))}
                  className="text-xs text-text-secondary hover:text-text-primary px-2 py-1 rounded hover:bg-white/10 transition-colors mr-2"
                >
                  Select all
                </button>
                <button
                  onClick={deleteSelected}
                  disabled={isDeleting}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-danger/80 hover:bg-danger text-white text-xs font-medium transition-colors disabled:opacity-50"
                >
                  {isDeleting ? (
                    <Loader2 size={12} className="animate-spin" />
                  ) : (
                    <Trash2 size={12} />
                  )}
                  Delete
                </button>
              </div>
            ) : (
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
                <div className="text-[10px] text-muted-foreground bg-white/5 px-2 py-0.5 rounded">ESC to close</div>
              </div>
            )}

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
                    isHighlighted={index === selectedIndex}
                    isActive={thread.id === currentThreadId}
                    isChecked={selectedThreadIds.has(thread.id)}
                    isSelectMode={isSelectMode}
                    onSelect={() => handleSelectThread(thread.id)}
                    onDelete={(e) => handleDeleteClick(e, thread)}
                    onMouseEnter={() => setSelectedIndex(index)}
                    onToggleCheck={(e) => toggleThreadSelection(thread.id, e)}
                  />
                ))
              )}
            </div>

            {/* Footer */}
            <div className="px-3 py-1.5 bg-white/[0.02] border-t border-white/5 text-[10px] text-muted-foreground flex justify-between">
              <div className="flex items-center gap-3">
                <span>Thread History</span>
                <span className="opacity-60">Space to select • Ctrl+A select all</span>
              </div>
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
