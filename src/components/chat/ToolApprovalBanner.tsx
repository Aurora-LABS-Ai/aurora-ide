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

import React, { useState } from 'react';
import {
  Check,
  X,
  AlertTriangle,
  Shield,
  ChevronDown,
  Terminal,
  FileText,
  FolderOpen,
  Sparkles,
} from 'lucide-react';
import type { ToolProposal } from '../../types';
import clsx from 'clsx';

interface ToolApprovalBannerProps {
  proposal: ToolProposal;
  onApprove: () => void;
  onReject: () => void;
  onApproveRemember: () => void;
}

// Tool category icons
const getToolIcon = (toolName: string) => {
  if (toolName.startsWith('shell_')) return Terminal;
  if (toolName.startsWith('file_')) return FileText;
  if (toolName.startsWith('folder_')) return FolderOpen;
  return Shield;
};

// Format parameter value for display
const formatParamValue = (value: unknown): string => {
  if (typeof value === 'string') {
    // Truncate long strings
    return value.length > 100 ? value.substring(0, 100) + '...' : value;
  }
  return JSON.stringify(value, null, 2);
};

export const ToolApprovalBanner: React.FC<ToolApprovalBannerProps> = ({
  proposal,
  onApprove,
  onReject,
  onApproveRemember,
}) => {
  const [showDetails, setShowDetails] = useState(false);
  const ToolIcon = getToolIcon(proposal.toolName);

  const getRiskIcon = () => {
    switch (proposal.riskLevel) {
      case 'high':
        return <AlertTriangle className="w-4 h-4 text-danger" />;
      case 'medium':
        return <AlertTriangle className="w-4 h-4 text-warning" />;
      default:
        return <Shield className="w-4 h-4 text-primary" />;
    }
  };

  const hasParameters = proposal.parameters && Object.keys(proposal.parameters).length > 0;

  return (
    <div
      className={clsx(
        'mx-3 mb-2 rounded-2xl border border-border bg-sidebar/95 backdrop-blur shadow-[0_18px_35px_rgba(0,0,0,0.45)]'
      )}
    >
      <div className="px-3.5 py-3">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-input/60 text-primary">
            {getRiskIcon()}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-[12px] tracking-wide uppercase text-text-secondary">
                Approval needed
              </span>
              <span
                className={clsx(
                  'text-[10px] font-semibold tracking-wide px-2 py-0.5 rounded-full',
                  proposal.riskLevel === 'high'
                    ? 'bg-danger/20 text-danger'
                    : proposal.riskLevel === 'medium'
                      ? 'bg-warning/20 text-warning'
                      : 'bg-success/20 text-success',
                )}
              >
                {proposal.riskLevel}
              </span>
            </div>
            <div className="mt-1 flex items-center gap-2 text-[13px] text-text-primary">
              <ToolIcon className="h-3.5 w-3.5 text-text-secondary" />
              <span className="font-mono rounded-lg bg-input/60 px-1.5 py-0.5 text-[12px] text-text-primary">
                {proposal.toolName}
              </span>
              <span className="text-text-secondary">will run</span>
            </div>
            {hasParameters && (
              <button
                onClick={() => setShowDetails(!showDetails)}
                className="mt-1 flex items-center gap-1 text-[11px] text-text-disabled transition hover:text-text-secondary"
              >
                <ChevronDown
                  className={clsx('h-3 w-3 transition-transform', showDetails && 'rotate-180')}
                />
                {showDetails ? 'Hide parameters' : 'Show parameters'}
              </button>
            )}
          </div>
        </div>

        {showDetails && hasParameters && (
          <div className="mt-2 rounded-xl border border-border/70 bg-input/50 p-2">
            <dl className="space-y-1.5">
              {Object.entries(proposal.parameters).map(([key, value]) => (
                <div key={key} className="flex gap-2">
                  <dt className="w-24 shrink-0 text-[10px] font-semibold uppercase tracking-wide text-text-secondary">
                    {key}
                  </dt>
                  <dd className="text-[11px] font-mono text-text-primary">
                    {formatParamValue(value)}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        )}

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            onClick={onReject}
            className="inline-flex items-center gap-1 rounded-full border border-border px-3 py-1 text-[11px] font-medium text-text-secondary transition hover:border-danger hover:text-danger"
          >
            <X className="h-3.5 w-3.5" />
            Reject
          </button>
          <button
            onClick={onApprove}
            className="inline-flex items-center gap-1 rounded-full bg-primary px-3.5 py-1 text-[11px] font-semibold text-white shadow-lg shadow-primary/20 transition hover:bg-primary/90"
          >
            <Check className="h-3.5 w-3.5" />
            Approve
          </button>
          <button
            onClick={onApproveRemember}
            className="inline-flex items-center gap-1 rounded-full border border-primary/40 px-3.5 py-1 text-[11px] font-medium text-primary transition hover:bg-primary/10"
          >
            <Sparkles className="h-3.5 w-3.5" />
            Approve & remember
          </button>
          <p className="ml-auto text-[10px] text-text-disabled">
            You can change this later in Settings → Tools.
          </p>
        </div>
      </div>
    </div>
  );
};

