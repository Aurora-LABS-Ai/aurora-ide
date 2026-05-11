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
import type { Message, TimelineEvent, ToolProposal } from '../../types';
import { ThinkingBlock } from './ThinkingBlock';
import { ToolTimeline } from './ToolTimeline';
import { ToolProposalCard } from './ToolProposalCard';
import { MarkdownRenderer } from './MarkdownRenderer';
import { CheckpointIndicator } from './CheckpointIndicator';
import { useEditorStore } from '../../store/useEditorStore';
import { loadFileContent } from '../../store/useWorkspaceStore';
import { getLanguageFromExtension } from '../../lib/file-utils';
import { FileIcon } from '../explorer/FileIcons';
import { User, Copy, Check, BookOpen, Zap, MousePointer2 } from 'lucide-react';
import { getProfessionalToolName } from '../../services/tool-display';
import { Tooltip } from '../ui/Tooltip';

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
    <Tooltip label={copied ? 'Copied!' : 'Copy message'}>
      <button
        onClick={handleCopy}
        className={`p-1 rounded hover:bg-sidebar-item-hover transition-all ${className}`}
      >
        {copied ? (
          <Check className="w-3.5 h-3.5 text-success" />
        ) : (
          <Copy className="w-3.5 h-3.5 text-text-disabled hover:text-text-primary" />
        )}
      </button>
    </Tooltip>
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
      const toolName = event.tool.name ? getProfessionalToolName(event.tool.name) : 'Tool';
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
  isActivelyStreaming?: boolean;
  toolVariant?: 'timeline' | 'cards';
  pendingApproval?: ToolProposal | null;
  onApprovePending?: () => void;
  onRejectPending?: () => void;
  onApprovePendingRemember?: () => void;
}> = ({
  event,
  isStreaming = false,
  isActivelyStreaming = false,
  toolVariant = 'timeline',
  pendingApproval = null,
  onApprovePending,
  onRejectPending,
  onApprovePendingRemember,
}) => {
  switch (event.type) {
    case 'thinking':
      return event.thinking ? (
        <ThinkingBlock content={event.thinking} isGenerating={event.isThinking} />
      ) : null;

    case 'tool':
      return event.tool ? (
        <ToolTimeline
          tools={[event.tool]}
          variant={toolVariant}
          isActivelyStreaming={isActivelyStreaming}
          pendingApproval={pendingApproval}
          onApprovePending={onApprovePending}
          onRejectPending={onRejectPending}
          onApprovePendingRemember={onApprovePendingRemember}
        />
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
  /**
   * When true, suppress the avatar + "AURORA" header so this message
   * visually merges with the assistant turn above it. Used by the
   * thread-history rehydration path because each Rust
   * `ConversationMessage` (one per tool-loop iteration) becomes its
   * own React Message — without this the user sees N AURORA bubbles
   * for what was a single live turn.
   */
  hideAssistantHeader?: boolean;
  pendingApproval?: ToolProposal | null;
  onApprovePending?: () => void;
  onRejectPending?: () => void;
  onApprovePendingRemember?: () => void;
}

const ChatMessageComponent: React.FC<ChatMessageProps> = ({
  message,
  isStreaming = false,
  isLastMessage = false,
  toolVariant = 'timeline',
  hideAssistantHeader = false,
  pendingApproval = null,
  onApprovePending,
  onRejectPending,
  onApprovePendingRemember,
}) => {
  const isUser = message.sender === 'user';

  if (isUser) {
    const hasAttachedFiles = message.attachedFiles && message.attachedFiles.length > 0;
    const hasAttachedAssets = message.attachedPromptAssets && message.attachedPromptAssets.length > 0;
    const hasSelectedElements = message.attachedSelectedElements && message.attachedSelectedElements.length > 0;
    const hasAttachments = hasAttachedFiles || hasAttachedAssets || hasSelectedElements;
    const hasTextContent = message.content.trim().length > 0;

    const handleAttachedFileClick = async (file: { path: string; name: string }) => {
      try {
        const content = await loadFileContent(file.path);
        const language = getLanguageFromExtension(file.name);
        useEditorStore.getState().openFile(file.path, file.name, content, language);
      } catch (err) {
        console.error('Failed to open attached file:', err);
      }
    };

    return (
      <motion.div 
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3, ease: "easeOut" }}
        className="flex justify-end px-4 py-4 group"
      >
        <div className="max-w-[85%] flex flex-col items-end min-w-0">
          <div className="flex gap-3 flex-row-reverse min-w-0 w-full">
            {/* Avatar — bound to the dedicated user-message token so theme
                editor changes to Chat → User Message recolour ONLY the
                user's bubble + avatar, with no spillover into inputs. */}
            <div
              className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0"
              style={{
                background: 'var(--aurora-chat-user-message)',
              }}
            >
              <User className="w-4 h-4 text-text-secondary" />
            </div>

            {/* User bubble — same dedicated token. The fallback to
                chat-input-background preserves visual parity if a custom
                theme didn't define the user-message colour. */}
            <div
              className="text-text-primary rounded-2xl rounded-tr-sm px-4 py-2.5 border border-border shadow-sm min-w-0 max-w-full overflow-hidden"
              style={{
                background:
                  'var(--aurora-chat-user-message, var(--aurora-chat-input-background))',
              }}
            >
              {/* Attachment chips */}
              {hasAttachments && (
                <div className="flex flex-wrap gap-1.5 mb-2">
                  {message.attachedFiles?.map((file) => (
                    <button
                      key={file.path}
                      onClick={() => handleAttachedFileClick(file)}
                      className="group/chip flex items-center gap-1.5 pl-2 pr-2.5 py-1 rounded-lg text-[11px] font-medium transition-all duration-150 cursor-pointer"
                      style={{
                        background: 'color-mix(in srgb, var(--aurora-common-primary) 10%, transparent)',
                        border: '1px solid color-mix(in srgb, var(--aurora-common-primary) 20%, transparent)',
                        color: 'var(--aurora-common-primary)',
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.background = 'color-mix(in srgb, var(--aurora-common-primary) 18%, transparent)';
                        e.currentTarget.style.borderColor = 'color-mix(in srgb, var(--aurora-common-primary) 35%, transparent)';
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.background = 'color-mix(in srgb, var(--aurora-common-primary) 10%, transparent)';
                        e.currentTarget.style.borderColor = 'color-mix(in srgb, var(--aurora-common-primary) 20%, transparent)';
                      }}
                      title={`Open ${file.path}`}
                    >
                      <FileIcon name={file.name} path={file.path} className="w-3.5 h-3.5 min-w-[14px]" />
                      <span className="truncate max-w-[140px]">{file.name}</span>
                    </button>
                  ))}
                  {message.attachedPromptAssets?.map((asset) => (
                    <span
                      key={asset.key}
                      className="flex items-center gap-1.5 px-2 py-1 rounded-lg text-[11px] font-medium"
                      style={{
                        background: asset.type === 'skill'
                          ? 'color-mix(in srgb, var(--aurora-common-warning) 10%, transparent)'
                          : 'color-mix(in srgb, var(--aurora-common-info, var(--aurora-common-primary)) 10%, transparent)',
                        border: asset.type === 'skill'
                          ? '1px solid color-mix(in srgb, var(--aurora-common-warning) 22%, transparent)'
                          : '1px solid color-mix(in srgb, var(--aurora-common-info, var(--aurora-common-primary)) 22%, transparent)',
                        color: asset.type === 'skill'
                          ? 'var(--aurora-common-warning)'
                          : 'var(--aurora-common-info, var(--aurora-common-primary))',
                      }}
                    >
                      {asset.type === 'skill' ? <Zap className="w-3 h-3" /> : <BookOpen className="w-3 h-3" />}
                      <span className="uppercase text-[9px] font-bold tracking-wider opacity-70">{asset.type}</span>
                      <span className="truncate max-w-[140px]">{asset.title}</span>
                    </span>
                  ))}
                  {message.attachedSelectedElements?.map((pill) => {
                    const tooltip = [
                      `selector: ${pill.selector}`,
                      `tag: <${pill.tagName}>`,
                      pill.url ? `url: ${pill.url}` : null,
                      pill.text
                        ? `text: ${pill.text.slice(0, 120)}${pill.text.length > 120 ? '…' : ''}`
                        : null,
                      pill.note ? `note: ${pill.note}` : null,
                    ]
                      .filter(Boolean)
                      .join('\n');
                    return (
                      <span
                        key={`pick-${pill.index}`}
                        className="flex items-center gap-1.5 px-2 py-1 rounded-lg text-[11px] font-medium"
                        style={{
                          background:
                            'color-mix(in srgb, var(--aurora-common-primary) 10%, transparent)',
                          border:
                            '1px solid color-mix(in srgb, var(--aurora-common-primary) 22%, transparent)',
                          color: 'var(--aurora-common-primary)',
                        }}
                        title={tooltip}
                      >
                        <MousePointer2 className="w-3 h-3" />
                        <span className="uppercase text-[9px] font-bold tracking-wider opacity-70">
                          {pill.source === 'stagewise' ? 'Stage' : 'Pick'}
                        </span>
                        <span className="truncate max-w-[140px]">Selected {pill.index}</span>
                      </span>
                    );
                  })}
                </div>
              )}
              {hasTextContent && (
                <p className="whitespace-pre-wrap break-words text-[14px] leading-[1.6] font-normal tracking-[0.01em] text-text-primary select-text cursor-text overflow-wrap-anywhere" style={{ wordBreak: 'break-word', overflowWrap: 'anywhere' }}>
                  {message.content}
                </p>
              )}
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
      className={hideAssistantHeader ? "px-4 pt-0 pb-4 group relative" : "px-4 py-4 group relative"}
    >
      {/* Avatar column — hidden on continuation rows so consecutive
          assistant messages render as a single visual bubble. */}
      {!hideAssistantHeader && (
        <div className="absolute left-4 top-4 w-8 h-8 flex items-center justify-center shrink-0 overflow-hidden">
          <img src="/aurora.png" alt="Aurora" className="w-6 h-6 object-contain drop-shadow-sm" />
        </div>
      )}

      {/* Content column */}
      <div className="pl-12 pr-2">
        {/* Name header — also suppressed on continuation rows. */}
        <div
          className={hideAssistantHeader ? "hidden" : "flex items-center gap-2 mb-2"}
        >
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
                isActivelyStreaming={isStreaming && isLastMessage}
                toolVariant={toolVariant}
                pendingApproval={pendingApproval}
                onApprovePending={onApprovePending}
                onRejectPending={onRejectPending}
                onApprovePendingRemember={onApprovePendingRemember}
              />
            ))
          ) : (
            <>
              {message.thinking && (
                <ThinkingBlock content={message.thinking} isGenerating={message.isThinking} />
              )}
              {message.tools && message.tools.length > 0 && (
                <ToolTimeline
                  tools={message.tools}
                  variant={toolVariant}
                  isActivelyStreaming={isStreaming && isLastMessage}
                  pendingApproval={pendingApproval}
                  onApprovePending={onApprovePending}
                  onRejectPending={onRejectPending}
                  onApprovePendingRemember={onApprovePendingRemember}
                />
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

const areChatMessagePropsEqual = (
  prev: ChatMessageProps,
  next: ChatMessageProps,
): boolean =>
  prev.message === next.message &&
  prev.isStreaming === next.isStreaming &&
  prev.isLastMessage === next.isLastMessage &&
  prev.toolVariant === next.toolVariant &&
  prev.pendingApproval === next.pendingApproval &&
  prev.onApprovePending === next.onApprovePending &&
  prev.onRejectPending === next.onRejectPending &&
  prev.onApprovePendingRemember === next.onApprovePendingRemember;

export const ChatMessage = React.memo(ChatMessageComponent, areChatMessagePropsEqual);
ChatMessage.displayName = 'ChatMessage';
