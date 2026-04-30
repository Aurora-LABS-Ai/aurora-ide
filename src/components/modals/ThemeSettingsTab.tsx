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

import React, { useEffect, useRef, useState } from "react";
import { Check, FolderTree, Palette, PenLine, Trash2, Upload } from "lucide-react";
import { clsx } from "clsx";
import { open } from "@tauri-apps/plugin-dialog";
import { readTextFile } from "@tauri-apps/plugin-fs";

import { isTauri } from "../../lib/tauri";
import { themeService } from "../../services/theme-service";
import { useThemeStore } from "../../store/useThemeStore";
import type { ThemeDefinition, ThemeFile } from "../../types/theme";
import { useThemeImportDrag } from "../../hooks/useThemeImportDrag";
import { ExplorerIconPackPanel } from "../theme/ExplorerIconPackPanel";
import {
  ThemeEditorTab,
  type ThemeEditorState,
} from "../theme/ThemeEditorTab";
import { THEME_TEMPLATE } from "../theme/theme-editor-shared";
import {
  settingsCardStyle,
  settingsPrimaryButtonStyle,
  settingsRowDividerColor,
  settingsSubtlePanelStyle,
} from "./settings-shared";
import {
  Section,
  StatusPill,
  ActionButton,
  IconButton,
} from "./settings-primitives";

type AppearanceTab = "themes" | "iconPacks" | "editor";

// ---------------------------------------------------------------------------
// SegmentedNav — enterprise-grade tab switcher used at the top of the panel.
// ---------------------------------------------------------------------------

interface SegmentedNavItem {
  id: AppearanceTab;
  label: string;
  icon: React.ComponentType<React.SVGProps<SVGSVGElement>>;
}

interface SegmentedNavProps {
  active: AppearanceTab;
  onChange: (next: AppearanceTab) => void;
  items: SegmentedNavItem[];
}

const SegmentedNav: React.FC<SegmentedNavProps> = ({ active, onChange, items }) => (
  <div
    className="inline-flex items-center"
    style={{
      backgroundColor:
        'color-mix(in srgb, var(--aurora-title-bar-background) 60%, var(--aurora-sidebar-background) 40%)',
      border: '1px solid color-mix(in srgb, var(--aurora-common-border) 70%, transparent)',
      borderRadius: 6,
      padding: 2,
    }}
  >
    {items.map(({ id, label, icon: Icon }) => {
      const isActive = active === id;
      return (
        <button
          key={id}
          type="button"
          onClick={() => onChange(id)}
          className={clsx(
            'inline-flex h-7 items-center gap-1.5 px-2.5 text-[11.5px] font-semibold tracking-tight transition-colors',
          )}
          style={{
            color: isActive
              ? 'var(--aurora-common-primary)'
              : 'var(--aurora-text-secondary, var(--aurora-editor-foreground))',
            backgroundColor: isActive
              ? 'color-mix(in srgb, var(--aurora-common-primary) 14%, transparent)'
              : 'transparent',
            borderRadius: 4,
          }}
        >
          <Icon width={13} height={13} />
          <span>{label}</span>
        </button>
      );
    })}
  </div>
);

export const ThemeSettingsTab: React.FC = () => {
  const {
    themes,
    activeThemeId,
    setActiveTheme,
    importTheme,
    deleteTheme,
    isLoading,
    error,
  } = useThemeStore();

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [activeTab, setActiveTab] = useState<AppearanceTab>(() => {
    const saved = localStorage.getItem("theme-settings-active-tab");
    return saved === "themes" || saved === "iconPacks" || saved === "editor"
      ? saved
      : "themes";
  });
  const [previewThemeId, setPreviewThemeId] = useState<string | null>(null);
  const [committedThemeId, setCommittedThemeId] = useState(activeThemeId);
  const [editorState, setEditorState] = useState<ThemeEditorState>(() => {
    const saved = localStorage.getItem("theme-settings-editor-state");
    if (saved) {
      try {
        return JSON.parse(saved);
      } catch {
        return {
          jsonInput: JSON.stringify(THEME_TEMPLATE, null, 2),
          parseError: null,
          isPreviewing: false,
          previewTheme: null,
          saveStatus: "idle",
          saveError: null,
        };
      }
    }

    return {
      jsonInput: JSON.stringify(THEME_TEMPLATE, null, 2),
      parseError: null,
      isPreviewing: false,
      previewTheme: null,
      saveStatus: "idle",
      saveError: null,
    };
  });

  useEffect(() => {
    setCommittedThemeId(activeThemeId);
  }, [activeThemeId]);

  useEffect(() => {
    localStorage.setItem("theme-settings-active-tab", activeTab);
  }, [activeTab]);

  useEffect(() => {
    localStorage.setItem("theme-settings-editor-state", JSON.stringify(editorState));
  }, [editorState]);

  useEffect(() => {
    return () => {
      const committedTheme = themes.find((theme) => theme.id === committedThemeId);
      if (committedTheme) {
        themeService.applyTheme(committedTheme);
      }
    };
  }, [committedThemeId, themes]);

  const restoreCommittedTheme = () => {
    setPreviewThemeId(null);
    const committedTheme = themes.find((theme) => theme.id === committedThemeId);
    if (committedTheme) {
      themeService.applyTheme(committedTheme);
    }
  };

  const switchTab = (nextTab: AppearanceTab) => {
    if (activeTab === "themes") {
      restoreCommittedTheme();
    }
    setActiveTab(nextTab);
  };

  const handleMouseEnter = (themeId: string) => {
    if (themeId === previewThemeId) return;

    setPreviewThemeId(themeId);
    const theme = themes.find((item) => item.id === themeId);
    if (theme) {
      themeService.applyTheme(theme);
    }
  };

  const handleMouseLeaveList = () => {
    if (!previewThemeId) return;
    restoreCommittedTheme();
  };

  const handleSelect = (themeId: string) => {
    setActiveTheme(themeId);
    setCommittedThemeId(themeId);
    setPreviewThemeId(null);
  };

  const handleJsonChange = (value: string) => {
    setEditorState((previous) => ({
      ...previous,
      jsonInput: value,
      parseError: null,
      saveStatus: "idle",
      saveError: null,
    }));
  };

  const handlePreview = () => {
    try {
      const parsed = JSON.parse(editorState.jsonInput);
      const validation = themeService.validateThemeFile(parsed);

      if (!validation.valid) {
        setEditorState((previous) => ({
          ...previous,
          parseError: validation.errors.join("\n"),
          isPreviewing: false,
          previewTheme: null,
        }));
        return;
      }

      const previewId = `settings-preview-${Date.now()}`;
      const themeDef = themeService.createThemeDefinition(
        parsed as ThemeFile,
        previewId,
        false,
      );

      themeService.applyTheme(themeDef);

      setEditorState((previous) => ({
        ...previous,
        parseError: null,
        isPreviewing: true,
        previewTheme: themeDef,
      }));
    } catch (error) {
      setEditorState((previous) => ({
        ...previous,
        parseError: `JSON Parse Error: ${(error as Error).message}`,
        isPreviewing: false,
        previewTheme: null,
      }));
    }
  };

  const handleCancelPreview = () => {
    restoreCommittedTheme();
    setEditorState((previous) => ({
      ...previous,
      isPreviewing: false,
      previewTheme: null,
    }));
  };

  const handleSaveTheme = async () => {
    if (!editorState.previewTheme) {
      handlePreview();
      return;
    }

    try {
      setEditorState((previous) => ({
        ...previous,
        saveStatus: "saving",
        saveError: null,
      }));

      const parsed = JSON.parse(editorState.jsonInput) as ThemeFile;
      const savedTheme = await importTheme(parsed);

      setActiveTheme(savedTheme.id);
      setCommittedThemeId(savedTheme.id);

      setEditorState((previous) => ({
        ...previous,
        saveStatus: "success",
        isPreviewing: false,
        previewTheme: null,
      }));

      setTimeout(() => {
        setEditorState((previous) => ({
          ...previous,
          saveStatus: "idle",
        }));
        switchTab("themes");
      }, 1500);
    } catch (error) {
      setEditorState((previous) => ({
        ...previous,
        saveStatus: "error",
        saveError: (error as Error).message,
      }));
    }
  };

  const handleLoadTemplate = () => {
    setEditorState((previous) => ({
      ...previous,
      jsonInput: JSON.stringify(THEME_TEMPLATE, null, 2),
      parseError: null,
      isPreviewing: false,
      previewTheme: null,
      saveStatus: "idle",
      saveError: null,
    }));
  };

  const handleImportClick = async () => {
    if (isTauri()) {
      try {
        const selected = await open({
          multiple: false,
          filters: [
            {
              name: "Theme Definitions",
              extensions: ["json"],
            },
          ],
        });

        if (selected && typeof selected === "string") {
          const content = await readTextFile(selected);
          await processThemeImport(content);
        }
      } catch (importError) {
        console.error("Failed to import theme:", importError);
      }
    } else {
      fileInputRef.current?.click();
    }
  };

  const handleFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async (loadEvent) => {
      const content = loadEvent.target?.result as string;
      if (content) {
        await processThemeImport(content);
      }
    };
    reader.readAsText(file);
    event.target.value = "";
  };

  const processThemeImport = async (content: string) => {
    try {
      const json = JSON.parse(content);
      await importTheme(json);
    } catch (importError) {
      console.error("Invalid theme file:", importError);
    }
  };

  const { isDragging: isTauriDragging } = useThemeImportDrag();
  const [isInternalDragging, setIsInternalDragging] = useState(false);
  const isDragging = isTauriDragging || isInternalDragging;

  const handleDragOver = (event: React.DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (isTauri()) return;
    setIsInternalDragging(true);
  };

  const handleDragLeave = (event: React.DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (isTauri()) return;
    setIsInternalDragging(false);
  };

  const handleDrop = async (event: React.DragEvent) => {
    event.preventDefault();
    event.stopPropagation();

    if (isTauri()) {
      setIsInternalDragging(false);
      return;
    }

    setIsInternalDragging(false);

    const file = event.dataTransfer.files[0];
    if (!file || !file.name.endsWith(".json")) {
      console.error("Please drop a valid .json theme file");
      return;
    }

    const reader = new FileReader();
    reader.onload = async (loadEvent) => {
      const content = loadEvent.target?.result as string;
      if (content) {
        await processThemeImport(content);
      }
    };
    reader.readAsText(file);
  };

  if (isLoading && themes.length === 0) {
    return (
      <Section title="Theme Library" description="Loading themes…">
        <div className="px-4 py-8 text-center text-[11.5px] text-text-secondary">
          Loading themes…
        </div>
      </Section>
    );
  }

  const builtInCount = themes.filter((t) => t.isBuiltIn).length;
  const customCount = themes.length - builtInCount;
  const navItems: SegmentedNavItem[] = [
    { id: "themes", label: "Themes", icon: Palette },
    { id: "iconPacks", label: "Icon Packs", icon: FolderTree },
    { id: "editor", label: "Editor", icon: PenLine },
  ];

  return (
    <div className="relative flex h-full flex-col overflow-hidden pb-2">
      {/* Top: segmented nav */}
      <div className="flex flex-none items-center justify-between gap-3 pb-4">
        <SegmentedNav active={activeTab} onChange={switchTab} items={navItems} />
        {activeTab === "themes" && (
          <div className="flex gap-1.5">
            <StatusPill variant="info" dot={false}>
              {builtInCount} built-in
            </StatusPill>
            <StatusPill variant="success" dot={false}>
              {customCount} custom
            </StatusPill>
          </div>
        )}
      </div>

      {activeTab === "themes" ? (
        <div
          className="relative flex min-h-0 flex-1 flex-col overflow-hidden"
          data-theme-drop-zone="true"
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          {isDragging ? (
            <div
              className="pointer-events-none absolute inset-0 z-50 flex items-center justify-center backdrop-blur-sm transition-all"
              style={{
                backgroundColor:
                  'color-mix(in srgb, var(--aurora-common-primary) 12%, transparent)',
                border: '2px dashed var(--aurora-common-primary)',
                borderRadius: 8,
              }}
            >
              <div
                className="flex animate-bounce flex-col items-center gap-2 font-medium"
                style={{ color: 'var(--aurora-common-primary)' }}
              >
                <Upload size={24} />
                <span className="text-[12.5px]">Drop JSON theme to import</span>
              </div>
            </div>
          ) : null}

          <div className="flex-none space-y-4 pb-4">
            <Section
              title="Theme Library"
              description="Hover any theme to preview, click to commit, or open it in the editor without leaving this pane."
            >
              <div
                className="flex items-center justify-between px-4 py-2.5"
              >
                <p className="text-[11.5px] leading-snug text-text-secondary">
                  {themes.length} theme{themes.length === 1 ? '' : 's'} installed.
                  Drop a <code className="font-mono text-text-primary">.json</code> file
                  anywhere on this pane to import.
                </p>
                <input
                  type="file"
                  ref={fileInputRef}
                  onChange={handleFileChange}
                  accept=".json"
                  className="hidden"
                />
                <ActionButton
                  variant="primary"
                  icon={<Upload className="h-3 w-3" />}
                  onClick={handleImportClick}
                >
                  Import Theme
                </ActionButton>
              </div>
            </Section>

            {error ? (
              <div
                className="px-4 py-2.5 text-[11.5px]"
                style={{
                  backgroundColor:
                    'color-mix(in srgb, var(--aurora-common-danger) 10%, transparent)',
                  border:
                    '1px solid color-mix(in srgb, var(--aurora-common-danger) 32%, transparent)',
                  borderRadius: 6,
                  color: 'var(--aurora-common-danger)',
                }}
              >
                {error}
              </div>
            ) : null}
          </div>

          <div
            className="min-h-0 flex-1 overflow-y-auto pr-2 -mr-2 scrollbar-thin"
            onMouseLeave={handleMouseLeaveList}
          >
            <div className="grid grid-cols-2 gap-2.5 pb-24">
              {themes.map((theme) => (
                <ThemeCard
                  key={theme.id}
                  theme={theme}
                  isPreviewActive={theme.id === (previewThemeId || activeThemeId)}
                  isCommitted={theme.id === committedThemeId}
                  onMouseEnter={() => handleMouseEnter(theme.id)}
                  onSelect={() => handleSelect(theme.id)}
                  onEdit={() => {
                    restoreCommittedTheme();
                    const nextName = theme.isBuiltIn
                      ? `${theme.name} Custom`
                      : theme.name;
                    setEditorState((previous) => ({
                      ...previous,
                      jsonInput: JSON.stringify(
                        {
                          name: nextName,
                          type: theme.type,
                          author: theme.author,
                          version: theme.version,
                          colors: theme.colors,
                          tokenColors: theme.tokenColors,
                        },
                        null,
                        2,
                      ),
                      saveStatus: "idle",
                      saveError: null,
                    }));
                    setActiveTab("editor");
                  }}
                  onDelete={
                    theme.isBuiltIn
                      ? undefined
                      : () => {
                          restoreCommittedTheme();
                          void deleteTheme(theme.id);
                        }
                  }
                />
              ))}
            </div>
          </div>
        </div>
      ) : activeTab === "iconPacks" ? (
        <ExplorerIconPackPanel />
      ) : (
        <ThemeEditorTab
          editorState={editorState}
          onJsonChange={handleJsonChange}
          onPreview={handlePreview}
          onCancelPreview={handleCancelPreview}
          onSave={handleSaveTheme}
          onLoadTemplate={handleLoadTemplate}
          headerStyle={settingsCardStyle}
          panelStyle={settingsCardStyle}
          surfaceStyle={settingsSubtlePanelStyle}
          footerStyle={settingsSubtlePanelStyle}
          primaryButtonStyle={settingsPrimaryButtonStyle}
        />
      )}
    </div>
  );
};

interface ThemeCardProps {
  theme: ThemeDefinition;
  isPreviewActive: boolean;
  isCommitted: boolean;
  onMouseEnter: () => void;
  onSelect: () => void;
  onEdit: () => void;
  onDelete?: () => void;
}

const themeCardStyle: React.CSSProperties = {
  backgroundColor:
    'color-mix(in srgb, var(--aurora-title-bar-background) 56%, var(--aurora-sidebar-background) 44%)',
  border: '1px solid color-mix(in srgb, var(--aurora-common-border) 70%, transparent)',
  borderRadius: 8,
};

const ThemeCard: React.FC<ThemeCardProps> = ({
  theme,
  isPreviewActive,
  isCommitted,
  onMouseEnter,
  onSelect,
  onEdit,
  onDelete,
}) => {
  const bg = theme.colors.editor.background;
  const fg = theme.colors.editor.foreground;
  const sidebar = theme.colors.sidebar.background;
  const activity = theme.colors.sidebar.itemActive;

  return (
    <div
      onMouseEnter={onMouseEnter}
      onClick={onSelect}
      className="group relative cursor-pointer overflow-hidden transition-colors"
      style={{
        ...themeCardStyle,
        borderColor: isPreviewActive
          ? 'var(--aurora-common-primary)'
          : 'color-mix(in srgb, var(--aurora-common-border) 70%, transparent)',
        boxShadow: isPreviewActive
          ? 'inset 0 0 0 1px var(--aurora-common-primary)'
          : undefined,
      }}
    >
      {/* Preview surface */}
      <div className="flex h-20 w-full" style={{ borderBottom: `1px solid ${settingsRowDividerColor}` }}>
        <div
          style={{ backgroundColor: sidebar }}
          className="flex w-7 flex-col items-center gap-1 py-2"
        >
          <div
            className="h-3 w-3"
            style={{ backgroundColor: activity, borderRadius: 2 }}
          />
          <div
            className="h-3 w-3"
            style={{
              backgroundColor: 'color-mix(in srgb, white 22%, transparent)',
              borderRadius: 2,
            }}
          />
        </div>
        <div
          style={{ backgroundColor: bg, color: fg }}
          className="flex-1 p-2 font-mono text-[8px] leading-tight"
        >
          <div style={{ color: theme.colors.editor.lineNumbers }} className="mb-0.5">
            1{' '}
            <span style={{ color: theme.colors.common.primary }}>import</span> React;
          </div>
          <div className="mb-0.5">2</div>
          <div className="mb-0.5">
            3{' '}
            <span style={{ color: theme.colors.common.success }}>const</span>{' '}
            <span style={{ color: theme.colors.common.warning }}>App</span> = () =&gt;{' '}
            {'{'}
          </div>
          <div className="mb-0.5">
            4{' '}
            <span style={{ color: theme.colors.common.primary }}>return</span> &lt;div/&gt;;
          </div>
          <div>5 {'}'}</div>
        </div>
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between gap-2 px-3 py-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <p className="truncate text-[12px] font-semibold text-text-primary">
              {theme.name}
            </p>
            {isCommitted && (
              <Check
                size={11}
                style={{ color: 'var(--aurora-common-primary)' }}
              />
            )}
          </div>
          <p className="truncate text-[10px] text-text-disabled">
            by {theme.author}
            {theme.isBuiltIn && (
              <span
                className="ml-1.5 inline-block px-1 py-0.5 align-middle text-[9px] font-semibold uppercase tracking-[0.08em]"
                style={{
                  color: 'var(--aurora-text-secondary, var(--aurora-editor-foreground))',
                  backgroundColor:
                    'color-mix(in srgb, var(--aurora-editor-foreground) 8%, transparent)',
                  border:
                    '1px solid color-mix(in srgb, var(--aurora-common-border) 50%, transparent)',
                  borderRadius: 3,
                }}
              >
                Built-in
              </span>
            )}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
          <IconButton
            ariaLabel="Edit theme"
            title="Edit theme"
            onClick={(event) => {
              event.stopPropagation();
              onEdit();
            }}
          >
            <PenLine size={11} />
          </IconButton>
          {onDelete && (
            <IconButton
              ariaLabel="Delete theme"
              title="Delete theme"
              variant="danger"
              onClick={(event) => {
                event.stopPropagation();
                onDelete();
              }}
            >
              <Trash2 size={11} />
            </IconButton>
          )}
        </div>
      </div>
    </div>
  );
};
