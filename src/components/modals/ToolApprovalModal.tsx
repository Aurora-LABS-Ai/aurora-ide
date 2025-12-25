import React from 'react';
import { DiffEditor } from '@monaco-editor/react';
import { useUiStore } from '../../store/useUiStore';
import { useChatStore } from '../../store/useChatStore';
import { X, AlertTriangle, Check, ShieldAlert } from 'lucide-react';
import clsx from 'clsx';

export const ToolApprovalModal: React.FC = () => {
  const { toolApprovalState, closeToolApproval } = useUiStore();
  const { isOpen, proposal } = toolApprovalState;
  const { updateToolStatus, messages } = useChatStore();

  if (!isOpen || !proposal) return null;

  const message = messages.find(m => m.toolProposal?.id === proposal.id);
  
  const handleApprove = () => {
    if (message) {
      updateToolStatus(message.id, 'executed');
    }
    closeToolApproval();
  };

  const handleReject = () => {
    if (message) {
      updateToolStatus(message.id, 'rejected');
    }
    closeToolApproval();
  };

  const original = proposal.originalContent || '';
  const modified = proposal.modifiedContent || '';

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50">
      <div className="bg-sidebar border border-border rounded-lg shadow-2xl w-[90vw] h-[85vh] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="px-5 py-3 border-b border-border flex items-center justify-between bg-panel-header">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-primary/20 rounded">
               <ShieldAlert className="w-5 h-5 text-primary" />
            </div>
            <div>
              <h2 className="text-[14px] font-semibold text-text-primary">Approve Tool Execution</h2>
              <p className="text-[12px] text-text-secondary">Review the proposed changes before proceeding.</p>
            </div>
          </div>
          <button 
            onClick={closeToolApproval}
            className="p-1 text-text-secondary hover:text-text-primary transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 flex flex-col overflow-hidden">
          {/* Info Bar */}
          <div className="px-5 py-3 bg-titlebar border-b border-border grid grid-cols-2 gap-4">
             <div>
               <label className="text-[11px] font-semibold text-text-secondary uppercase tracking-wider block mb-1">Tool</label>
               <div className="font-mono text-[12px] text-primary bg-primary/10 inline-block px-2 py-1 rounded border border-primary/30">
                 {proposal.toolName}
               </div>
             </div>
             <div>
               <label className="text-[11px] font-semibold text-text-secondary uppercase tracking-wider block mb-1">Risk Level</label>
               <div className={clsx("font-medium text-[12px] flex items-center gap-2", 
                 proposal.riskLevel === 'high' ? "text-danger" :
                 proposal.riskLevel === 'medium' ? "text-warning" : "text-success"
               )}>
                 <AlertTriangle className="w-4 h-4" />
                 {proposal.riskLevel.toUpperCase()}
               </div>
             </div>
          </div>

          {/* Diff View */}
          <div className="flex-1 relative bg-editor">
             <DiffEditor 
               original={original}
               modified={modified}
               language="typescript"
               theme="aurora-dark"
               options={{
                 renderSideBySide: true,
                 minimap: { enabled: false },
                 scrollBeyondLastLine: false,
                 readOnly: true,
                 fontSize: 13,
               }}
             />
          </div>
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-border bg-panel-header flex justify-end gap-2">
          <button 
            onClick={handleReject}
            className="px-4 py-2 text-[12px] font-medium text-text-primary hover:bg-input border border-border rounded transition-colors"
          >
            Cancel
          </button>
          <button 
            onClick={handleApprove}
            className="px-4 py-2 text-[12px] font-medium text-text-bright bg-success hover:bg-success/80 rounded flex items-center gap-2 transition-colors"
          >
            <Check className="w-4 h-4" />
            Approve
          </button>
        </div>
      </div>
    </div>
  );
};
