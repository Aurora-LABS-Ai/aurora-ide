import React from 'react';
import { AlertTriangle, X } from 'lucide-react';

interface DeleteConfirmDialogProps {
  isOpen: boolean;
  threadTitle: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export const DeleteConfirmDialog: React.FC<DeleteConfirmDialogProps> = ({
  isOpen,
  threadTitle,
  onConfirm,
  onCancel,
}) => {
  if (!isOpen) return null;

  return (
    <div 
      className="fixed inset-0 bg-black/70 flex items-center justify-center z-[60] backdrop-blur-sm"
      onClick={onCancel}
    >
      <div 
        className="bg-sidebar border border-border rounded-2xl shadow-2xl w-[400px] overflow-hidden animate-in fade-in zoom-in-95 duration-150"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="p-4 flex items-start gap-4">
          <div className="w-12 h-12 rounded-xl bg-danger/10 flex items-center justify-center shrink-0">
            <AlertTriangle className="w-6 h-6 text-danger" />
          </div>
          
          <div className="flex-1 min-w-0">
            <h3 className="text-[15px] font-semibold text-text-primary mb-1">
              Delete Conversation
            </h3>
            <p className="text-[13px] text-text-secondary leading-relaxed">
              Are you sure you want to delete this conversation? This action cannot be undone.
            </p>
          </div>

          <button
            onClick={onCancel}
            className="p-1.5 rounded-lg text-text-disabled hover:text-text-primary hover:bg-input transition-colors shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Thread Info */}
        <div className="mx-4 mb-4 p-3 bg-input/50 rounded-xl border border-border">
          <p className="text-[12px] text-text-disabled mb-1">Thread to delete:</p>
          <p className="text-[13px] text-text-primary font-medium truncate">
            {threadTitle || 'Untitled conversation'}
          </p>
        </div>

        {/* Actions */}
        <div className="p-4 bg-titlebar border-t border-border flex items-center justify-end gap-3">
          <button
            onClick={onCancel}
            className="px-4 py-2 rounded-xl text-[13px] font-medium text-text-secondary hover:text-text-primary bg-input hover:bg-input-border border border-border transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className="px-4 py-2 rounded-xl text-[13px] font-medium text-white bg-danger hover:bg-danger/80 transition-colors"
          >
            Delete
          </button>
        </div>
      </div>
    </div>
  );
};

