import React, { useRef, useEffect, useCallback } from 'react';
import { ChatMessage } from './ChatMessage';
import { useChatStore } from '../../store/useChatStore';
import type { Message } from '../../types';

interface ChatHistoryProps {
  messages: Message[];
}

export const ChatHistory: React.FC<ChatHistoryProps> = ({ messages }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const { isLoading } = useChatStore();

  // Helper to scroll to bottom - using both scrollIntoView and manual scrollTop for maximum compatibility
  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'smooth') => {
    if (!containerRef.current || !bottomRef.current) return;

    // Use manual set if smooth isn't needed or as fallback
    if (behavior === 'auto') {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    } else {
      bottomRef.current.scrollIntoView({ behavior, block: 'end' });
    }
  }, []);

  // Use ResizeObserver to detect content height changes
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let previousHeight = container.scrollHeight;

    const observer = new ResizeObserver(() => {
      const currentHeight = container.scrollHeight;
      const { scrollTop, clientHeight } = container;

      // Check if we were at the bottom BEFORE the size change
      // Threshold of 100px to be generous with "at bottom"
      const wasAtBottom = previousHeight - (scrollTop + clientHeight) < 100;

      if (wasAtBottom && currentHeight > previousHeight) {
        // CONTENT GREW - Scroll to stay at bottom
        // Use instant scroll during streaming to prevent flicker
        requestAnimationFrame(() => {
          scrollToBottom(isLoading ? 'auto' : 'smooth');
        });
      }

      previousHeight = currentHeight;
    });

    // Observe the inner div (the one with py-2)
    const content = container.firstElementChild;
    if (content) observer.observe(content);

    return () => observer.disconnect();
  }, [scrollToBottom, isLoading]);

  // Initial scroll when message list length changes
  useEffect(() => {
    scrollToBottom('auto');
  }, [messages.length, scrollToBottom]);

  return (
    <div
      ref={containerRef}
      className="flex-1 overflow-y-auto overflow-x-hidden scrollbar-thin"
      style={{ contain: 'strict', scrollbarGutter: 'stable' }}
    >
      <div className="py-2">
        {messages.map(msg => (
          <ChatMessage key={msg.id} message={msg} />
        ))}
        <div ref={bottomRef} className="h-4" />
      </div>
    </div>
  );
};
