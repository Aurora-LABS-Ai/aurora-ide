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

import React, { useState, useRef, useEffect } from 'react';
import { Palette, Check } from 'lucide-react';
import { useThemeStore } from '../../store/useThemeStore';
import clsx from 'clsx';

export const ThemeDropdown: React.FC = () => {
    const { themes, activeThemeId, setActiveTheme } = useThemeStore();
    const [isOpen, setIsOpen] = useState(false);
    const dropdownRef = useRef<HTMLDivElement>(null);
    const [previewThemeId, setPreviewThemeId] = useState<string | null>(null);
    const originalThemeIdRef = useRef<string>(activeThemeId);

    // Update ref when active theme changes (committed)
    useEffect(() => {
        if (!isOpen) {
            originalThemeIdRef.current = activeThemeId;
        }
    }, [activeThemeId, isOpen]);

    // Close on click outside
    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
                setIsOpen(false);
                // Revert if previewing
                if (previewThemeId && previewThemeId !== originalThemeIdRef.current) {
                    setActiveTheme(originalThemeIdRef.current);
                    setPreviewThemeId(null);
                }
            }
        };

        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, [previewThemeId, setActiveTheme]);

    const handleMouseEnter = (themeId: string) => {
        setPreviewThemeId(themeId);
        setActiveTheme(themeId);
    };

    const handleMouseLeaveDropdown = () => {
        // If we haven't selected (clicked), revert to original
        if (isOpen) {
            setActiveTheme(originalThemeIdRef.current);
            setPreviewThemeId(null);
        }
    };

    const handleSelect = (themeId: string) => {
        setActiveTheme(themeId);
        originalThemeIdRef.current = themeId; // Commit
        setPreviewThemeId(null);
        setIsOpen(false);
    };

    return (
        <div className="relative" ref={dropdownRef}>
            <button
                onClick={() => setIsOpen(!isOpen)}
                className={clsx(
                    "p-1.5 rounded transition-colors",
                    isOpen ? "text-primary bg-primary/10" : "text-text-secondary hover:text-text-primary hover:bg-input/50"
                )}
                title="Change Theme"
            >
                <Palette className="w-3.5 h-3.5" />
            </button>

            {isOpen && (
                <div
                    className="absolute top-full right-0 mt-2 w-64 bg-sidebar border border-border rounded-xl shadow-xl shadow-black/50 z-50 overflow-hidden animate-in fade-in zoom-in-95 duration-100"
                    onMouseLeave={handleMouseLeaveDropdown}
                >
                    <div className="p-2 border-b border-border bg-titlebar/50">
                        <span className="text-[11px] font-semibold text-text-secondary uppercase tracking-wider px-2">
                            Select Theme
                        </span>
                    </div>

                    <div className="max-h-[300px] overflow-y-auto p-2 space-y-2">
                        {themes.map((theme) => {
                            const isActive = theme.id === (previewThemeId || activeThemeId);
                            const isOriginal = theme.id === originalThemeIdRef.current;

                            // Extract key colors for preview
                            const bg = theme.colors.editor.background;
                            const fg = theme.colors.editor.foreground;
                            const sidebar = theme.colors.sidebar.background;
                            const primary = theme.colors.common.primary;
                            const activity = theme.colors.sidebar.itemActive;

                            return (
                                <button
                                    key={theme.id}
                                    className={clsx(
                                        "w-full text-left p-2 rounded-lg border transition-all relative overflow-hidden group",
                                        isActive
                                            ? "bg-input/50 border-primary ring-1 ring-primary shadow-sm"
                                            : "bg-input/20 border-border hover:border-primary/50 hover:bg-input/40"
                                    )}
                                    onMouseEnter={() => handleMouseEnter(theme.id)}
                                    onClick={() => handleSelect(theme.id)}
                                >
                                    <div className="flex items-center justify-between mb-2">
                                        <div className="flex flex-col min-w-0">
                                            <span className={clsx(
                                                "text-[12px] font-medium truncate flex items-center gap-1.5",
                                                isActive ? "text-primary" : "text-text-primary"
                                            )}>
                                                {theme.name}
                                                {isOriginal && <Check size={10} className="text-primary" />}
                                                {theme.isBuiltIn && <span className="text-[9px] px-1 rounded bg-secondary/30 text-text-secondary">Built-in</span>}
                                            </span>
                                            <div className="flex items-center gap-1">
                                                <span className="text-[9px] text-text-secondary truncate">
                                                    by {theme.author}
                                                </span>
                                            </div>
                                        </div>
                                    </div>

                                    {/* Mini Preview Strip */}
                                    <div className="h-8 w-full rounded border border-border/50 overflow-hidden flex shadow-sm opacity-90 group-hover:opacity-100 transition-opacity">
                                        {/* Sidebar strip */}
                                        <div style={{ backgroundColor: sidebar }} className="w-6 flex flex-col items-center py-1 gap-0.5">
                                            <div className="w-2.5 h-2.5 rounded-[2px]" style={{ backgroundColor: activity }}></div>
                                            <div className="w-2.5 h-2.5 rounded-[2px] opacity-20 bg-white"></div>
                                        </div>
                                        {/* Editor area */}
                                        <div style={{ backgroundColor: bg, color: primary }} className="flex-1 px-1.5 flex items-center text-[8px] font-mono">
                                            <div className="flex gap-1">
                                                <span style={{ color: theme.colors.common.primary }}>const</span>
                                                <span style={{ color: fg }}>App</span>
                                            </div>
                                        </div>
                                    </div>
                                </button>
                            );
                        })}
                    </div>
                </div>
            )}
        </div>
    );
};
