import React from 'react';
import type { Message, TimelineEvent } from '../../types';
import { ThinkingBlock } from './ThinkingBlock';
import { ToolTimeline } from './ToolTimeline';
import { ToolProposalCard } from './ToolProposalCard';
import { MarkdownRenderer } from './MarkdownRenderer';

// Modern AI sparkle icon
const AuroraIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" className="w-3 h-3 text-white">
    <path
      d="M12 2L13.5 9L20 8L14 12L17 19L12 14L7 19L10 12L4 8L10.5 9L12 2Z"
      fill="currentColor"
    />
  </svg>
);

// Render a single timeline event
const TimelineEventItem: React.FC<{ event: TimelineEvent }> = ({ event }) => {
  switch (event.type) {
    case 'thinking':
      return event.thinking ? (
        <ThinkingBlock content={event.thinking} isGenerating={event.isThinking} />
      ) : null;
    
    case 'tool':
      return event.tool ? (
        <ToolTimeline tools={[event.tool]} />
      ) : null;
    
    case 'content':
      return event.content ? (
        <MarkdownRenderer content={event.content} />
      ) : null;
    
    default:
      return null;
  }
};

interface ChatMessageProps {
  message: Message;
}

export const ChatMessage: React.FC<ChatMessageProps> = ({ message }) => {
  const isUser = message.sender === 'user';

  if (isUser) {
    return (
      <div className="flex justify-end px-4 py-1.5">
        <div className="max-w-[80%]">
          <div className="bg-input text-text-primary rounded-2xl rounded-br-sm px-3 py-2 border border-border/50">
            <p className="whitespace-pre-wrap break-words text-[13px] leading-relaxed">{message.content}</p>
          </div>
        </div>
      </div>
    );
  }

  const hasTimeline = message.timeline && message.timeline.length > 0;

  return (
    <div className="px-4 py-1.5">
      {/* Avatar */}
      <div className="flex items-center gap-2 mb-1">
        <div className="w-5 h-5 rounded bg-gradient-to-br from-[#6366f1] via-[#8b5cf6] to-[#ec4899] flex items-center justify-center shrink-0">
          <AuroraIcon />
        </div>
        <span className="text-[10px] font-semibold text-text-secondary">Aurora</span>
      </div>

      {/* Content */}
      <div className="pl-7">
        {hasTimeline ? (
          message.timeline!.map((event) => (
            <TimelineEventItem key={event.id} event={event} />
          ))
        ) : (
          <>
            {message.thinking && (
              <ThinkingBlock content={message.thinking} isGenerating={message.isThinking} />
            )}
            {message.tools && message.tools.length > 0 && (
              <ToolTimeline tools={message.tools} />
            )}
            {message.content && (
              <MarkdownRenderer content={message.content} />
            )}
          </>
        )}
        
        {message.toolProposal && (
          <ToolProposalCard proposal={message.toolProposal} messageId={message.id} />
        )}
      </div>
    </div>
  );
};
