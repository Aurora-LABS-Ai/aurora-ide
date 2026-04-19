import React, { useState, useEffect } from 'react';
import { Check, Palette, PenLine, Eye, Save, X, AlertCircle, CheckCircle2, FolderTree } from 'lucide-react';
import { useThemeStore } from '../../store/useThemeStore';
import { themeService } from '../../services/theme-service';
import type { ThemeDefinition, ThemeFile } from '../../types/theme';
import clsx from 'clsx';
import { ExplorerIconPackPanel } from './ExplorerIconPackPanel';

type TabType = 'themes' | 'iconPacks' | 'editor';

interface EditorState {
    jsonInput: string;
    parseError: string | null;
    isPreviewing: boolean;
    previewTheme: ThemeDefinition | null;
    saveStatus: 'idle' | 'saving' | 'success' | 'error';
    saveError: string | null;
}

type ThemeJsonMap = Record<string, unknown>;
type FlatColorMap = Record<string, { path: string; value: string; category: string }>;

const VISUAL_EDITOR_SECTIONS = [
    {
        id: 'core',
        title: 'Core',
        paths: [
            'common.primary',
            'common.textPrimary',
            'common.textSecondary',
            'common.border',
            'common.muted',
        ],
    },
    {
        id: 'editor',
        title: 'Editor',
        paths: [
            'editor.background',
            'editor.foreground',
            'editor.lineNumbers',
            'editor.selection',
            'editor.cursorLine',
        ],
    },
    {
        id: 'sidebar',
        title: 'Left Panel',
        paths: [
            'sidebar.background',
            'sidebar.foreground',
            'sidebar.border',
            'sidebar.itemHover',
            'sidebar.itemSelected',
        ],
    },
    {
        id: 'chat',
        title: 'Chat',
        paths: [
            'chat.background',
            'chat.surface',
            'chat.inputBackground',
            'chat.inputBorder',
            'chat.userMessage',
            'chat.assistantMessage',
        ],
    },
    {
        id: 'titleBar',
        title: 'Title Bar',
        paths: [
            'titleBar.background',
            'titleBar.foreground',
            'titleBar.border',
        ],
    },
    {
        id: 'statusBar',
        title: 'Status Bar',
        paths: [
            'statusBar.background',
            'statusBar.foreground',
            'statusBar.border',
            'statusBar.itemHover',
        ],
    },
] as const;

const THEME_TEMPLATE: ThemeFile = {
    name: "My Custom Theme",
    type: "dark",
    author: "Your Name",
    version: "1.0.0",
    colors: {
        editor: {
            background: "#1a1a1a",
            foreground: "#e4e4e7"
        },
        common: {
            primary: "#10b981"
        }
    },
    tokenColors: []
};

const shellStyle: React.CSSProperties = {
    backgroundColor: 'color-mix(in srgb, var(--aurora-sidebar-background) 88%, var(--aurora-editor-background) 12%)',
};

const headerStyle: React.CSSProperties = {
    backgroundColor: 'color-mix(in srgb, var(--aurora-title-bar-background) 76%, var(--aurora-sidebar-background) 24%)',
    borderColor: 'color-mix(in srgb, var(--aurora-common-border) 72%, transparent)',
};

const panelStyle: React.CSSProperties = {
    backgroundColor: 'color-mix(in srgb, var(--aurora-common-secondary) 76%, var(--aurora-sidebar-background) 24%)',
    border: '1px solid color-mix(in srgb, var(--aurora-common-border) 58%, transparent)',
    boxShadow: `
        inset 0 1px 0 color-mix(in srgb, var(--aurora-common-primary-foreground) 5%, transparent),
        inset 0 -1px 0 color-mix(in srgb, var(--aurora-common-shadow) 8%, transparent)
    `,
};

const activeCardStyle: React.CSSProperties = {
    backgroundColor: 'color-mix(in srgb, var(--aurora-common-primary) 10%, var(--aurora-common-secondary))',
    border: '1px solid color-mix(in srgb, var(--aurora-common-primary) 22%, transparent)',
    boxShadow: `
        inset 0 1px 0 color-mix(in srgb, var(--aurora-common-primary-foreground) 6%, transparent),
        inset 0 -1px 0 color-mix(in srgb, var(--aurora-common-shadow) 8%, transparent)
    `,
};

const primaryButtonStyle: React.CSSProperties = {
    backgroundColor: 'var(--aurora-common-primary)',
    color: 'var(--aurora-common-primary-foreground)',
    boxShadow: '0 10px 24px color-mix(in srgb, var(--aurora-common-primary) 18%, transparent)',
};

export const ThemePanel: React.FC = () => {
    const { themes, activeThemeId, setActiveTheme, importTheme, isLoading, error } = useThemeStore();
    const [activeTab, setActiveTab] = useState<TabType>(() => {
        // Restore from localStorage
        const saved = localStorage.getItem('theme-panel-active-tab');
        return (saved === 'themes' || saved === 'iconPacks' || saved === 'editor') ? saved : 'themes';
    });
    const [previewThemeId, setPreviewThemeId] = useState<string | null>(null);
    const [committedThemeId, setCommittedThemeId] = useState(activeThemeId);
    
    const [editorState, setEditorState] = useState<EditorState>(() => {
        // Restore editor state from localStorage
        const saved = localStorage.getItem('theme-panel-editor-state');
        if (saved) {
            try {
                return JSON.parse(saved);
            } catch {
                return {
                    jsonInput: JSON.stringify(THEME_TEMPLATE, null, 2),
                    parseError: null,
                    isPreviewing: false,
                    previewTheme: null,
                    saveStatus: 'idle',
                    saveError: null
                };
            }
        }
        return {
            jsonInput: JSON.stringify(THEME_TEMPLATE, null, 2),
            parseError: null,
            isPreviewing: false,
            previewTheme: null,
            saveStatus: 'idle',
            saveError: null
        };
    });

    useEffect(() => {
        setCommittedThemeId(activeThemeId);
    }, [activeThemeId]);

    // Persist active tab to localStorage
    useEffect(() => {
        localStorage.setItem('theme-panel-active-tab', activeTab);
    }, [activeTab]);

    // Persist editor state to localStorage
    useEffect(() => {
        localStorage.setItem('theme-panel-editor-state', JSON.stringify(editorState));
    }, [editorState]);

    const handleMouseEnter = (themeId: string) => {
        if (themeId !== previewThemeId) {
            setPreviewThemeId(themeId);
            const theme = themes.find(t => t.id === themeId);
            if (theme) {
                themeService.applyTheme(theme);
            }
        }
    };

    const handleMouseLeaveList = () => {
        if (previewThemeId) {
            setPreviewThemeId(null);
            const committedTheme = themes.find(t => t.id === committedThemeId);
            if (committedTheme) {
                themeService.applyTheme(committedTheme);
            }
        }
    };

    const handleSelect = (themeId: string) => {
        setActiveTheme(themeId);
        setCommittedThemeId(themeId);
        setPreviewThemeId(null);
    };

    const handleJsonChange = (value: string) => {
        setEditorState(prev => ({
            ...prev,
            jsonInput: value,
            parseError: null,
            saveStatus: 'idle',
            saveError: null
        }));
    };

    const handlePreview = () => {
        try {
            const parsed = JSON.parse(editorState.jsonInput);
            const validation = themeService.validateThemeFile(parsed);
            
            if (!validation.valid) {
                setEditorState(prev => ({
                    ...prev,
                    parseError: validation.errors.join('\n'),
                    isPreviewing: false,
                    previewTheme: null
                }));
                return;
            }

            const previewId = `preview-${Date.now()}`;
            const themeDef = themeService.createThemeDefinition(parsed as ThemeFile, previewId, false);
            
            themeService.applyTheme(themeDef);
            
            setEditorState(prev => ({
                ...prev,
                parseError: null,
                isPreviewing: true,
                previewTheme: themeDef
            }));
        } catch (e) {
            setEditorState(prev => ({
                ...prev,
                parseError: `JSON Parse Error: ${(e as Error).message}`,
                isPreviewing: false,
                previewTheme: null
            }));
        }
    };

    const handleCancelPreview = () => {
        const committedTheme = themes.find(t => t.id === committedThemeId);
        if (committedTheme) {
            themeService.applyTheme(committedTheme);
        }
        
        setEditorState(prev => ({
            ...prev,
            isPreviewing: false,
            previewTheme: null
        }));
    };

    const handleSaveTheme = async () => {
        if (!editorState.previewTheme) {
            handlePreview();
            return;
        }

        try {
            setEditorState(prev => ({ ...prev, saveStatus: 'saving', saveError: null }));
            
            const parsed = JSON.parse(editorState.jsonInput) as ThemeFile;
            const savedTheme = await importTheme(parsed);
            
            setActiveTheme(savedTheme.id);
            setCommittedThemeId(savedTheme.id);
            
            setEditorState(prev => ({
                ...prev,
                saveStatus: 'success',
                isPreviewing: false,
                previewTheme: null
            }));

            setTimeout(() => {
                setEditorState(prev => ({ ...prev, saveStatus: 'idle' }));
                setActiveTab('themes');
            }, 1500);
        } catch (e) {
            setEditorState(prev => ({
                ...prev,
                saveStatus: 'error',
                saveError: (e as Error).message
            }));
        }
    };

    const handleLoadTemplate = () => {
        setEditorState(prev => ({
            ...prev,
            jsonInput: JSON.stringify(THEME_TEMPLATE, null, 2),
            parseError: null,
            isPreviewing: false,
            previewTheme: null,
            saveStatus: 'idle',
            saveError: null
        }));
    };

    if (isLoading && themes.length === 0) {
        return (
            <div className="flex h-full flex-col items-center justify-center p-4 text-text-primary" style={shellStyle}>
                <span className="loading loading-spinner text-primary"></span>
                <span className="text-xs text-text-secondary mt-2">Loading themes...</span>
            </div>
        );
    }

    if (error && themes.length === 0) {
        return (
            <div className="flex h-full flex-col items-center justify-center p-4 text-center text-text-primary" style={shellStyle}>
                <span className="text-error font-medium text-xs mb-1">Error Loading Themes</span>
                <span className="text-[10px] text-text-secondary">{error}</span>
            </div>
        );
    }

    return (
        <div className="flex h-full flex-col text-text-primary" style={shellStyle}>
            {/* Tab Header */}
            <div className="border-b px-2 py-2" style={headerStyle}>
                <div className="flex flex-wrap rounded-[14px] p-1" style={panelStyle}>
                    <button
                        onClick={() => setActiveTab('themes')}
                        className={clsx(
                            "flex min-w-[92px] flex-1 items-center justify-center gap-1.5 rounded-[10px] px-3 py-2 text-xs font-medium whitespace-nowrap transition-colors",
                            activeTab === 'themes'
                                ? "text-primary"
                                : "border-transparent text-text-secondary hover:text-text-primary"
                        )}
                        style={activeTab === 'themes' ? activeCardStyle : undefined}
                    >
                        <Palette size={14} />
                        Themes
                    </button>
                    <button
                        onClick={() => setActiveTab('iconPacks')}
                        className={clsx(
                            "flex min-w-[92px] flex-1 items-center justify-center gap-1.5 rounded-[10px] px-3 py-2 text-xs font-medium whitespace-nowrap transition-colors",
                            activeTab === 'iconPacks'
                                ? "text-primary"
                                : "border-transparent text-text-secondary hover:text-text-primary"
                        )}
                        style={activeTab === 'iconPacks' ? activeCardStyle : undefined}
                    >
                        <FolderTree size={14} />
                        Icon Packs
                    </button>
                    <button
                        onClick={() => setActiveTab('editor')}
                        className={clsx(
                            "flex min-w-[92px] flex-1 items-center justify-center gap-1.5 rounded-[10px] px-3 py-2 text-xs font-medium whitespace-nowrap transition-colors",
                            activeTab === 'editor'
                                ? "text-primary"
                                : "border-transparent text-text-secondary hover:text-text-primary"
                        )}
                        style={activeTab === 'editor' ? activeCardStyle : undefined}
                    >
                        <PenLine size={14} />
                        Editor
                    </button>
                </div>
            </div>

            {/* Tab Content */}
            <div className="flex-1 min-h-0 overflow-hidden flex flex-col">
                {error && themes.length > 0 && (
                    <div className="mx-3 mt-3 rounded-[14px] border border-error/30 bg-error/10 px-3 py-2 text-[10px] text-error">
                        {error}
                    </div>
                )}
                {activeTab === 'themes' ? (
                    <div className="flex min-h-0 flex-1 flex-col">
                        <ThemesTab
                            themes={themes}
                            activeThemeId={activeThemeId}
                            previewThemeId={previewThemeId}
                            committedThemeId={committedThemeId}
                            onMouseEnter={handleMouseEnter}
                            onMouseLeave={handleMouseLeaveList}
                            onSelect={handleSelect}
                            onEdit={(theme) => {
                                const nextName = theme.isBuiltIn ? `${theme.name} Custom` : theme.name;
                                setEditorState(prev => ({
                                    ...prev,
                                    jsonInput: JSON.stringify({
                                        name: nextName,
                                        type: theme.type,
                                        author: theme.author,
                                        version: theme.version,
                                        colors: theme.colors,
                                        tokenColors: theme.tokenColors
                                    }, null, 2),
                                    saveStatus: 'idle',
                                    saveError: null
                                }));
                                setActiveTab('editor');
                            }}
                        />
                    </div>
                ) : activeTab === 'iconPacks' ? (
                    <ExplorerIconPackPanel />
                ) : (
                    <EditorTab
                        editorState={editorState}
                        onJsonChange={handleJsonChange}
                        onPreview={handlePreview}
                        onCancelPreview={handleCancelPreview}
                        onSave={handleSaveTheme}
                        onLoadTemplate={handleLoadTemplate}
                    />
                )}
            </div>
        </div>
    );
};

interface ThemesTabProps {
    themes: ThemeDefinition[];
    activeThemeId: string;
    previewThemeId: string | null;
    committedThemeId: string;
    onMouseEnter: (themeId: string) => void;
    onMouseLeave: () => void;
    onSelect: (themeId: string) => void;
    onEdit: (theme: ThemeDefinition) => void;
}

const ThemesTab: React.FC<ThemesTabProps> = ({
    themes,
    activeThemeId,
    previewThemeId,
    committedThemeId,
    onMouseEnter,
    onMouseLeave,
    onSelect,
    onEdit
}) => {
    return (
        <>
            <div className="border-b px-3 py-3" style={headerStyle}>
                <span className="text-sm font-semibold uppercase tracking-[0.14em]">Themes</span>
                <div className="mt-1 text-[10px] text-text-secondary">
                    {themes.length} installed
                </div>
            </div>

            <div
                className="flex-1 min-h-0 overflow-y-auto p-3 space-y-3"
                onMouseLeave={onMouseLeave}
            >
                {themes.map((theme) => {
                    const isPreviewActive = theme.id === (previewThemeId || activeThemeId);
                    const isCommitted = theme.id === committedThemeId;

                    const bg = theme.colors.editor.background;
                    const fg = theme.colors.editor.foreground;
                    const sidebar = theme.colors.sidebar.background;
                    const primary = theme.colors.common.primary;
                    const activity = theme.colors.sidebar.itemActive;

                    return (
                        <div
                            key={theme.id}
                            role="button"
                            tabIndex={0}
                            className={clsx(
                                "group relative w-full overflow-hidden rounded-[18px] p-3 text-left transition-all cursor-pointer focus:outline-none",
                                isPreviewActive
                                    ? "text-primary"
                                    : "hover:border-primary/50"
                            )}
                            style={isPreviewActive ? activeCardStyle : panelStyle}
                            onMouseEnter={() => onMouseEnter(theme.id)}
                            onClick={() => onSelect(theme.id)}
                            onKeyDown={(event) => {
                                if (event.key === 'Enter' || event.key === ' ') {
                                    event.preventDefault();
                                    onSelect(theme.id);
                                }
                            }}
                        >
                            <div className="mb-3 flex items-start justify-between gap-3">
                                <div className="min-w-0 flex-1">
                                    <span className={clsx(
                                        "flex items-center gap-1.5 truncate text-[13px] font-semibold",
                                        isPreviewActive ? "text-primary" : "text-text-primary"
                                    )}>
                                        {theme.name}
                                        {isCommitted && <Check size={12} className="text-primary" />}
                                        {theme.isBuiltIn && <span className="rounded-full px-1.5 py-0.5 text-[9px] text-text-secondary" style={panelStyle}>Built-in</span>}
                                    </span>
                                    <div className="mt-1 flex items-center gap-1">
                                        <span className="truncate text-[10px] text-text-secondary">
                                            by {theme.author}
                                        </span>
                                    </div>
                                </div>
                                <button
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        onEdit(theme);
                                    }}
                                    className="flex h-8 w-8 items-center justify-center rounded-[10px] text-text-secondary opacity-70 transition-all hover:text-text-primary group-hover:opacity-100"
                                    style={panelStyle}
                                    title="Edit theme"
                                >
                                        <PenLine size={14} />
                                </button>
                            </div>

                            {/* Mini Preview Strip */}
                            <div className="flex h-10 w-full overflow-hidden rounded-[14px] border border-border/50 opacity-95 transition-opacity group-hover:opacity-100">
                                <div style={{ backgroundColor: sidebar }} className="w-8 flex flex-col items-center py-1 gap-0.5">
                                    <div className="w-3 h-3 rounded-[2px]" style={{ backgroundColor: activity }}></div>
                                    <div className="w-3 h-3 rounded-[2px] opacity-20 bg-white"></div>
                                </div>
                                <div style={{ backgroundColor: bg, color: primary }} className="flex-1 px-2 flex items-center text-[9px] font-mono">
                                    <div className="flex gap-1.5">
                                        <span style={{ color: theme.colors.common.primary }}>const</span>
                                        <span style={{ color: fg }}>App</span>
                                    </div>
                                </div>
                            </div>
                        </div>
                    );
                })}
            </div>
        </>
    );
};

interface EditorTabProps {
    editorState: EditorState;
    onJsonChange: (value: string) => void;
    onPreview: () => void;
    onCancelPreview: () => void;
    onSave: () => void;
    onLoadTemplate: () => void;
}

const EditorTab: React.FC<EditorTabProps> = ({
    editorState,
    onJsonChange,
    onPreview,
    onCancelPreview,
    onSave,
    onLoadTemplate
}) => {
    const { jsonInput, parseError, isPreviewing, previewTheme, saveStatus, saveError } = editorState;
    const [showVisualEditor, setShowVisualEditor] = useState(true);
    const [editedColors, setEditedColors] = useState<Record<string, string>>({});

    // Parse theme colors from JSON
    const themeColors = React.useMemo(() => {
        try {
            const parsed = JSON.parse(jsonInput) as ThemeFile;
            return parsed.colors || {};
        } catch {
            return {};
        }
    }, [jsonInput]);

    // Flatten colors for easier editing
    const flatColors = React.useMemo(() => {
        const colors: FlatColorMap = {};
        
        const flatten = (obj: ThemeJsonMap, prefix: string = '', category: string = '') => {
            for (const key in obj) {
                const value = obj[key];
                const fullPath = prefix ? `${prefix}.${key}` : key;
                if (typeof value === 'string' && value.startsWith('#')) {
                    colors[fullPath] = { path: fullPath, value, category };
                } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
                    flatten(value as ThemeJsonMap, fullPath, category || key);
                }
            }
        };
        
        flatten(themeColors as ThemeJsonMap);
        return colors;
    }, [themeColors]);

    // Handle color change
    const handleColorChange = (path: string, value: string) => {
        setEditedColors(prev => ({ ...prev, [path]: value }));
        
        // Update JSON with new color
        try {
            const parsed = JSON.parse(jsonInput) as ThemeFile;
            const pathParts = path.split('.');
            let current: ThemeJsonMap = parsed.colors as ThemeJsonMap;
            
            for (let i = 0; i < pathParts.length - 1; i++) {
                const next = current[pathParts[i]];
                if (!next || typeof next !== 'object' || Array.isArray(next)) {
                    return;
                }
                current = next as ThemeJsonMap;
            }
            
            current[pathParts[pathParts.length - 1]] = value;
            
            const newJson = JSON.stringify(parsed, null, 2);
            onJsonChange(newJson);
            
            // Auto-preview if valid
            if (!parseError) {
                onPreview();
            }
        } catch (e) {
            console.error('Error updating color:', e);
        }
    };

    const visibleSections = React.useMemo(() => {
        return VISUAL_EDITOR_SECTIONS
            .map((section) => ({
                ...section,
                colors: section.paths
                    .map((path) => flatColors[path])
                    .filter((color): color is FlatColorMap[string] => Boolean(color)),
            }))
            .filter((section) => section.colors.length > 0);
    }, [flatColors]);

    return (
        <div className="flex flex-col h-full min-h-0">
            {/* Editor Header */}
            <div className="border-b px-3 py-3" style={headerStyle}>
                <div className="flex items-center justify-between">
                    <div>
                        <span className="text-sm font-semibold uppercase tracking-[0.14em]">Theme Editor</span>
                        <div className="mt-1 text-[10px] text-text-secondary">
                            {showVisualEditor ? 'Visual editor - click colors to edit' : 'Paste JSON to preview and save'}
                        </div>
                    </div>
                    <div className="flex gap-2">
                        <button
                            onClick={() => setShowVisualEditor(!showVisualEditor)}
                            className="rounded-[10px] px-2.5 py-1.5 text-[10px] text-text-secondary transition-colors hover:text-text-primary"
                            style={panelStyle}
                        >
                            {showVisualEditor ? 'Show JSON' : 'Show Visual'}
                        </button>
                        <button
                            onClick={onLoadTemplate}
                            className="rounded-[10px] px-2.5 py-1.5 text-[10px] text-text-secondary transition-colors hover:text-text-primary"
                            style={panelStyle}
                        >
                            Load Template
                        </button>
                    </div>
                </div>
            </div>

            {/* Preview Status Bar */}
            {isPreviewing && previewTheme && (
                <div className="flex items-center gap-2 border-b px-3 py-2" style={activeCardStyle}>
                    <Eye size={12} className="text-primary" />
                    <span className="text-[11px] text-primary font-medium flex-1">
                        Previewing: {previewTheme.name}
                    </span>
                    <button
                        onClick={onCancelPreview}
                        className="rounded-[9px] px-2 py-1 text-[10px] text-text-secondary transition-colors"
                        style={panelStyle}
                    >
                        Cancel
                    </button>
                </div>
            )}

            {/* Visual Editor */}
            {showVisualEditor ? (
                <div className="flex-1 min-h-0 overflow-y-auto p-3">
                    {visibleSections.map((section) => (
                        <div key={section.id} className="mb-4 rounded-[18px] p-3" style={panelStyle}>
                            <div className="mb-3 text-xs font-semibold uppercase tracking-[0.14em] text-text-secondary">
                                {section.title}
                            </div>
                            <div className="grid grid-cols-2 gap-2">
                                {section.colors.map((color) => {
                                    const path = color.path;
                                    const currentValue = editedColors[path] || color.value;
                                    return (
                                        <div key={path} className="flex items-center gap-2 rounded-[14px] p-2" style={shellStyle}>
                                            <input
                                                type="color"
                                                value={currentValue}
                                                onChange={(e) => handleColorChange(path, e.target.value)}
                                                className="w-8 h-8 rounded cursor-pointer border-0"
                                                title={path}
                                            />
                                            <div className="flex-1 min-w-0">
                                                <div className="mb-1 truncate text-[10px] font-medium text-text-secondary">{path}</div>
                                                <input
                                                    type="text"
                                                    value={currentValue}
                                                    onChange={(e) => handleColorChange(path, e.target.value)}
                                                    className="w-full rounded-[10px] px-2 py-1.5 text-[10px] font-mono focus:border-primary focus:outline-none"
                                                    style={panelStyle}
                                                    placeholder="#000000"
                                                />
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    ))}
                </div>
            ) : (
                /* JSON Textarea */
                <div className="flex-1 min-h-0 p-3 overflow-hidden flex flex-col">
                    <textarea
                        value={jsonInput}
                        onChange={(e) => onJsonChange(e.target.value)}
                        placeholder="Paste your theme JSON here..."
                        className={clsx(
                            "flex-1 w-full resize-none rounded-[16px] border p-3 font-mono text-[11px] leading-relaxed",
                            "focus:outline-none focus:ring-1 transition-all",
                            parseError
                                ? "border-error/50 focus:ring-error/50 focus:border-error"
                                : "focus:ring-primary/50 focus:border-primary"
                        )}
                        style={panelStyle}
                        spellCheck={false}
                    />

                    {/* Error Display */}
                    {parseError && (
                        <div className="mt-2 rounded-[14px] border border-error/30 bg-error/10 p-2">
                            <div className="flex items-start gap-2">
                                <AlertCircle size={14} className="text-error flex-shrink-0 mt-0.5" />
                                <pre className="text-[10px] text-error whitespace-pre-wrap break-words flex-1">
                                    {parseError}
                                </pre>
                            </div>
                        </div>
                    )}

                    {/* Save Error */}
                    {saveError && (
                        <div className="mt-2 rounded-[14px] border border-error/30 bg-error/10 p-2">
                            <div className="flex items-start gap-2">
                                <AlertCircle size={14} className="text-error flex-shrink-0 mt-0.5" />
                                <span className="text-[10px] text-error">{saveError}</span>
                            </div>
                        </div>
                    )}

                    {/* Success Message */}
                    {saveStatus === 'success' && (
                        <div className="mt-2 rounded-[14px] border border-success/30 bg-success/10 p-2">
                            <div className="flex items-center gap-2">
                                <CheckCircle2 size={14} className="text-success" />
                                <span className="text-[10px] text-success">Theme saved successfully!</span>
                            </div>
                        </div>
                    )}
                </div>
            )}

            {/* Action Buttons */}
            <div className="flex gap-2 border-t p-3" style={headerStyle}>
                {isPreviewing ? (
                    <>
                        <button
                            onClick={onCancelPreview}
                            className="flex flex-1 items-center justify-center gap-1.5 rounded-[12px] px-3 py-2 text-xs font-medium text-text-primary transition-colors"
                            style={panelStyle}
                        >
                            <X size={14} />
                            Cancel
                        </button>
                        <button
                            onClick={onSave}
                            disabled={saveStatus === 'saving'}
                            className={clsx(
                                "flex flex-1 items-center justify-center gap-1.5 rounded-[12px] px-3 py-2 text-xs font-medium transition-colors",
                                saveStatus === 'saving'
                                    ? "bg-primary/50 text-primary-foreground/50 cursor-not-allowed"
                                    : "text-primary-foreground"
                            )}
                            style={saveStatus === 'saving' ? undefined : primaryButtonStyle}
                        >
                            <Save size={14} />
                            {saveStatus === 'saving' ? 'Saving...' : 'Save Theme'}
                        </button>
                    </>
                ) : (
                    <button
                        onClick={onPreview}
                        className="flex w-full items-center justify-center gap-1.5 rounded-[12px] px-3 py-2 text-xs font-medium text-primary-foreground transition-colors"
                        style={primaryButtonStyle}
                    >
                        <Eye size={14} />
                        Preview Theme
                    </button>
                )}
            </div>
        </div>
    );
};
