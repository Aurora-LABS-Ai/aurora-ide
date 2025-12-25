import React from 'react';
import { AlertTriangle, CheckCircle, XCircle, Play } from 'lucide-react';
import type { ToolProposal } from '../../types';
import { useUiStore } from '../../store/useUiStore';
import { useChatStore } from '../../store/useChatStore';
import clsx from 'clsx';

interface ToolProposalCardProps {
  proposal: ToolProposal;
  messageId: string;
}

export const ToolProposalCard: React.FC<ToolProposalCardProps> = ({ proposal, messageId }) => {
  const { openToolApproval } = useUiStore();
  const { updateToolStatus } = useChatStore();

  const handleReview = () => {
    openToolApproval(proposal);
  };

  const handleReject = () => {
    updateToolStatus(messageId, 'rejected');
  };

  const getRiskColor = (level: string) => {
    switch (level) {
      case 'high': return 'text-danger';
      case 'medium': return 'text-warning';
      case 'low': return 'text-success';
      default: return 'text-primary';
    }
  };

  return (
    <div className="mt-3 rounded-lg overflow-hidden bg-input border border-border">
      <div className="px-3 py-2 border-b border-border flex items-center justify-between">
        <div className="flex items-center gap-2">
           <span className="font-mono text-[11px] font-medium text-primary">
             {proposal.toolName}
           </span>
           <span className={clsx("text-[10px] flex items-center gap-1", getRiskColor(proposal.riskLevel))}>
             <AlertTriangle className="w-3 h-3" />
             {proposal.riskLevel}
           </span>
        </div>
        <div className="text-[10px] text-text-secondary">
          {proposal.status === 'executed' && <span className="flex items-center gap-1 text-success"><CheckCircle className="w-3 h-3"/> done</span>}
          {proposal.status === 'rejected' && <span className="flex items-center gap-1 text-danger"><XCircle className="w-3 h-3"/> rejected</span>}
          {proposal.status === 'pending' && <span className="text-warning">pending</span>}
        </div>
      </div>
      
      <div className="p-3">
        <p className="text-[12px] text-text-secondary mb-2">{proposal.description}</p>
        
        <div className="bg-editor rounded p-2 text-[10px] font-mono text-text-disabled overflow-x-auto mb-3">
           {JSON.stringify(proposal.parameters, null, 2)}
        </div>
        
        {proposal.status === 'pending' && (
          <div className="flex gap-2">
            <button 
              onClick={handleReview}
              className="flex-1 bg-primary hover:bg-primary/80 text-text-bright text-[11px] font-medium py-1.5 px-3 rounded flex items-center justify-center gap-1 transition-colors"
            >
              <Play className="w-3 h-3" />
              Review
            </button>
            <button 
              onClick={handleReject}
              className="px-3 py-1.5 text-text-secondary hover:text-danger text-[11px] font-medium transition-colors"
            >
              Reject
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
