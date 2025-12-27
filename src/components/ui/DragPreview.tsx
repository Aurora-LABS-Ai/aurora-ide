/**
 * DragPreview Component
 * Shows a floating preview of the dragged item following the cursor
 */

import React from 'react';
import { useDragStore } from '../../store/useDragStore';
import { FileIcon, FolderIcon } from '../explorer/FileIcons';

export const DragPreview: React.FC = () => {
  const { isDragging, draggedName, mouseX, mouseY } = useDragStore();

  if (!isDragging || !draggedName) return null;

  // Determine if it's a folder (simple heuristic - no extension)
  const isFolder = !draggedName.includes('.') || draggedName.startsWith('.');

  return (
    <div
      className="fixed pointer-events-none z-[9999] flex items-center gap-2 px-2 py-1 bg-[#2d2d2d] border border-primary/50 rounded shadow-lg text-[13px] text-text-primary"
      style={{
        left: mouseX + 12,
        top: mouseY + 12,
      }}
    >
      {isFolder ? (
        <FolderIcon name={draggedName} className="w-4 h-4" open={false} />
      ) : (
        <FileIcon name={draggedName} className="w-4 h-4" />
      )}
      <span className="truncate max-w-[200px]">{draggedName}</span>
    </div>
  );
};
