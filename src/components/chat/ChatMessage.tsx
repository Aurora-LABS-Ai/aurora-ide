import React from 'react';
import type { Message, TimelineEvent } from '../../types';
import { ThinkingBlock } from './ThinkingBlock';
import { ToolTimeline } from './ToolTimeline';
import { ToolProposalCard } from './ToolProposalCard';
import { MarkdownRenderer } from './MarkdownRenderer';
import { User } from 'lucide-react';

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
        <div className="py-1">
          <MarkdownRenderer content={event.content} />
        </div>
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
      <div className="flex justify-end px-4 py-4 group">
        <div className="max-w-[85%] flex gap-3 flex-row-reverse">
          <div className="w-8 h-8 rounded-lg bg-white/10 flex items-center justify-center shrink-0">
            <User className="w-4 h-4 text-zinc-400" />
          </div>

          <div className="bg-[#252526] text-zinc-100 rounded-2xl rounded-tr-sm px-4 py-2.5 border border-white/5 shadow-sm">
            <p className="whitespace-pre-wrap break-words text-[13px] leading-relaxed opacity-90 font-light select-text cursor-text">
              {message.content}
            </p>
          </div>
        </div>
      </div>
    );
  }

  const hasTimeline = message.timeline && message.timeline.length > 0;

  return (
    <div className="px-4 py-4 group relative">
      {/* Avatar column */}
      <div className="absolute left-4 top-4 w-8 h-8 flex items-center justify-center shrink-0 overflow-hidden">
        <img src="/app-icon.svg" alt="Aurora" className="w-6 h-6 drop-shadow-sm" />
      </div>

      {/* Content column */}
      <div className="pl-12 pr-2">
        {/* Name header */}
        <div className="flex items-center gap-2 mb-2">
          <span className="text-[11px] font-bold text-zinc-300 tracking-wide">AURORA</span>
          <span className="text-[10px] text-zinc-600 font-mono time-stamp opacity-0 group-hover:opacity-100 transition-opacity">
            {new Date(message.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </span>
        </div>

        <div className="space-y-1 select-text cursor-text">
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
                <div className="py-1">
                  <MarkdownRenderer content={message.content} />
                </div>
              )}
            </>
          )}

          {message.toolProposal && (
            <div className="mt-4">
              <ToolProposalCard proposal={message.toolProposal} messageId={message.id} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
