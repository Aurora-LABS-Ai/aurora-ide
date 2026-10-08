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
 * See: src/kernel/types/theme.ts for TypeScript interfaces
 * See: src/apps/ide/services/theme-service.ts for theme utilities
 */

import React, { useState, useEffect, useMemo, useRef } from 'react';
import { useEditorStore } from '@/kernel/store/useEditorStore';
import { useWorkspaceStore } from '@/kernel/store/useWorkspaceStore';
import { Search, FileCode, CornerDownLeft } from 'lucide-react';
import { clsx } from 'clsx';
import { motion, AnimatePresence } from 'framer-motion';
import { readFileContent } from '@/kernel/lib/ipc/tauri';
import type { FileNode } from '@/kernel/types';

/** Rows shown at most. */
const MAX_RESULTS = 50;

// Helper to flatten file tree
const flattenFiles = (files: FileNode[]): string[] => {
    const result: string[] = [];
    for (const f of files) {
        if (f.type === 'file') {
            if (f.path) result.push(f.path);
        } else if (f.children) {
            result.push(...flattenFiles(f.children));
        }
    }
    return result;
};

export const QuickOpenModal: React.FC<{ isOpen: boolean; onClose: () => void }> = ({ isOpen, onClose }) => {
    const [query, setQuery] = useState('');
    // The query the list is filtered by: `query`, 150 ms behind while typing.
    const [searchedQuery, setSearchedQuery] = useState('');
    const [selectedIndex, setSelectedIndex] = useState(0);
    const inputRef = useRef<HTMLInputElement>(null);
    const listRef = useRef<HTMLDivElement>(null);

    const { openFile } = useEditorStore();
    const { files } = useWorkspaceStore();

    // ────────────────────────────────────────────────────────────────────
    // ⚠️  The cursor must never follow `files`.
    //
    // Bug we fixed: "reset on open" and "rebuild the file list" once
    // shared an effect on [isOpen, files]. The workspace store re-emits a
    // fresh `files` reference very often (watcher, refresh, expand), so
    // the cursor snapped back to the top on every emit, whatever ArrowDown
    // or hover said. The path index and results below are derived from
    // `files`; the cursor is only reset on open and on a new query, and is
    // clamped (not reset) when the list shrinks.
    // ────────────────────────────────────────────────────────────────────

    // Reset cursor + query when the modal opens. Done while rendering (the
    // React pattern for "adjust state when a prop changes"), not in an
    // effect, so the first open frame already shows the cleared state.
    const [wasOpen, setWasOpen] = useState(isOpen);
    if (isOpen !== wasOpen) {
        setWasOpen(isOpen);
        if (isOpen) {
            setQuery('');
            setSearchedQuery('');
            setSelectedIndex(0);
        }
    }

    useEffect(() => {
        if (!isOpen) return;
        const t = window.setTimeout(() => inputRef.current?.focus(), 50);
        return () => window.clearTimeout(t);
    }, [isOpen]);

    const allFilePaths = useMemo(() => (isOpen ? flattenFiles(files) : []), [isOpen, files]);

    // Debounced filter on the path index.
    useEffect(() => {
        const timer = window.setTimeout(() => setSearchedQuery(query), 150);
        return () => window.clearTimeout(timer);
    }, [query]);

    const results = useMemo(() => {
        if (!searchedQuery) return allFilePaths.slice(0, MAX_RESULTS);
        const lowerQuery = searchedQuery.toLowerCase();
        return allFilePaths.filter((f) => f.toLowerCase().includes(lowerQuery)).slice(0, MAX_RESULTS);
    }, [searchedQuery, allFilePaths]);

    // The cursor as shown: clamped when the list shrank under it (a
    // workspace re-emit removed files while a search was active).
    const activeIndex = results.length === 0 ? 0 : Math.min(selectedIndex, results.length - 1);

    // Handle Input
    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            setSelectedIndex(Math.min(activeIndex + 1, results.length - 1));
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setSelectedIndex(Math.max(activeIndex - 1, 0));
        } else if (e.key === 'Enter') {
            e.preventDefault();
            if (results[activeIndex]) {
                handleSelect(results[activeIndex]);
            }
        } else if (e.key === 'Escape') {
            e.preventDefault();
            onClose();
        }
    };

    // Language detection helper
    const detectLanguage = (filename: string): string => {
        const ext = filename.split('.').pop()?.toLowerCase() || '';
        const langMap: Record<string, string> = {
            'ts': 'typescript', 'tsx': 'typescript',
            'js': 'javascript', 'jsx': 'javascript',
            'json': 'json', 'css': 'css', 'scss': 'scss',
            'html': 'html', 'md': 'markdown',
            'rs': 'rust', 'toml': 'toml',
            'yaml': 'yaml', 'yml': 'yaml',
            'py': 'python', 'go': 'go',
            'txt': 'plaintext',
        };
        return langMap[ext] || 'plaintext';
    };

    const handleSelect = async (path: string) => {
        const filename = path.split('/').pop() || path.split('\\').pop() || path;

        try {
            // Read file content from disk
            const content = await readFileContent(path);
            const language = detectLanguage(filename);
            openFile(path, filename, content || '', language);
        } catch (error) {
            console.error('Failed to read file:', path, error);
            // Open with empty content if reading fails
            const language = detectLanguage(filename);
            openFile(path, filename, '// Failed to load file', language);
        }

        onClose();
    };

    if (!isOpen) return null;

    return (
        <AnimatePresence>
            <div className="fixed inset-0 z-[100] flex items-start justify-center pt-[15vh]" onMouseDown={onClose}>
                <motion.div
                    initial={{ opacity: 0, y: -20 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, scale: 0.95 }}
                    transition={{ duration: 0.1 }}
                    className="w-[600px] max-w-full bg-sidebar border border-border rounded-xl shadow-2xl shadow-black/50 flex flex-col overflow-hidden"
                    onMouseDown={e => e.stopPropagation()}
                >
                    <div className="flex items-center px-3 py-3 border-b border-border bg-input/30">
                        <Search size={16} className="text-text-secondary mr-2" />
                        <input
                            ref={inputRef}
                            type="text"
                            className="flex-1 bg-transparent border-none outline-none text-sm text-text-primary placeholder:text-text-disabled"
                            placeholder="Search files by name..."
                            value={query}
                            onChange={e => {
                                // A new query makes the old cursor meaningless.
                                setQuery(e.target.value);
                                setSelectedIndex(0);
                            }}
                            onKeyDown={handleKeyDown}
                        />
                        <div className="text-[10px] text-muted-foreground bg-input/50 px-2 py-0.5 rounded">ESC to close</div>
                    </div>

                    <div className="max-h-[300px] overflow-y-auto py-1 scrollbar-thin" ref={listRef}>
                        {results.length === 0 ? (
                            <div className="px-4 py-8 text-center text-xs text-text-disabled">
                                {query ? 'No matching files found' : 'Type to search files...'}
                            </div>
                        ) : (
                            results.map((file, index) => {
                                const filename = file.split('/').pop()?.split('\\').pop() || file;
                                return (
                                    <div
                                        key={file}
                                        className={clsx(
                                            "px-3 py-2 flex items-center gap-3 cursor-pointer text-sm",
                                            index === activeIndex ? "bg-primary/20 text-text-primary" : "text-text-secondary hover:bg-sidebar-item-hover"
                                        )}
                                        onMouseEnter={() => setSelectedIndex(index)}
                                        onClick={() => handleSelect(file)}
                                    >
                                        <FileCode size={14} className={index === activeIndex ? "text-primary" : "opacity-50"} />
                                        <div className="flex-1 truncate flex items-center justify-between">
                                            <span>{filename}</span>
                                            <span className="text-[10px] opacity-50 truncate max-w-[200px] ml-2">{file}</span>
                                        </div>
                                        {index === activeIndex && <CornerDownLeft size={12} className="opacity-50" />}
                                    </div>
                                );
                            })
                        )}
                    </div>

                    <div className="px-3 py-1.5 bg-input/30 border-t border-border text-[10px] text-muted-foreground flex justify-between">
                        <span>Quick Open</span>
                        <span>{results.length} results</span>
                    </div>
                </motion.div>
            </div>
        </AnimatePresence>
    );
};
