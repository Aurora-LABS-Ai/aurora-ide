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

import React from 'react';
import { AlertTriangle, X } from 'lucide-react';

interface DeleteConfirmDialogProps {
  isOpen: boolean;
  /** @deprecated Use itemName instead */
  threadTitle?: string;
  /** Name of the item to delete */
  itemName?: string;
  /** Type of item being deleted (for display text) */
  itemType?: 'conversation' | 'file' | 'folder' | 'server';
  onConfirm: () => void;
  onCancel: () => void;
}

export const DeleteConfirmDialog: React.FC<DeleteConfirmDialogProps> = ({
  isOpen,
  threadTitle,
  itemName,
  itemType = 'conversation',
  onConfirm,
  onCancel,
}) => {
  // Support both old threadTitle and new itemName props
  const displayName = itemName ?? threadTitle ?? '';

  const typeLabels = {
    conversation: { title: 'Delete Conversation', label: 'Conversation to delete:', fallback: 'Untitled conversation' },
    file: { title: 'Delete File', label: 'File to delete:', fallback: 'Untitled file' },
    folder: { title: 'Delete Folder', label: 'Folder to delete:', fallback: 'Untitled folder' },
    server: { title: 'Remove MCP Server', label: 'Server to remove:', fallback: 'Unnamed server' },
  };

  const labels = typeLabels[itemType];

  if (!isOpen) return null;

  return (
    <div 
      className="fixed inset-0 bg-black/70 flex items-center justify-center z-[150] backdrop-blur-sm"
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
              {labels.title}
            </h3>
            <p className="text-[13px] text-text-secondary leading-relaxed">
              Are you sure you want to delete this {itemType}? This action cannot be undone.
            </p>
          </div>

          <button
            onClick={onCancel}
            className="p-1.5 rounded-lg text-text-disabled hover:text-text-primary hover:bg-input transition-colors shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Item Info */}
        <div className="mx-4 mb-4 p-3 bg-input/50 rounded-xl border border-border">
          <p className="text-[12px] text-text-disabled mb-1">{labels.label}</p>
          <p className="text-[13px] text-text-primary font-medium truncate">
            {displayName || labels.fallback}
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

