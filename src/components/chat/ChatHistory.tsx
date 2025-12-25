import React, { useRef, useEffect } from 'react';
import { ChatMessage } from './ChatMessage';
import type { Message } from '../../types';

interface ChatHistoryProps {
  messages: Message[];
}

export const ChatHistory: React.FC<ChatHistoryProps> = ({ messages }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom when messages change
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length, messages[messages.length - 1]?.timeline?.length]);

  return (
    <div 
      ref={containerRef}
      className="flex-1 overflow-y-auto overflow-x-hidden scrollbar-thin"
      style={{ contain: 'strict' }}
    >
      <div className="py-2">
        {messages.map(msg => (
          <ChatMessage key={msg.id} message={msg} />
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  );
};
