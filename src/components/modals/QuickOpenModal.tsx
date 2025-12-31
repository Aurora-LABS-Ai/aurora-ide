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

import React, { useState, useEffect, useRef } from 'react';
import { useEditorStore } from '../../store/useEditorStore';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { Search, FileCode, CornerDownLeft } from 'lucide-react';
import { clsx } from 'clsx';
import { motion, AnimatePresence } from 'framer-motion';
import { readFileContent } from '../../lib/tauri';

// Helper to flatten file tree
const flattenFiles = (files: any[]): string[] => {
    let result: string[] = [];
    files.forEach(f => {
        if (f.type === 'file') {
            result.push(f.path);
        } else if (f.children) {
            result = result.concat(flattenFiles(f.children));
        }
    });
    return result;
};

export const QuickOpenModal: React.FC<{ isOpen: boolean; onClose: () => void }> = ({ isOpen, onClose }) => {
    const [query, setQuery] = useState('');
    const [selectedIndex, setSelectedIndex] = useState(0);
    const inputRef = useRef<HTMLInputElement>(null);
    const listRef = useRef<HTMLDivElement>(null);

    const { openFile } = useEditorStore();
    const { files } = useWorkspaceStore();

    const [results, setResults] = useState<string[]>([]);
    const [allFilePaths, setAllFilePaths] = useState<string[]>([]);

    useEffect(() => {
        if (isOpen) {
            setQuery('');
            setSelectedIndex(0);
            setTimeout(() => inputRef.current?.focus(), 50);

            // Flatten current workspace files for search
            const paths = flattenFiles(files);
            setAllFilePaths(paths);
            setResults(paths.slice(0, 50)); // Show initial list
        }
    }, [isOpen, files]);

    // Handle Input
    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            setSelectedIndex(i => Math.min(i + 1, results.length - 1));
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setSelectedIndex(i => Math.max(i - 1, 0));
        } else if (e.key === 'Enter') {
            e.preventDefault();
            if (results[selectedIndex]) {
                handleSelect(results[selectedIndex]);
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
            openFile(path, filename, content, language);
        } catch (error) {
            console.error('Failed to read file:', path, error);
            // Open with empty content if reading fails
            const language = detectLanguage(filename);
            openFile(path, filename, '', language);
        }

        onClose();
    };

    // Search Effect
    useEffect(() => {
        // Debounce search
        const timer = setTimeout(() => {
            if (!query) {
                setResults(allFilePaths.slice(0, 50));
                return;
            }

            const lowerQuery = query.toLowerCase();
            const filtered = allFilePaths
                .filter(f => f.toLowerCase().includes(lowerQuery))
                .slice(0, 50); // Limit results for performance

            setResults(filtered);
            setSelectedIndex(0);
        }, 150);

        return () => clearTimeout(timer);
    }, [query, allFilePaths]);

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
                    <div className="flex items-center px-3 py-3 border-b border-white/5 bg-white/[0.02]">
                        <Search size={16} className="text-text-secondary mr-2" />
                        <input
                            ref={inputRef}
                            type="text"
                            className="flex-1 bg-transparent border-none outline-none text-sm text-text-primary placeholder:text-text-disabled"
                            placeholder="Search files by name..."
                            value={query}
                            onChange={e => setQuery(e.target.value)}
                            onKeyDown={handleKeyDown}
                        />
                        <div className="text-[10px] text-zinc-500 bg-white/5 px-2 py-0.5 rounded">ESC to close</div>
                    </div>

                    <div className="max-h-[300px] overflow-y-auto py-1 custom-scrollbar" ref={listRef}>
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
                                            index === selectedIndex ? "bg-primary/20 text-zinc-100" : "text-zinc-400 hover:bg-white/[0.03]"
                                        )}
                                        onMouseEnter={() => setSelectedIndex(index)}
                                        onClick={() => handleSelect(file)}
                                    >
                                        <FileCode size={14} className={index === selectedIndex ? "text-primary" : "opacity-50"} />
                                        <div className="flex-1 truncate flex items-center justify-between">
                                            <span>{filename}</span>
                                            <span className="text-[10px] opacity-50 truncate max-w-[200px] ml-2">{file}</span>
                                        </div>
                                        {index === selectedIndex && <CornerDownLeft size={12} className="opacity-50" />}
                                    </div>
                                );
                            })
                        )}
                    </div>

                    <div className="px-3 py-1.5 bg-white/[0.02] border-t border-white/5 text-[10px] text-zinc-400 flex justify-between">
                        <span>Quick Open</span>
                        <span>{results.length} results</span>
                    </div>
                </motion.div>
            </div>
        </AnimatePresence>
    );
};
