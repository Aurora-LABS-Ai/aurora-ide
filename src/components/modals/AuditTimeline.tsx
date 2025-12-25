import React from 'react';
import { useUiStore } from '../../store/useUiStore';
import { useChatStore } from '../../store/useChatStore';
import { X, CheckCircle, XCircle, Clock, AlertTriangle } from 'lucide-react';
import { format } from 'date-fns';
import clsx from 'clsx';

export const AuditTimeline: React.FC = () => {
  const { isAuditOpen, setAuditOpen } = useUiStore();
  const { messages } = useChatStore();

  if (!isAuditOpen) return null;

  const auditItems = messages.filter(m => m.toolProposal).reverse();

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div className="bg-sidebar border border-border rounded-lg shadow-2xl w-[550px] h-[65vh] flex flex-col overflow-hidden">
        <div className="h-12 border-b border-border flex items-center justify-between px-5 bg-panel-header">
           <h2 className="text-[14px] font-medium text-text-primary">Audit Timeline</h2>
           <button 
             onClick={() => setAuditOpen(false)}
             className="p-1 rounded text-text-secondary hover:bg-input hover:text-text-primary transition-colors"
           >
             <X className="w-4 h-4" />
           </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 bg-sidebar">
          {auditItems.length === 0 ? (
            <div className="text-center text-text-secondary py-10 text-[13px]">
              No actions recorded yet.
            </div>
          ) : (
            <div className="relative border-l border-border ml-2 space-y-4">
              {auditItems.map((item) => {
                 const proposal = item.toolProposal!;
                 return (
                   <div key={item.id} className="ml-5 relative">
                     {/* Timeline dot */}
                     <div className={clsx(
                       "absolute -left-[23px] top-0 w-3 h-3 rounded-full border-2 border-sidebar",
                       proposal.status === 'executed' ? "bg-success" :
                       proposal.status === 'rejected' ? "bg-danger" :
                       "bg-warning"
                     )} />
                     
                     <div className="bg-msg-ai border border-border rounded p-3">
                        <div className="flex items-start justify-between mb-2">
                           <div>
                             <div className="flex items-center gap-2 mb-1">
                               <span className="font-mono text-[11px] font-semibold text-primary">{proposal.toolName}</span>
                               <span className="text-[10px] text-text-disabled">{format(item.timestamp, 'MMM d, HH:mm:ss')}</span>
                             </div>
                             <p className="text-[12px] text-text-primary">{proposal.description}</p>
                           </div>
                           
                           <div className={clsx("flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded",
                             proposal.status === 'executed' ? "bg-success/20 text-success" :
                             proposal.status === 'rejected' ? "bg-danger/20 text-danger" :
                             "bg-warning/20 text-warning"
                           )}>
                             {proposal.status === 'executed' && <CheckCircle className="w-3 h-3" />}
                             {proposal.status === 'rejected' && <XCircle className="w-3 h-3" />}
                             {proposal.status === 'pending' && <Clock className="w-3 h-3" />}
                             {proposal.status.toUpperCase()}
                           </div>
                        </div>
                        
                        <div className="bg-input rounded p-2 text-[10px] font-mono text-text-secondary">
                          {proposal.parameters.path && <div>Target: {proposal.parameters.path}</div>}
                          <div className="flex items-center gap-1">
                            Risk: <AlertTriangle className="w-3 h-3 text-warning" /> {proposal.riskLevel.toUpperCase()}
                          </div>
                        </div>
                     </div>
                   </div>
                 );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
