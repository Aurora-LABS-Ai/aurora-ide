import React, { useState, useRef, useEffect } from 'react';
import { Check } from 'lucide-react';
import { useThemeStore } from '../../store/useThemeStore';
import { themeService } from '../../services/theme-service';
import clsx from 'clsx';

export const ThemePanel: React.FC = () => {
    const { themes, activeThemeId, setActiveTheme, isLoading, error } = useThemeStore();
    const [previewThemeId, setPreviewThemeId] = useState<string | null>(null);
    const committedThemeIdRef = useRef<string>(activeThemeId);

    // Keep track of the actually committed (clicked) theme
    useEffect(() => {
        committedThemeIdRef.current = activeThemeId;
    }, [activeThemeId]);

    const handleMouseEnter = (themeId: string) => {
        // Only preview if different from current preview
        if (themeId !== previewThemeId) {
            setPreviewThemeId(themeId);
            // Apply theme visually without persisting
            const theme = themes.find(t => t.id === themeId);
            if (theme) {
                themeService.applyTheme(theme);
            }
        }
    };

    const handleMouseLeaveList = () => {
        // Revert to the committed theme when leaving the list
        if (previewThemeId) {
            setPreviewThemeId(null);
            const committedTheme = themes.find(t => t.id === committedThemeIdRef.current);
            if (committedTheme) {
                themeService.applyTheme(committedTheme);
            }
        }
    };

    const handleSelect = (themeId: string) => {
        // Commit the selection - this persists to DB
        setActiveTheme(themeId);
        committedThemeIdRef.current = themeId;
        setPreviewThemeId(null);
    };

    if (isLoading && themes.length === 0) {
        return (
            <div className="flex flex-col h-full bg-sidebar text-text-primary p-4 items-center justify-center">
                <span className="loading loading-spinner text-primary"></span>
                <span className="text-xs text-text-secondary mt-2">Loading themes...</span>
            </div>
        );
    }

    if (error) {
        return (
            <div className="flex flex-col h-full bg-sidebar text-text-primary p-4 items-center justify-center text-center">
                <span className="text-red-400 font-medium text-xs mb-1">Error Loading Themes</span>
                <span className="text-[10px] text-text-secondary">{error}</span>
            </div>
        );
    }

    return (
        <div className="flex flex-col h-full bg-sidebar text-text-primary">
            <div className="p-3 border-b border-border">
                <span className="text-sm font-semibold uppercase tracking-wider">Themes</span>
                <div className="text-[10px] text-text-secondary mt-1">
                    {themes.length} installed
                </div>
            </div>

            <div
                className="flex-1 overflow-y-auto p-2 space-y-2"
                onMouseLeave={handleMouseLeaveList}
            >
                {themes.map((theme) => {
                    const isPreviewActive = theme.id === (previewThemeId || activeThemeId);
                    const isCommitted = theme.id === committedThemeIdRef.current;

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
                                isPreviewActive
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
                                        isPreviewActive ? "text-primary" : "text-text-primary"
                                    )}>
                                        {theme.name}
                                        {isCommitted && <Check size={12} className="text-primary" />}
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
                                <div style={{ backgroundColor: sidebar }} className="w-8 flex flex-col items-center py-1 gap-0.5">
                                    <div className="w-3 h-3 rounded-[2px]" style={{ backgroundColor: activity }}></div>
                                    <div className="w-3 h-3 rounded-[2px] opacity-20 bg-white"></div>
                                </div>
                                {/* Editor area */}
                                <div style={{ backgroundColor: bg, color: primary }} className="flex-1 px-2 flex items-center text-[9px] font-mono">
                                    <div className="flex gap-1.5">
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
    );
};
