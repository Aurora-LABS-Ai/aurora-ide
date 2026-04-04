/**
 * THEME ARCHITECTURE NOTICE:
 *
 * This component uses the centralized theme system via CSS variables.
 * All colors use var(--aurora-{category}-{token}) format.
 *
 * See: DOCS/theme-dev.md for full token reference
 */

import React, { useState } from 'react';
import { getProfessionalToolName } from '../../services/tool-display';

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
  const toolLabel = getProfessionalToolName(action.toolName);
  const statusLabel = action.status === 'pending' ? 'Running' : action.status === 'error' ? 'Error' : 'Done';
  const statusDotClass = action.status === 'pending'
    ? 'bg-warning/70 ring-warning/30'
    : action.status === 'error'
      ? 'bg-error/70 ring-error/30'
      : 'bg-success/70 ring-success/30';
  const statusBadgeClass = action.status === 'pending'
    ? 'text-warning bg-warning/10 border-warning/20'
    : action.status === 'error'
      ? 'text-error bg-error/10 border-error/20'
      : 'text-success bg-success/10 border-success/20';

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
          : 'var(--aurora-chat-surface-muted)',
      }}
      onClick={() => setIsOpen(!isOpen)}
    >
      <div className="flex items-center justify-between px-3 py-2.5">
        <div className="flex items-center gap-2 min-w-0">
          <span className={`h-2.5 w-2.5 rounded-full ring-2 ${statusDotClass}`} />
          <span
            className="material-symbols-rounded text-base"
            style={{ color: 'var(--aurora-common-primary)' }}
          >
            {action.icon}
          </span>
          <span
            className="font-mono text-[12px] font-semibold truncate"
            style={{ color: 'var(--aurora-common-text-primary)' }}
          >
            {toolLabel}
          </span>
        </div>

        <div className="flex items-center gap-2">
          <span className={`text-[9px] font-semibold px-2 py-0.5 rounded-full border ${statusBadgeClass}`}>
            {statusLabel}
          </span>
          <span
            className={`material-icons-round text-sm transition-transform duration-300 ${isOpen ? 'rotate-180' : ''}`}
            style={{ color: 'var(--aurora-common-muted-foreground)' }}
          >
            expand_more
          </span>
        </div>
      </div>

      <div className="px-3 pb-2 text-[10px] font-mono text-text-secondary truncate">
        {action.args}
      </div>

      <div
        className={`grid transition-all duration-300 ease-in-out ${isOpen ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'}`}
      >
        <div className="overflow-hidden">
          <div className="px-3 pb-3 pt-1.5 border-t border-border/50">
            <div
              className="p-2.5 font-mono text-[11px] leading-relaxed"
              style={{
                background: 'var(--aurora-chat-code-block)',
                color: 'var(--aurora-common-muted-foreground)',
                borderRadius: '0.75rem',
              }}
            >
              <div className="flex justify-between items-center mb-1 opacity-70">
                <span>INPUT</span>
                <span className="uppercase text-[9px]">{action.status}</span>
              </div>
              <div className="mb-2">
                <span style={{ color: 'var(--aurora-common-primary)' }}>{toolLabel}</span>
                <span style={{ color: 'var(--aurora-common-muted-foreground)' }}>({action.args})</span>
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
