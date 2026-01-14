import React from 'react';
import { Message } from '../types';
import ToolCard from './ToolCard';

interface ChatMessageProps {
  message: Message;
}

const ChatMessage: React.FC<ChatMessageProps> = ({ message }) => {
  const isAgent = message.sender === 'agent';

  // Helper to highlight code snippets in text
  const renderTextWithHighlights = (text: string) => {
    const parts = text.split(/(`[^`]+`)/);
    return parts.map((part, index) => {
      if (part.startsWith('`') && part.endsWith('`')) {
        return (
          <span key={index} className="font-mono text-xs bg-gray-200 dark:bg-white/10 px-1.5 py-0.5 rounded text-gray-700 dark:text-gray-300 mx-1">
            {part.slice(1, -1)}
          </span>
        );
      }
      return <span key={index}>{part}</span>;
    });
  };

  return (
    <div className="flex flex-col gap-2 mb-8 animate-fadeIn">
      <div className="flex items-center gap-3 mb-1">
        {/* REVISED AVATAR: Removed gradient, kept only 'A' with a solid refined background as requested */}
        <div className="w-6 h-6 rounded-md bg-primary dark:bg-cyan-700 flex items-center justify-center text-white text-[10px] font-bold shadow-lg">
          {message.senderName.charAt(0)}
        </div>
        
        <div className="flex items-center gap-2">
          <span className="text-xs font-bold text-primary tracking-wide">
            {message.senderName}
          </span>
          <span className="text-[10px] text-gray-400 dark:text-gray-600">
            {message.timestamp}
          </span>
        </div>
      </div>

      <div className="pl-9 text-sm leading-relaxed text-gray-700 dark:text-gray-300 space-y-4">
        {/* Process Log Toggle (Mock) */}
        {isAgent && (
          <button className="flex items-center gap-1.5 text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors w-max group">
            <span className="material-icons-round text-sm group-hover:text-primary transition-colors">hub</span>
            <span>Process Log</span>
            <span className="material-icons-round text-sm rotate-90 group-hover:text-primary transition-colors">chevron_right</span>
          </button>
        )}

        {/* Content Blocks */}
        {message.content.map((block, idx) => {
          if (block.type === 'text') {
            return (
              <p key={idx}>
                {renderTextWithHighlights(block.content)}
              </p>
            );
          } else if (block.type === 'tools') {
            return (
              <div key={idx} className="flex flex-col gap-2 max-w-md">
                {block.actions.map((action) => (
                  <ToolCard key={action.id} action={action} />
                ))}
              </div>
            );
          }
          return null;
        })}
      </div>
    </div>
  );
};

export default ChatMessage;