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

import React, { useRef } from 'react';
import { useThemeStore } from '../../store/useThemeStore';
import type { ThemeDefinition } from '../../types/theme';
import { Check, FolderTree, Palette, Trash2, Upload } from 'lucide-react';
import { clsx } from 'clsx';
import { open } from '@tauri-apps/plugin-dialog';
import { readTextFile } from '@tauri-apps/plugin-fs';
import { isTauri } from '../../lib/tauri';
import { useThemeImportDrag } from '../../hooks/useThemeImportDrag';
import { settingsCardStyle, settingsDangerPanelStyle, settingsPrimaryButtonStyle, settingsSubtlePanelStyle } from './settings-shared';
import { ExplorerIconPackPanel } from '../theme/ExplorerIconPackPanel';

type AppearanceTab = 'themes' | 'iconPacks';

export const ThemeSettingsTab: React.FC = () => {
    const {
        themes,
        activeThemeId,
        setActiveTheme,
        importTheme,
        deleteTheme,
        isLoading,
        error
    } = useThemeStore();

    const fileInputRef = useRef<HTMLInputElement>(null);
    const [activeTab, setActiveTab] = React.useState<AppearanceTab>('themes');

    const handleImportClick = async () => {
        if (isTauri()) {
            try {
                const selected = await open({
                    multiple: false,
                    filters: [{
                        name: 'Theme Definitions',
                        extensions: ['json']
                    }]
                });

                if (selected && typeof selected === 'string') {
                    const content = await readTextFile(selected);
                    await processThemeImport(content);
                }
            } catch (err) {
                console.error('Failed to import theme:', err);
            }
        } else {
            fileInputRef.current?.click();
        }
    };

    const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = async (event) => {
            const content = event.target?.result as string;
            if (content) {
                await processThemeImport(content);
            }
        };
        reader.readAsText(file);
        // Reset value to allow same file selection again
        e.target.value = '';
    };

    const processThemeImport = async (content: string) => {
        try {
            const json = JSON.parse(content);
            await importTheme(json);
        } catch (err) {
            console.error('Invalid theme file:', err);
            // Ideally show a toast or error message in UI
        }
    };

    const { isDragging: isTauriDragging } = useThemeImportDrag();
    const [isInternalDragging, setIsInternalDragging] = React.useState(false);

    // Combine dragging states
    const isDragging = isTauriDragging || isInternalDragging;

    const handleDragOver = (e: React.DragEvent) => {
        // Always prevent default behavior first
        e.preventDefault();
        e.stopPropagation();

        // In Tauri, let the native hook handle it completely
        if (isTauri()) return;

        setIsInternalDragging(true);
    };

    const handleDragLeave = (e: React.DragEvent) => {
        // Always prevent default behavior first
        e.preventDefault();
        e.stopPropagation();

        // In Tauri, let the native hook handle it completely
        if (isTauri()) return;

        setIsInternalDragging(false);
    };

    const handleDrop = async (e: React.DragEvent) => {
        // Always prevent default behavior first
        e.preventDefault();
        e.stopPropagation();

        // In Tauri, let the native hook handle it completely
        if (isTauri()) {
            setIsInternalDragging(false);
            return;
        }

        setIsInternalDragging(false);

        const file = e.dataTransfer.files[0];
        if (!file || !file.name.endsWith('.json')) {
            console.error('Please drop a valid .json theme file');
            return;
        }

        const reader = new FileReader();
        reader.onload = async (event) => {
            const content = event.target?.result as string;
            if (content) {
                await processThemeImport(content);
            }
        };
        reader.readAsText(file);
    };

    if (isLoading && themes.length === 0) {
        return <div className="p-4 text-xs text-text-secondary">Loading themes...</div>;
    }

    return (
        <div className="h-full flex flex-col relative overflow-hidden">
            <div className="flex-none pb-4">
                <div className="flex flex-wrap rounded-[16px] p-1" style={settingsSubtlePanelStyle}>
                    <button
                        onClick={() => setActiveTab('themes')}
                        className={clsx(
                            "flex min-w-[110px] flex-1 items-center justify-center gap-1.5 rounded-[12px] px-3 py-2 text-xs font-medium whitespace-nowrap transition-colors",
                            activeTab === 'themes'
                                ? "text-primary"
                                : "text-text-secondary hover:text-text-primary"
                        )}
                        style={activeTab === 'themes' ? settingsCardStyle : undefined}
                    >
                        <Palette size={14} />
                        Themes
                    </button>
                    <button
                        onClick={() => setActiveTab('iconPacks')}
                        className={clsx(
                            "flex min-w-[110px] flex-1 items-center justify-center gap-1.5 rounded-[12px] px-3 py-2 text-xs font-medium whitespace-nowrap transition-colors",
                            activeTab === 'iconPacks'
                                ? "text-primary"
                                : "text-text-secondary hover:text-text-primary"
                        )}
                        style={activeTab === 'iconPacks' ? settingsCardStyle : undefined}
                    >
                        <FolderTree size={14} />
                        Icon Packs
                    </button>
                </div>
            </div>

            {activeTab === 'themes' ? (
                <div
                    className="flex-1 min-h-0 flex flex-col relative overflow-hidden"
                    data-theme-drop-zone="true"
                    onDragOver={handleDragOver}
                    onDragLeave={handleDragLeave}
                    onDrop={handleDrop}
                >
                    {isDragging && (
                        <div className="absolute inset-0 z-50 flex items-center justify-center rounded-[24px] border-2 border-dashed border-primary bg-primary/10 backdrop-blur-sm transition-all pointer-events-none">
                            <div className="flex flex-col items-center gap-2 text-primary font-medium animate-bounce">
                                <Upload size={24} />
                                <span>Drop JSON theme to import</span>
                            </div>
                        </div>
                    )}

                    <div className="flex-none space-y-4 pb-4">
                        <div className="flex items-center justify-between rounded-[20px] px-4 py-4" style={settingsCardStyle}>
                            <div>
                                <p className="text-sm font-semibold text-text-primary">Theme Library</p>
                                <p className="mt-1 text-[11px] leading-relaxed text-text-secondary">
                                    Pick a theme or import a JSON file. Hover states and previews now live in the same settings material language.
                                </p>
                            </div>
                            <div>
                                <input
                                    type="file"
                                    ref={fileInputRef}
                                    onChange={handleFileChange}
                                    accept=".json"
                                    className="hidden"
                                />
                                <button
                                    onClick={handleImportClick}
                                    className="flex items-center gap-1.5 rounded-xl px-3 py-2 text-xs font-semibold text-primary-foreground transition-colors"
                                    style={settingsPrimaryButtonStyle}
                                >
                                    <Upload size={12} />
                                    Import Theme
                                </button>
                            </div>
                        </div>

                        {error && (
                            <div className="rounded-[18px] p-3 text-xs text-danger" style={settingsDangerPanelStyle}>
                                {error}
                            </div>
                        )}
                    </div>

                    <div className="flex-1 overflow-y-auto min-h-0 pr-2 -mr-2">
                        <div className="grid grid-cols-2 gap-3 pb-24">
                            {themes.map((theme) => (
                                <ThemeCard
                                    key={theme.id}
                                    theme={theme}
                                    isActive={theme.id === activeThemeId}
                                    onSelect={() => setActiveTheme(theme.id)}
                                    onDelete={theme.isBuiltIn ? undefined : () => deleteTheme(theme.id)}
                                />
                            ))}
                        </div>
                    </div>
                </div>
            ) : (
                <ExplorerIconPackPanel />
            )}
        </div>
    );
};

interface ThemeCardProps {
    theme: ThemeDefinition;
    isActive: boolean;
    onSelect: () => void;
    onDelete?: () => void;
}

const ThemeCard: React.FC<ThemeCardProps> = ({ theme, isActive, onSelect, onDelete }) => {
    // Extract key colors for preview
    const bg = theme.colors.editor.background;
    const fg = theme.colors.editor.foreground;
    const sidebar = theme.colors.sidebar.background;
    const activity = theme.colors.sidebar.itemActive;

    return (
        <div
            onClick={onSelect}
            className={clsx(
                "group relative cursor-pointer rounded-[20px] border p-4 transition-all",
                isActive
                    ? "border-primary ring-1 ring-primary"
                    : "border-border hover:border-primary/50"
            )}
            style={settingsCardStyle}
        >
            <div className="flex justify-between items-start mb-2">
                <div>
                    <div className="text-sm font-medium text-text-primary flex items-center gap-1.5">
                        {theme.name}
                        {isActive && <Check size={12} className="text-primary" />}
                    </div>
                    <div className="text-[10px] text-text-secondary">by {theme.author}</div>
                </div>
                {onDelete && (
                    <button
                        onClick={(e) => {
                            e.stopPropagation();
                            onDelete();
                        }}
                        className="rounded-xl p-2 opacity-0 transition-all group-hover:opacity-100 hover:text-danger"
                        style={settingsSubtlePanelStyle}
                        title="Delete theme"
                    >
                        <Trash2 size={12} />
                    </button>
                )}
            </div>

            {/* Preview */}
            <div className="mt-3 flex h-16 w-full overflow-hidden rounded-[16px]" style={settingsSubtlePanelStyle}>
                {/* Sidebar strip */}
                <div style={{ backgroundColor: sidebar }} className="w-8 flex flex-col items-center py-2 gap-1.5">
                    <div className="w-4 h-4 rounded-sm" style={{ backgroundColor: activity }}></div>
                    <div className="w-4 h-4 rounded-sm opacity-20 bg-white"></div>
                </div>
                {/* Editor area */}
                <div style={{ backgroundColor: bg, color: fg }} className="flex-1 p-2 text-[8px] font-mono leading-tight">
                    <div style={{ color: theme.colors.editor.lineNumbers }} className="mb-1">1  <span style={{ color: theme.colors.common.primary }}>import</span> React;</div>
                    <div>2</div>
                    <div>3  <span style={{ color: theme.colors.common.success }}>const</span> <span style={{ color: theme.colors.common.warning }}>App</span> = () =&gt; {'{'}</div>
                    <div>4    <span style={{ color: theme.colors.common.primary }}>return</span> &lt;div/&gt;;</div>
                    <div>5  {'}'}</div>
                </div>
            </div>
        </div>
    );
};
