/**
 * THEME ARCHITECTURE NOTICE:
 *
 * This component uses the centralized theme system via CSS variables.
 * All colors use var(--aurora-{category}-{token}) format.
 *
 * See: DOCS/theme-dev.md for full token reference
 */

import React from 'react';
import { AgentToolCard, type ToolAction } from './AgentToolCard';

export interface ContentBlock {
  type: 'text' | 'tools';
  content?: string;
  actions?: ToolAction[];
}

export interface AgentMessage {
  id: string;
  sender: 'user' | 'agent';
  senderName: string;
  timestamp: string;
  content: ContentBlock[];
}

interface AgentChatMessageProps {
  message: AgentMessage;
}

export const AgentChatMessage: React.FC<AgentChatMessageProps> = ({ message }) => {
  const isAgent = message.sender === 'agent';

  // Helper to highlight code snippets in text
  const renderTextWithHighlights = (text: string) => {
    const parts = text.split(/(`[^`]+`)/);
    return parts.map((part, index) => {
      if (part.startsWith('`') && part.endsWith('`')) {
        return (
          <span
            key={index}
            className="font-mono text-xs px-1.5 py-0.5 rounded mx-1"
            style={{
              background: 'var(--aurora-chat-code-block)',
              color: 'var(--aurora-common-primary)',
            }}
          >
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
        {/* Avatar */}
        <div
          className="w-6 h-6 rounded-md flex items-center justify-center text-[10px] font-bold shadow-lg"
          style={{
            background: isAgent
              ? 'var(--aurora-common-primary)'
              : 'var(--aurora-common-secondary)',
            color: isAgent
              ? 'var(--aurora-common-primary-foreground)'
              : 'var(--aurora-common-secondary-foreground)',
          }}
        >
          {message.senderName.charAt(0)}
        </div>

        <div className="flex items-center gap-2">
          <span
            className="text-xs font-bold tracking-wide"
            style={{ color: 'var(--aurora-common-primary)' }}
          >
            {message.senderName}
          </span>
          <span
            className="text-[10px]"
            style={{ color: 'var(--aurora-common-muted-foreground)' }}
          >
            {message.timestamp}
          </span>
        </div>
      </div>

      <div
        className="pl-9 text-sm leading-relaxed space-y-4"
        style={{ color: 'var(--aurora-editor-foreground)' }}
      >
        {/* Process Log Toggle (Mock) */}
        {isAgent && (
          <button
            className="flex items-center gap-1.5 text-xs transition-colors w-max group"
            style={{ color: 'var(--aurora-common-muted-foreground)' }}
          >
            <span className="material-icons-round text-sm group-hover:text-[var(--aurora-common-primary)] transition-colors">
              hub
            </span>
            <span>Process Log</span>
            <span className="material-icons-round text-sm rotate-90 group-hover:text-[var(--aurora-common-primary)] transition-colors">
              chevron_right
            </span>
          </button>
        )}

        {/* Content Blocks */}
        {message.content.map((block, idx) => {
          if (block.type === 'text' && block.content) {
            return (
              <p key={idx}>
                {renderTextWithHighlights(block.content)}
              </p>
            );
          } else if (block.type === 'tools' && block.actions) {
            return (
              <div key={idx} className="flex flex-col gap-2 max-w-md">
                {block.actions.map((action) => (
                  <AgentToolCard key={action.id} action={action} />
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

export default AgentChatMessage;
