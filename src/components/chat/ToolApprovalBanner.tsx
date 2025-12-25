import React from 'react';
import { Check, X, AlertTriangle, Shield } from 'lucide-react';
import type { ToolProposal } from '../../types';
import clsx from 'clsx';

interface ToolApprovalBannerProps {
  proposal: ToolProposal;
  onApprove: () => void;
  onReject: () => void;
}

export const ToolApprovalBanner: React.FC<ToolApprovalBannerProps> = ({
  proposal,
  onApprove,
  onReject,
}) => {
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

  return (
    <div className={clsx(
      "mx-3 mb-2 p-3 rounded-lg border",
      getRiskColor()
    )}>
      <div className="flex items-start gap-3">
        <div className="mt-0.5">
          {getRiskIcon()}
        </div>
        
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-[13px] font-medium text-text-primary">
              Tool Approval Required
            </span>
            <span className={clsx(
              "text-[10px] font-medium px-1.5 py-0.5 rounded uppercase",
              proposal.riskLevel === 'high' ? 'bg-danger/20 text-danger' :
              proposal.riskLevel === 'medium' ? 'bg-warning/20 text-warning' :
              'bg-primary/20 text-primary'
            )}>
              {proposal.riskLevel} risk
            </span>
          </div>
          
          <p className="text-[12px] text-text-secondary mb-2">
            Aurora wants to execute <span className="font-mono text-text-primary">{proposal.toolName}</span>
          </p>
          
          <p className="text-[11px] text-text-disabled">
            {proposal.description}
          </p>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={onReject}
            className="flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-medium text-text-secondary hover:text-danger bg-input hover:bg-danger/10 border border-border hover:border-danger/50 rounded-lg transition-all"
          >
            <X className="w-3.5 h-3.5" />
            Decline
          </button>
          <button
            onClick={onApprove}
            className="flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-medium text-white bg-primary hover:bg-primary/80 rounded-lg transition-all"
          >
            <Check className="w-3.5 h-3.5" />
            Approve
          </button>
        </div>
      </div>
    </div>
  );
};

