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
 * TreeNodeRenameInput Component
 * Input field for renaming files/folders
 */

import React, { useRef, useEffect } from 'react';
import { ChevronRight } from 'lucide-react';
import { FileIcon, FolderIcon } from '../FileIcons';

interface TreeNodeRenameInputProps {
    name: string;
    value: string;
    isFolder: boolean;
    level: number;
    path?: string;
    onChange: (value: string) => void;
    onSubmit: () => void;
    onCancel: () => void;
}

export const TreeNodeRenameInput: React.FC<TreeNodeRenameInputProps> = ({
    name,
    value,
    isFolder,
    level,
    path,
    onChange,
    onSubmit,
    onCancel,
}) => {
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        if (inputRef.current) {
            inputRef.current.focus();
            // Select filename without extension for files
            const lastDot = name.lastIndexOf('.');
            if (lastDot > 0 && !isFolder) {
                inputRef.current.setSelectionRange(0, lastDot);
            } else {
                inputRef.current.select();
            }
        }
    }, [name, isFolder]);

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
            style={{ paddingLeft: `${level * 12 + 8}px` }}
        >
            <span className="text-text-secondary">
                {isFolder && <ChevronRight className="w-4 h-4" />}
                {!isFolder && <div className="w-4" />}
            </span>

            {isFolder ? (
                <FolderIcon name={name} className="w-4 h-4" open={false} path={path} />
            ) : (
                <FileIcon name={name} className="w-4 h-4" path={path} />
            )}

            <input
                ref={inputRef}
                type="text"
                value={value}
                onChange={(e) => onChange(e.target.value)}
                onKeyDown={handleKeyDown}
                onBlur={onSubmit}
                className="flex-1 bg-input border border-primary rounded px-1.5 py-0.5 text-[13px] text-text-primary outline-none"
            />
        </div>
    );
};
