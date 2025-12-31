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
 * TreeNodeCreateInput Component
 * Input field for creating new files/folders
 */

import React, { useRef, useEffect } from 'react';
import { FileIcon, FolderIcon } from '../FileIcons';

interface TreeNodeCreateInputProps {
    type: 'file' | 'folder';
    value: string;
    level: number;
    parentPath?: string;
    onChange: (value: string) => void;
    onSubmit: () => void;
    onCancel: () => void;
}

export const TreeNodeCreateInput: React.FC<TreeNodeCreateInputProps> = ({
    type,
    value,
    level,
    parentPath,
    onChange,
    onSubmit,
    onCancel,
}) => {
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        inputRef.current?.focus();
    }, []);

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter') {
            onSubmit();
        } else if (e.key === 'Escape') {
            onCancel();
        }
    };

    return (
        <div
            className="flex items-center gap-1 py-[2px] px-2"
            style={{ paddingLeft: `${(level + 1) * 12 + 8}px` }}
        >
            <span className="text-text-secondary">
                <div className="w-4" />
            </span>

            {/* Dynamic icon based on input value */}
            {type === 'folder' ? (
                <FolderIcon name={value || 'folder'} className="w-4 h-4" open={false} path={parentPath ? `${parentPath}/${value}` : undefined} />
            ) : (
                <FileIcon name={value || ''} className="w-4 h-4" path={parentPath ? `${parentPath}/${value}` : undefined} />
            )}

            <input
                ref={inputRef}
                type="text"
                value={value}
                onChange={(e) => onChange(e.target.value)}
                onKeyDown={handleKeyDown}
                onBlur={onSubmit}
                placeholder={type === 'file' ? 'filename.ext' : 'folder name'}
                className="flex-1 bg-input border border-primary rounded px-1.5 py-0.5 text-[13px] text-text-primary outline-none placeholder:text-text-disabled"
            />
        </div>
    );
};
