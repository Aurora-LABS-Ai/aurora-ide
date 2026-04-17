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
 * TreeNodeRow Component
 * Visual representation of a file/folder row with mouse-based drag support
 */

import React, { useCallback } from 'react';
import { ChevronRight } from 'lucide-react';
import clsx from 'clsx';
import { FileIcon, FolderIcon } from '../FileIcons';
import { useDragStore } from '../../../store/useDragStore';

interface TreeNodeRowProps {
    name: string;
    path: string;
    isFolder: boolean;
    isExpanded: boolean;
    isSelected: boolean;
    level: number;
    onClick: () => void;
    onContextMenu: (e: React.MouseEvent) => void;
}

export const TreeNodeRow: React.FC<TreeNodeRowProps> = ({
    name,
    path,
    isFolder,
    isExpanded,
    isSelected,
    level,
    onClick,
    onContextMenu,
}) => {
    const { isDragging, dropTargetPath, prepareDrag, draggedPath } = useDragStore();

    // Check if this folder is the current drop target
    const isDropTarget = isDragging && isFolder && dropTargetPath === path;

    // Check if this is the item being dragged
    const isBeingDragged = isDragging && draggedPath === path;

    const handleMouseDown = useCallback((e: React.MouseEvent) => {
        // Only left click
        if (e.button !== 0) return;
        if (isFolder) return;

        // Prepare drag - actual drag starts after mouse moves past threshold
        prepareDrag(path, name, e.clientX, e.clientY);
    }, [isFolder, path, name, prepareDrag]);

    const handleClick = useCallback(() => {
        // Read current state - closure values may be stale
        const state = useDragStore.getState();
        // Ignore clicks only while an actual drag is active.
        if (state.isDragging) {
            return;
        }
        onClick();
    }, [onClick]);

    // Calculate indent guides
    const indentGuides = [];
    for (let i = 0; i < level; i++) {
        indentGuides.push(
            <div
                key={i}
                className="absolute w-px h-full transition-colors duration-300"
                style={{
                    left: `${i * 12 + 15}px`,
                    backgroundColor: 'var(--aurora-editor-indent-guide)',
                    opacity: 0.2 // Subtle opacity for guides
                }}
            />
        );
    }

    return (
        <div
            className={clsx(
                "group relative mx-1 my-[1px] flex items-center gap-1.5 rounded-[10px] py-[4px] pr-2.5 cursor-pointer select-none transition-all duration-150",
                // Drag states
                isDropTarget && "ring-1 ring-[var(--aurora-common-primary)] z-10",
                isBeingDragged && "opacity-50 grayscale"
            )}
            style={{
                paddingLeft: `${level * 12 + 12}px`,
                backgroundColor: isSelected
                    ? 'color-mix(in srgb, var(--aurora-common-primary) 10%, var(--aurora-sidebar-item-selected))'
                    : undefined,
                boxShadow: isSelected
                    ? 'inset 0 1px 0 color-mix(in srgb, var(--aurora-common-primary-foreground) 5%, transparent), inset 0 -1px 0 color-mix(in srgb, var(--aurora-common-shadow) 10%, transparent)'
                    : undefined,
                // Add hover effect manually to avoid conflict with selected state
                cursor: 'pointer'
            }}
            // Hover effect via style injection on events to support complex gradients if needed, 
            // or rely on CSS classes if tokens support it. Here we use inline styles for strict token adherence.
            onMouseEnter={(e) => {
                if (!isSelected) e.currentTarget.style.backgroundColor = 'color-mix(in srgb, var(--aurora-sidebar-item-hover) 78%, transparent)';
            }}
            onMouseLeave={(e) => {
                if (!isSelected) e.currentTarget.style.backgroundColor = 'transparent';
            }}
            onClick={handleClick}
            onMouseDown={handleMouseDown}
            onContextMenu={onContextMenu}
            draggable={false}
            data-file-path={path}
            {...(isFolder ? { 'data-folder-path': path } : {})}
        >
            {/* Active Border Accent - Absolute positioned to avoid layout shift */}
            {isSelected && (
                <div
                    className="absolute bottom-[5px] left-0.5 top-[5px] w-[2px] rounded-full"
                    style={{ backgroundColor: 'var(--aurora-common-primary)' }}
                />
            )}

            {/* Indent Guides */}
            {indentGuides}

            {/* Chevron / Spacer */}
            <span className={clsx(
                "z-10 flex h-4 w-4 items-center justify-center transition-transform duration-200",
                isFolder && isExpanded && "rotate-90"
            )} style={{ color: 'var(--aurora-sidebar-foreground)', opacity: 0.7 }}>
                {isFolder && <ChevronRight className="w-3.5 h-3.5" />}
            </span>

            {/* Icon */}
            <div className="flex items-center justify-center z-10 relative">
                {isFolder ? (
                    <FolderIcon name={name} className="w-4 h-4 drop-shadow-sm" open={isExpanded} path={path} />
                ) : (
                    <FileIcon name={name} className="w-4 h-4 drop-shadow-sm" path={path} />
                )}
            </div>

            {/* Filename */}
            <span className={clsx(
                "relative z-10 ml-1 truncate text-[12px] transition-colors"
            )} style={{
                color: isSelected ? 'var(--aurora-common-primary-foreground)' : 'var(--aurora-sidebar-foreground)',
                fontWeight: isSelected ? 500 : 400
            }}>
                {name}
            </span>
        </div>
    );
};
