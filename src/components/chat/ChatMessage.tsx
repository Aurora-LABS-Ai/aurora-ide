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

import React, { useState, useCallback } from 'react';
import { motion } from 'framer-motion';
import type { Message, TimelineEvent } from '../../types';
import { ThinkingBlock } from './ThinkingBlock';
import { ToolTimeline } from './ToolTimeline';
import { ToolProposalCard } from './ToolProposalCard';
import { MarkdownRenderer } from './MarkdownRenderer';
import { CheckpointIndicator } from './CheckpointIndicator';
import { User, Copy, Check } from 'lucide-react';

// Copy button component with feedback
const CopyButton: React.FC<{ text: string; className?: string }> = ({ text, className = '' }) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  }, [text]);

  return (
    <button
      onClick={handleCopy}
      className={`p-1 rounded hover:bg-sidebar-item-hover transition-all ${className}`}
      title={copied ? 'Copied!' : 'Copy message'}
    >
      {copied ? (
        <Check className="w-3.5 h-3.5 text-success" />
      ) : (
        <Copy className="w-3.5 h-3.5 text-text-disabled hover:text-text-primary" />
      )}
    </button>
  );
};

// Extract text content from timeline events for copying
const extractTimelineText = (timeline: TimelineEvent[]): string => {
  const parts: string[] = [];

  for (const event of timeline) {
    if (event.type === 'content' && event.content) {
      parts.push(event.content);
    } else if (event.type === 'thinking' && event.thinking) {
      // Include thinking content (user might want to copy reasoning)
      parts.push(`[Thinking]\n${event.thinking}`);
    } else if (event.type === 'tool' && event.tool) {
      // Include tool name and result summary
      const toolName = event.tool.name || 'Tool';
      const result = event.tool.result ? `Result: ${event.tool.result.substring(0, 500)}${event.tool.result.length > 500 ? '...' : ''}` : '';
      if (result) {
        parts.push(`[${toolName}]\n${result}`);
      }
    }
  }

  return parts.join('\n\n');
};

// Render a single timeline event
const TimelineEventItem: React.FC<{ 
  event: TimelineEvent; 
  isStreaming?: boolean;
  toolVariant?: 'timeline' | 'cards';
}> = ({ event, isStreaming = false, toolVariant = 'timeline' }) => {
  switch (event.type) {
    case 'thinking':
      return event.thinking ? (
        <ThinkingBlock content={event.thinking} isGenerating={event.isThinking} />
      ) : null;

    case 'tool':
      return event.tool ? (
        <ToolTimeline tools={[event.tool]} variant={toolVariant} />
      ) : null;

    case 'content':
      return event.content ? (
        <div className="py-1">
          <MarkdownRenderer content={event.content} isStreaming={isStreaming} />
        </div>
      ) : null;

    default:
      return null;
  }
};

interface ChatMessageProps {
  message: Message;
  isStreaming?: boolean; // Whether this message is currently being streamed
  isLastMessage?: boolean; // Whether this is the last message in the list
  toolVariant?: 'timeline' | 'cards'; // Style variant for tool displays
}

export const ChatMessage: React.FC<ChatMessageProps> = ({ message, isStreaming = false, isLastMessage = false, toolVariant = 'timeline' }) => {
  const isUser = message.sender === 'user';

  if (isUser) {
    return (
      <motion.div 
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3, ease: "easeOut" }}
        className="flex justify-end px-4 py-4 group"
      >
        <div className="max-w-[85%] flex flex-col items-end min-w-0">
          <div className="flex gap-3 flex-row-reverse min-w-0 w-full">
            <div className="w-8 h-8 rounded-lg bg-input flex items-center justify-center shrink-0">
              <User className="w-4 h-4 text-text-secondary" />
            </div>

            <div className="bg-input text-text-primary rounded-2xl rounded-tr-sm px-4 py-2.5 border border-border shadow-sm min-w-0 max-w-full overflow-hidden">
              <p className="whitespace-pre-wrap break-words text-[13px] leading-relaxed opacity-90 font-light select-text cursor-text overflow-wrap-anywhere" style={{ wordBreak: 'break-word', overflowWrap: 'anywhere' }}>
                {message.content}
              </p>
            </div>
          </div>
          {/* Copy button, checkpoint, and timestamp - visible on hover */}
          <div className="flex items-center gap-2 mt-1 mr-11 opacity-0 group-hover:opacity-100 transition-opacity">
            <CheckpointIndicator messageId={message.id} messageContent={message.content} />
            <span className="text-[10px] text-text-disabled font-mono">
              {new Date(message.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </span>
            <CopyButton text={message.content} />
          </div>
        </div>
      </motion.div>
    );
  }

  const hasTimeline = message.timeline && message.timeline.length > 0;

  // Get copyable text content
  const getCopyableText = (): string => {
    if (hasTimeline) {
      return extractTimelineText(message.timeline!);
    }
    return message.content || '';
  };

  const copyableText = getCopyableText();

  return (
    <motion.div 
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, ease: "easeOut" }}
      className="px-4 py-4 group relative"
    >
      {/* Avatar column */}
      <div className="absolute left-4 top-4 w-8 h-8 flex items-center justify-center shrink-0 overflow-hidden">
        <img src="/app-icon.svg" alt="Aurora" className="w-6 h-6 drop-shadow-sm" />
      </div>

      {/* Content column */}
      <div className="pl-12 pr-2">
        {/* Name header */}
        <div className="flex items-center gap-2 mb-2">
          {isStreaming && isLastMessage ? (
            <span
              className="text-[11px] font-bold tracking-wide aurora-shimmer"
              style={{
                background: 'linear-gradient(90deg, var(--aurora-common-primary) 0%, var(--aurora-common-primary) 40%, #ffffff 50%, var(--aurora-common-primary) 60%, var(--aurora-common-primary) 100%)',
                backgroundSize: '200% 100%',
                WebkitBackgroundClip: 'text',
                backgroundClip: 'text',
                color: 'transparent',
                animation: 'aurora-shine 2s ease-in-out infinite',
              }}
            >
              AURORA
            </span>
          ) : (
            <span className="text-[11px] font-bold text-text-primary tracking-wide">AURORA</span>
          )}
          <span className="text-[10px] text-text-disabled font-mono time-stamp opacity-0 group-hover:opacity-100 transition-opacity">
            {new Date(message.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </span>
        </div>

        <div className="space-y-1 select-text cursor-text">
          {hasTimeline ? (
            message.timeline!.map((event, idx) => (
              <TimelineEventItem
                key={event.id}
                event={event}
                isStreaming={isStreaming && isLastMessage && idx === message.timeline!.length - 1}
                toolVariant={toolVariant}
              />
            ))
          ) : (
            <>
              {message.thinking && (
                <ThinkingBlock content={message.thinking} isGenerating={message.isThinking} />
              )}
              {message.tools && message.tools.length > 0 && (
                <ToolTimeline tools={message.tools} variant={toolVariant} />
              )}
              {message.content && (
                <div className="py-1">
                  <MarkdownRenderer content={message.content} isStreaming={isStreaming && isLastMessage} />
                </div>
              )}

              {/* Skeleton Loader for initial thinking/response */}
              {isStreaming && isLastMessage && !message.content && !message.thinking && (!message.tools || message.tools.length === 0) && (!message.timeline || message.timeline.length === 0) && (
                <div className="py-2 space-y-2 max-w-md animate-pulse opacity-60">
                   <div className="h-3 bg-sidebar-item-hover rounded w-3/4"></div>
                   <div className="h-3 bg-sidebar-item-hover rounded w-1/2"></div>
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

        {/* Copy button - visible on hover, only if there's copyable content */}
        {copyableText && !isStreaming && (
          <div className="mt-2 opacity-0 group-hover:opacity-100 transition-opacity">
            <CopyButton text={copyableText} />
          </div>
        )}
      </div>
    </motion.div>
  );
};
