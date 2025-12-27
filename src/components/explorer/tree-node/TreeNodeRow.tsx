/**
 * TreeNodeRow Component
 * Visual representation of a file/folder row with mouse-based drag support
 */

import React, { useCallback } from 'react';
import { ChevronRight, ChevronDown } from 'lucide-react';
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

        // Prepare drag - actual drag starts after mouse moves past threshold
        prepareDrag(path, name, e.clientX, e.clientY);
    }, [path, name, prepareDrag]);

    const handleClick = useCallback(() => {
        // Read current state - closure values may be stale
        const state = useDragStore.getState();
        // If we were dragging or have pending drag, don't trigger click
        if (state.isDragging || state.pendingPath) {
            return;
        }
        onClick();
    }, [onClick]);

    return (
        <div
            className={clsx(
                "flex items-center gap-1 py-[2px] px-2 cursor-pointer select-none hover:bg-input/50 transition-colors",
                isSelected && "bg-input",
                isDropTarget && "bg-primary/20 ring-1 ring-primary/50",
                isBeingDragged && "opacity-50"
            )}
            style={{ paddingLeft: `${level * 12 + 8}px` }}
            onClick={handleClick}
            onMouseDown={handleMouseDown}
            onContextMenu={onContextMenu}
            data-file-path={path}
            {...(isFolder ? { 'data-folder-path': path } : {})}
        >
            <span className="text-text-secondary">
                {isFolder && (
                    isExpanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />
                )}
                {!isFolder && <div className="w-4" />}
            </span>

            {isFolder ? (
                <FolderIcon name={name} className="w-4 h-4" open={isExpanded} path={path} />
            ) : (
                <FileIcon name={name} className="w-4 h-4" path={path} />
            )}

            <span className="text-[13px] truncate text-text-primary">{name}</span>
        </div>
    );
};
