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
      className="fixed pointer-events-none z-[9999] flex items-center gap-2 rounded px-2 py-1 text-[13px] text-text-primary"
      style={{
        left: mouseX + 12,
        top: mouseY + 12,
        background: 'color-mix(in srgb, var(--aurora-sidebar-background) 86%, var(--aurora-chat-surface) 14%)',
        border: '1px solid color-mix(in srgb, var(--aurora-common-primary) 28%, var(--aurora-common-border) 72%)',
        boxShadow: '0 12px 28px color-mix(in srgb, var(--aurora-common-shadow) 26%, transparent)',
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
