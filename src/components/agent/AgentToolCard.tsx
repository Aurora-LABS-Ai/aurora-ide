/**
 * THEME ARCHITECTURE NOTICE:
 *
 * This component uses the centralized theme system via CSS variables.
 * All colors use var(--aurora-{category}-{token}) format.
 *
 * See: DOCS/theme-dev.md for full token reference
 */

import React, { useState } from 'react';

export interface ToolAction {
  id: string;
  toolName: string;
  args: string;
  icon: string;
  status: 'pending' | 'success' | 'error';
  result?: string;
}

interface AgentToolCardProps {
  action: ToolAction;
}

export const AgentToolCard: React.FC<AgentToolCardProps> = ({ action }) => {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <div
      className={`group relative flex flex-col rounded-xl border transition-all duration-300 overflow-hidden cursor-pointer
        ${isOpen
          ? 'border-[var(--aurora-common-border-hover)]'
          : 'border-[var(--aurora-common-border)] hover:border-[var(--aurora-common-border-hover)]'
        }`}
      style={{
        background: isOpen
          ? 'var(--aurora-chat-surface)'
          : 'var(--aurora-chat-surfaceMuted)',
      }}
      onClick={() => setIsOpen(!isOpen)}
    >
      {/* Header Row */}
      <div className="flex items-center justify-between pl-3 pr-2 py-2">
        <div className="flex items-center gap-3 min-w-0 flex-1">
          <div className="flex items-center gap-2 shrink-0">
            <span
              className="material-symbols-rounded text-base"
              style={{ color: 'var(--aurora-common-primary)' }}
            >
              {action.icon}
            </span>
            <span
              className="font-mono text-[13px] font-medium"
              style={{ color: 'var(--aurora-chat-foreground, var(--aurora-editor-foreground))' }}
            >
              {action.toolName}
            </span>
          </div>
          <div
            className="w-px h-3 shrink-0"
            style={{ background: 'var(--aurora-common-border)' }}
          />
          <span
            className="font-mono text-xs truncate flex-1"
            style={{ color: 'var(--aurora-common-mutedForeground)' }}
          >
            {action.args}
          </span>
        </div>

        <div className="flex items-center gap-2">
          <span className="flex items-center justify-center w-4 h-4 translate-y-[0.5px]">
            {action.status === 'pending' ? (
              <span
                className="material-icons-round text-[14px] leading-none block animate-spin"
                style={{ color: 'var(--aurora-common-warning)' }}
              >
                sync
              </span>
            ) : action.status === 'error' ? (
              <span
                className="material-icons-round text-[14px] leading-none block"
                style={{ color: 'var(--aurora-common-error)' }}
              >
                error
              </span>
            ) : (
              <span
                className="material-icons-round text-[14px] leading-none block"
                style={{ color: 'var(--aurora-common-success)' }}
              >
                check_circle
              </span>
            )}
          </span>
          <span
            className={`material-icons-round text-sm transition-transform duration-300 ${isOpen ? 'rotate-180' : ''}`}
            style={{ color: 'var(--aurora-common-mutedForeground)' }}
          >
            expand_more
          </span>
        </div>
      </div>

      {/* Dropdown Content */}
      <div
        className={`grid transition-all duration-300 ease-in-out ${isOpen ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'}`}
      >
        <div className="overflow-hidden">
          <div className="px-3 pb-3 pt-0">
            <div
              className="p-2.5 font-mono text-[11px] leading-relaxed"
              style={{
                background: 'var(--aurora-chat-codeBlock)',
                color: 'var(--aurora-common-mutedForeground)',
                borderRadius: '0.75rem',
              }}
            >
              <div className="flex justify-between items-center mb-1 opacity-70">
                <span>INPUT</span>
                <span className="uppercase text-[9px]">{action.status}</span>
              </div>
              <div className="mb-2">
                <span style={{ color: 'var(--aurora-common-primary)' }}>{action.toolName}</span>
                <span style={{ color: 'var(--aurora-common-mutedForeground)' }}>({action.args})</span>
              </div>

              <div className="flex justify-between items-center mb-1 opacity-70 mt-3">
                <span>OUTPUT</span>
              </div>
              <div className="whitespace-pre-wrap">
                {action.result || 'No output available.'}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default AgentToolCard;
