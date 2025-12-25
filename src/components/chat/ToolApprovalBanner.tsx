import React, { useState } from 'react';
import { Check, X, AlertTriangle, Shield, ChevronDown, Terminal, FileText, FolderOpen } from 'lucide-react';
import type { ToolProposal } from '../../types';
import clsx from 'clsx';

interface ToolApprovalBannerProps {
  proposal: ToolProposal;
  onApprove: () => void;
  onReject: () => void;
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
}) => {
  const [showDetails, setShowDetails] = useState(false);
  const ToolIcon = getToolIcon(proposal.toolName);

  const getRiskColor = () => {
    switch (proposal.riskLevel) {
      case 'high':
        return 'border-danger/50 bg-danger/5';
      case 'medium':
        return 'border-warning/50 bg-warning/5';
      default:
        return 'border-primary/50 bg-primary/5';
    }
  };

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
    <div className={clsx(
      "mx-3 mb-2 rounded-lg border overflow-hidden",
      getRiskColor()
    )}>
      {/* Main Banner */}
      <div className="p-3">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 flex flex-col items-center gap-1">
            {getRiskIcon()}
            <ToolIcon className="w-3.5 h-3.5 text-text-disabled" />
          </div>
          
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <span className="text-[13px] font-medium text-text-primary">
                Approval Required
              </span>
              <span className={clsx(
                "text-[10px] font-medium px-1.5 py-0.5 rounded uppercase",
                proposal.riskLevel === 'high' ? 'bg-danger/20 text-danger' :
                proposal.riskLevel === 'medium' ? 'bg-warning/20 text-warning' :
                'bg-primary/20 text-primary'
              )}>
                {proposal.riskLevel}
              </span>
            </div>
            
            <p className="text-[12px] text-text-secondary">
              Execute <span className="font-mono font-medium text-text-primary bg-input px-1 py-0.5 rounded">{proposal.toolName}</span>
            </p>
            
            {/* Toggle details button */}
            {hasParameters && (
              <button
                onClick={() => setShowDetails(!showDetails)}
                className="flex items-center gap-1 mt-1.5 text-[11px] text-text-disabled hover:text-text-secondary transition-colors"
              >
                <ChevronDown className={clsx("w-3 h-3 transition-transform", showDetails && "rotate-180")} />
                {showDetails ? 'Hide' : 'Show'} parameters
              </button>
            )}
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={onReject}
              className="flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-medium text-text-secondary hover:text-danger bg-input hover:bg-danger/10 border border-border hover:border-danger/50 rounded-lg transition-all"
            >
              <X className="w-3.5 h-3.5" />
              Reject
            </button>
            <button
              onClick={onApprove}
              className="flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-medium text-white bg-primary hover:bg-primary/80 rounded-lg transition-all shadow-sm"
            >
              <Check className="w-3.5 h-3.5" />
              Approve
            </button>
          </div>
        </div>
      </div>

      {/* Parameters Detail Panel */}
      {showDetails && hasParameters && (
        <div className="border-t border-border/50 bg-titlebar/50 px-3 py-2">
          <div className="space-y-1.5">
            {Object.entries(proposal.parameters).map(([key, value]) => (
              <div key={key} className="flex gap-2">
                <span className="text-[10px] font-mono text-text-disabled w-20 shrink-0 truncate">{key}:</span>
                <span className="text-[10px] font-mono text-text-secondary break-all">
                  {formatParamValue(value)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

