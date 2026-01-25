import React, { useState, useRef, useEffect } from 'react';
import { Check, Palette, PenLine, Eye, Save, X, AlertCircle, CheckCircle2 } from 'lucide-react';
import { useThemeStore } from '../../store/useThemeStore';
import { themeService } from '../../services/theme-service';
import type { ThemeDefinition, ThemeFile } from '../../types/theme';
import clsx from 'clsx';

type TabType = 'themes' | 'editor';

interface EditorState {
    jsonInput: string;
    parseError: string | null;
    isPreviewing: boolean;
    previewTheme: ThemeDefinition | null;
    saveStatus: 'idle' | 'saving' | 'success' | 'error';
    saveError: string | null;
}

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

export const ThemePanel: React.FC = () => {
    const { themes, activeThemeId, setActiveTheme, importTheme, isLoading, error } = useThemeStore();
    const [activeTab, setActiveTab] = useState<TabType>(() => {
        // Restore from localStorage
        const saved = localStorage.getItem('theme-panel-active-tab');
        return (saved === 'themes' || saved === 'editor') ? saved : 'themes';
    });
    const [previewThemeId, setPreviewThemeId] = useState<string | null>(null);
    const committedThemeIdRef = useRef<string>(activeThemeId);
    
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
        committedThemeIdRef.current = activeThemeId;
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
            const committedTheme = themes.find(t => t.id === committedThemeIdRef.current);
            if (committedTheme) {
                themeService.applyTheme(committedTheme);
            }
        }
    };

    const handleSelect = (themeId: string) => {
        setActiveTheme(themeId);
        committedThemeIdRef.current = themeId;
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
        const committedTheme = themes.find(t => t.id === committedThemeIdRef.current);
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
            committedThemeIdRef.current = savedTheme.id;
            
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
            <div className="flex flex-col h-full bg-sidebar text-text-primary p-4 items-center justify-center">
                <span className="loading loading-spinner text-primary"></span>
                <span className="text-xs text-text-secondary mt-2">Loading themes...</span>
            </div>
        );
    }

    if (error) {
        return (
            <div className="flex flex-col h-full bg-sidebar text-text-primary p-4 items-center justify-center text-center">
                <span className="text-error font-medium text-xs mb-1">Error Loading Themes</span>
                <span className="text-[10px] text-text-secondary">{error}</span>
            </div>
        );
    }

    return (
        <div className="flex flex-col h-full bg-sidebar text-text-primary">
            {/* Tab Header */}
            <div className="border-b border-border">
                <div className="flex">
                    <button
                        onClick={() => setActiveTab('themes')}
                        className={clsx(
                            "flex items-center gap-1.5 px-3 py-2 text-xs font-medium transition-colors border-b-2 -mb-[1px]",
                            activeTab === 'themes'
                                ? "border-primary text-primary"
                                : "border-transparent text-text-secondary hover:text-text-primary"
                        )}
                    >
                        <Palette size={14} />
                        Themes
                    </button>
                    <button
                        onClick={() => setActiveTab('editor')}
                        className={clsx(
                            "flex items-center gap-1.5 px-3 py-2 text-xs font-medium transition-colors border-b-2 -mb-[1px]",
                            activeTab === 'editor'
                                ? "border-primary text-primary"
                                : "border-transparent text-text-secondary hover:text-text-primary"
                        )}
                    >
                        <PenLine size={14} />
                        Editor
                    </button>
                </div>
            </div>

            {/* Tab Content */}
            <div className="flex-1 overflow-hidden">
                {activeTab === 'themes' ? (
                    <ThemesTab
                        themes={themes}
                        activeThemeId={activeThemeId}
                        previewThemeId={previewThemeId}
                        committedThemeIdRef={committedThemeIdRef}
                        onMouseEnter={handleMouseEnter}
                        onMouseLeave={handleMouseLeaveList}
                        onSelect={handleSelect}
                        onEdit={(theme) => {
                            setEditorState(prev => ({
                                ...prev,
                                jsonInput: JSON.stringify({
                                    name: theme.name,
                                    type: theme.type,
                                    author: theme.author,
                                    version: theme.version,
                                    colors: theme.colors,
                                    tokenColors: theme.tokenColors
                                }, null, 2)
                            }));
                            setActiveTab('editor');
                        }}
                    />
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
    committedThemeIdRef: React.MutableRefObject<string>;
    onMouseEnter: (themeId: string) => void;
    onMouseLeave: () => void;
    onSelect: (themeId: string) => void;
    onEdit: (theme: ThemeDefinition) => void;
}

const ThemesTab: React.FC<ThemesTabProps> = ({
    themes,
    activeThemeId,
    previewThemeId,
    committedThemeIdRef,
    onMouseEnter,
    onMouseLeave,
    onSelect,
    onEdit
}) => {
    return (
        <>
            <div className="p-3 border-b border-border">
                <span className="text-sm font-semibold uppercase tracking-wider">Themes</span>
                <div className="text-[10px] text-text-secondary mt-1">
                    {themes.length} installed
                </div>
            </div>

            <div
                className="flex-1 overflow-y-auto p-2 space-y-2"
                onMouseLeave={onMouseLeave}
            >
                {themes.map((theme) => {
                    const isPreviewActive = theme.id === (previewThemeId || activeThemeId);
                    const isCommitted = theme.id === committedThemeIdRef.current;

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
                            onMouseEnter={() => onMouseEnter(theme.id)}
                            onClick={() => onSelect(theme.id)}
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
                                <button
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        onEdit(theme);
                                    }}
                                    className="p-1.5 rounded-md hover:bg-white/10 text-text-secondary hover:text-text-primary transition-colors opacity-0 group-hover:opacity-100"
                                    title="Edit theme"
                                >
                                    <PenLine size={14} />
                                </button>
                            </div>

                            {/* Mini Preview Strip */}
                            <div className="h-8 w-full rounded border border-border/50 overflow-hidden flex shadow-sm opacity-90 group-hover:opacity-100 transition-opacity">
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
                        </button>
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
        const colors: Record<string, { path: string; value: string; category: string }> = {};
        
        const flatten = (obj: any, prefix: string = '', category: string = '') => {
            for (const key in obj) {
                const value = obj[key];
                const fullPath = prefix ? `${prefix}.${key}` : key;
                if (typeof value === 'string' && value.startsWith('#')) {
                    colors[fullPath] = { path: fullPath, value, category };
                } else if (typeof value === 'object' && value !== null) {
                    flatten(value, fullPath, category || key);
                }
            }
        };
        
        flatten(themeColors);
        return colors;
    }, [themeColors]);

    // Handle color change
    const handleColorChange = (path: string, value: string) => {
        setEditedColors(prev => ({ ...prev, [path]: value }));
        
        // Update JSON with new color
        try {
            const parsed = JSON.parse(jsonInput) as ThemeFile;
            const pathParts = path.split('.');
            let current: any = parsed.colors;
            
            for (let i = 0; i < pathParts.length - 1; i++) {
                current = current[pathParts[i]];
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

    // Group colors by category
    const groupedColors = React.useMemo(() => {
        const groups: Record<string, typeof flatColors> = {};
        for (const [key, color] of Object.entries(flatColors)) {
            const category = color.category || 'other';
            if (!groups[category]) {
                groups[category] = {};
            }
            groups[category][key] = color;
        }
        return groups;
    }, [flatColors]);

    return (
        <div className="flex flex-col h-full">
            {/* Editor Header */}
            <div className="p-3 border-b border-border">
                <div className="flex items-center justify-between">
                    <div>
                        <span className="text-sm font-semibold uppercase tracking-wider">Theme Editor</span>
                        <div className="text-[10px] text-text-secondary mt-1">
                            {showVisualEditor ? 'Visual editor - click colors to edit' : 'Paste JSON to preview and save'}
                        </div>
                    </div>
                    <div className="flex gap-2">
                        <button
                            onClick={() => setShowVisualEditor(!showVisualEditor)}
                            className="text-[10px] px-2 py-1 rounded bg-secondary/50 hover:bg-secondary text-text-secondary hover:text-text-primary transition-colors"
                        >
                            {showVisualEditor ? 'Show JSON' : 'Show Visual'}
                        </button>
                        <button
                            onClick={onLoadTemplate}
                            className="text-[10px] px-2 py-1 rounded bg-secondary/50 hover:bg-secondary text-text-secondary hover:text-text-primary transition-colors"
                        >
                            Load Template
                        </button>
                    </div>
                </div>
            </div>

            {/* Preview Status Bar */}
            {isPreviewing && previewTheme && (
                <div className="px-3 py-2 bg-primary/10 border-b border-primary/30 flex items-center gap-2">
                    <Eye size={12} className="text-primary" />
                    <span className="text-[11px] text-primary font-medium flex-1">
                        Previewing: {previewTheme.name}
                    </span>
                    <button
                        onClick={onCancelPreview}
                        className="text-[10px] px-2 py-0.5 rounded bg-secondary hover:bg-secondary/80 text-text-secondary transition-colors"
                    >
                        Cancel
                    </button>
                </div>
            )}

            {/* Visual Editor */}
            {showVisualEditor ? (
                <div className="flex-1 p-3 overflow-y-auto">
                    {Object.entries(groupedColors).map(([category, colors]) => (
                        <div key={category} className="mb-4">
                            <div className="text-xs font-semibold uppercase tracking-wider text-text-secondary mb-2">
                                {category}
                            </div>
                            <div className="grid grid-cols-2 gap-2">
                                {Object.entries(colors).map(([path, color]) => {
                                    const currentValue = editedColors[path] || color.value;
                                    return (
                                        <div key={path} className="flex items-center gap-2">
                                            <input
                                                type="color"
                                                value={currentValue}
                                                onChange={(e) => handleColorChange(path, e.target.value)}
                                                className="w-8 h-8 rounded cursor-pointer border-0"
                                                title={path}
                                            />
                                            <div className="flex-1 min-w-0">
                                                <input
                                                    type="text"
                                                    value={currentValue}
                                                    onChange={(e) => handleColorChange(path, e.target.value)}
                                                    className="w-full px-2 py-1 rounded text-[10px] font-mono bg-input/50 border border-border focus:border-primary focus:outline-none"
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
                <div className="flex-1 p-3 overflow-hidden flex flex-col">
                    <textarea
                        value={jsonInput}
                        onChange={(e) => onJsonChange(e.target.value)}
                        placeholder="Paste your theme JSON here..."
                        className={clsx(
                            "flex-1 w-full p-3 rounded-lg border font-mono text-[11px] leading-relaxed resize-none",
                            "bg-input/50 focus:outline-none focus:ring-1 transition-all",
                            parseError
                                ? "border-error/50 focus:ring-error/50 focus:border-error"
                                : "border-border focus:ring-primary/50 focus:border-primary"
                        )}
                        spellCheck={false}
                    />

                    {/* Error Display */}
                    {parseError && (
                        <div className="mt-2 p-2 rounded bg-error/10 border border-error/30">
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
                        <div className="mt-2 p-2 rounded bg-error/10 border border-error/30">
                            <div className="flex items-start gap-2">
                                <AlertCircle size={14} className="text-error flex-shrink-0 mt-0.5" />
                                <span className="text-[10px] text-error">{saveError}</span>
                            </div>
                        </div>
                    )}

                    {/* Success Message */}
                    {saveStatus === 'success' && (
                        <div className="mt-2 p-2 rounded bg-success/10 border border-success/30">
                            <div className="flex items-center gap-2">
                                <CheckCircle2 size={14} className="text-success" />
                                <span className="text-[10px] text-success">Theme saved successfully!</span>
                            </div>
                        </div>
                    )}
                </div>
            )}

            {/* Action Buttons */}
            <div className="p-3 border-t border-border flex gap-2">
                {isPreviewing ? (
                    <>
                        <button
                            onClick={onCancelPreview}
                            className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-secondary hover:bg-secondary/80 text-text-primary text-xs font-medium transition-colors"
                        >
                            <X size={14} />
                            Cancel
                        </button>
                        <button
                            onClick={onSave}
                            disabled={saveStatus === 'saving'}
                            className={clsx(
                                "flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium transition-colors",
                                saveStatus === 'saving'
                                    ? "bg-primary/50 text-primary-foreground/50 cursor-not-allowed"
                                    : "bg-primary hover:bg-primary-hover text-primary-foreground"
                            )}
                        >
                            <Save size={14} />
                            {saveStatus === 'saving' ? 'Saving...' : 'Save Theme'}
                        </button>
                    </>
                ) : (
                    <button
                        onClick={onPreview}
                        className="w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-primary hover:bg-primary-hover text-primary-foreground text-xs font-medium transition-colors"
                    >
                        <Eye size={14} />
                        Preview Theme
                    </button>
                )}
            </div>
        </div>
    );
};
