import React, { useEffect, useState } from "react";
import { Check, FolderTree, Palette, PenLine } from "lucide-react";
import clsx from "clsx";

import { themeService } from "../../services/theme-service";
import { useThemeStore } from "../../store/useThemeStore";
import type { ThemeDefinition, ThemeFile } from "../../types/theme";
import { ExplorerIconPackPanel } from "./ExplorerIconPackPanel";
import {
  ThemeEditorTab,
  type ThemeEditorState,
} from "./ThemeEditorTab";
import { THEME_TEMPLATE } from "./theme-editor-shared";

type TabType = "themes" | "iconPacks" | "editor";

const shellStyle: React.CSSProperties = {
  backgroundColor:
    "color-mix(in srgb, var(--aurora-sidebar-background) 88%, var(--aurora-editor-background) 12%)",
};

const headerStyle: React.CSSProperties = {
  backgroundColor:
    "color-mix(in srgb, var(--aurora-title-bar-background) 76%, var(--aurora-sidebar-background) 24%)",
  borderColor: "color-mix(in srgb, var(--aurora-common-border) 72%, transparent)",
};

const panelStyle: React.CSSProperties = {
  backgroundColor:
    "color-mix(in srgb, var(--aurora-common-secondary) 76%, var(--aurora-sidebar-background) 24%)",
  border: "1px solid color-mix(in srgb, var(--aurora-common-border) 58%, transparent)",
  boxShadow: `
        inset 0 1px 0 color-mix(in srgb, var(--aurora-common-primary-foreground) 5%, transparent),
        inset 0 -1px 0 color-mix(in srgb, var(--aurora-common-shadow) 8%, transparent)
    `,
};

const activeCardStyle: React.CSSProperties = {
  backgroundColor:
    "color-mix(in srgb, var(--aurora-common-primary) 10%, var(--aurora-common-secondary))",
  border: "1px solid color-mix(in srgb, var(--aurora-common-primary) 22%, transparent)",
  boxShadow: `
        inset 0 1px 0 color-mix(in srgb, var(--aurora-common-primary-foreground) 6%, transparent),
        inset 0 -1px 0 color-mix(in srgb, var(--aurora-common-shadow) 8%, transparent)
    `,
};

const primaryButtonStyle: React.CSSProperties = {
  backgroundColor: "var(--aurora-common-primary)",
  color: "var(--aurora-common-primary-foreground)",
  boxShadow:
    "0 10px 24px color-mix(in srgb, var(--aurora-common-primary) 18%, transparent)",
};

export const ThemePanel: React.FC = () => {
  const { themes, activeThemeId, setActiveTheme, importTheme, isLoading, error } =
    useThemeStore();
  const [activeTab, setActiveTab] = useState<TabType>(() => {
    const saved = localStorage.getItem("theme-panel-active-tab");
    return saved === "themes" || saved === "iconPacks" || saved === "editor"
      ? saved
      : "themes";
  });
  const [previewThemeId, setPreviewThemeId] = useState<string | null>(null);
  const [committedThemeId, setCommittedThemeId] = useState(activeThemeId);

  const [editorState, setEditorState] = useState<ThemeEditorState>(() => {
    const saved = localStorage.getItem("theme-panel-editor-state");
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
    localStorage.setItem("theme-panel-active-tab", activeTab);
  }, [activeTab]);

  useEffect(() => {
    localStorage.setItem("theme-panel-editor-state", JSON.stringify(editorState));
  }, [editorState]);

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

    setPreviewThemeId(null);
    const committedTheme = themes.find((item) => item.id === committedThemeId);
    if (committedTheme) {
      themeService.applyTheme(committedTheme);
    }
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

      const previewId = `preview-${Date.now()}`;
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
    const committedTheme = themes.find((item) => item.id === committedThemeId);
    if (committedTheme) {
      themeService.applyTheme(committedTheme);
    }

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
        setActiveTab("themes");
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

  if (isLoading && themes.length === 0) {
    return (
      <div
        className="flex h-full flex-col items-center justify-center p-4 text-text-primary"
        style={shellStyle}
      >
        <span className="loading loading-spinner text-primary"></span>
        <span className="mt-2 text-xs text-text-secondary">Loading themes...</span>
      </div>
    );
  }

  if (error && themes.length === 0) {
    return (
      <div
        className="flex h-full flex-col items-center justify-center p-4 text-center text-text-primary"
        style={shellStyle}
      >
        <span className="mb-1 text-xs font-medium text-error">Error Loading Themes</span>
        <span className="text-[10px] text-text-secondary">{error}</span>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col text-text-primary" style={shellStyle}>
      <div className="border-b px-2 py-2" style={headerStyle}>
        <div className="flex flex-wrap rounded-[14px] p-1" style={panelStyle}>
          <button
            onClick={() => setActiveTab("themes")}
            className={clsx(
              "flex min-w-[92px] flex-1 items-center justify-center gap-1.5 rounded-[10px] px-3 py-2 text-xs font-medium whitespace-nowrap transition-colors",
              activeTab === "themes"
                ? "text-primary"
                : "border-transparent text-text-secondary hover:text-text-primary",
            )}
            style={activeTab === "themes" ? activeCardStyle : undefined}
          >
            <Palette size={14} />
            Themes
          </button>
          <button
            onClick={() => setActiveTab("iconPacks")}
            className={clsx(
              "flex min-w-[92px] flex-1 items-center justify-center gap-1.5 rounded-[10px] px-3 py-2 text-xs font-medium whitespace-nowrap transition-colors",
              activeTab === "iconPacks"
                ? "text-primary"
                : "border-transparent text-text-secondary hover:text-text-primary",
            )}
            style={activeTab === "iconPacks" ? activeCardStyle : undefined}
          >
            <FolderTree size={14} />
            Icon Packs
          </button>
          <button
            onClick={() => setActiveTab("editor")}
            className={clsx(
              "flex min-w-[92px] flex-1 items-center justify-center gap-1.5 rounded-[10px] px-3 py-2 text-xs font-medium whitespace-nowrap transition-colors",
              activeTab === "editor"
                ? "text-primary"
                : "border-transparent text-text-secondary hover:text-text-primary",
            )}
            style={activeTab === "editor" ? activeCardStyle : undefined}
          >
            <PenLine size={14} />
            Editor
          </button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {error && themes.length > 0 ? (
          <div className="mx-3 mt-3 rounded-[14px] border border-error/30 bg-error/10 px-3 py-2 text-[10px] text-error">
            {error}
          </div>
        ) : null}

        {activeTab === "themes" ? (
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
            />
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
            headerStyle={headerStyle}
            panelStyle={panelStyle}
            surfaceStyle={shellStyle}
            footerStyle={headerStyle}
            primaryButtonStyle={primaryButtonStyle}
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
  onEdit,
}) => {
  return (
    <>
      <div className="border-b px-3 py-3" style={headerStyle}>
        <span className="text-sm font-semibold uppercase tracking-[0.14em]">Themes</span>
        <div className="mt-1 text-[10px] text-text-secondary">{themes.length} installed</div>
      </div>

      <div
        className="flex-1 min-h-0 space-y-3 overflow-y-auto p-3 scrollbar-thin"
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
                "group relative w-full cursor-pointer overflow-hidden rounded-[18px] p-3 text-left transition-all focus:outline-none",
                isPreviewActive ? "text-primary" : "hover:border-primary/50",
              )}
              style={isPreviewActive ? activeCardStyle : panelStyle}
              onMouseEnter={() => onMouseEnter(theme.id)}
              onClick={() => onSelect(theme.id)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onSelect(theme.id);
                }
              }}
            >
              <div className="mb-3 flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <span
                    className={clsx(
                      "flex items-center gap-1.5 truncate text-[13px] font-semibold",
                      isPreviewActive ? "text-primary" : "text-text-primary",
                    )}
                  >
                    {theme.name}
                    {isCommitted ? <Check size={12} className="text-primary" /> : null}
                    {theme.isBuiltIn ? (
                      <span
                        className="rounded-full px-1.5 py-0.5 text-[9px] text-text-secondary"
                        style={panelStyle}
                      >
                        Built-in
                      </span>
                    ) : null}
                  </span>
                  <div className="mt-1 flex items-center gap-1">
                    <span className="truncate text-[10px] text-text-secondary">
                      by {theme.author}
                    </span>
                  </div>
                </div>
                <button
                  onClick={(event) => {
                    event.stopPropagation();
                    onEdit(theme);
                  }}
                  className="flex h-8 w-8 items-center justify-center rounded-[10px] text-text-secondary opacity-70 transition-all hover:text-text-primary group-hover:opacity-100"
                  style={panelStyle}
                  title="Edit theme"
                >
                  <PenLine size={14} />
                </button>
              </div>

              <div className="flex h-10 w-full overflow-hidden rounded-[14px] border border-border/50 opacity-95 transition-opacity group-hover:opacity-100">
                <div
                  style={{ backgroundColor: sidebar }}
                  className="flex w-8 flex-col items-center gap-0.5 py-1"
                >
                  <div
                    className="h-3 w-3 rounded-[2px]"
                    style={{ backgroundColor: activity }}
                  ></div>
                  <div className="h-3 w-3 rounded-[2px] bg-white opacity-20"></div>
                </div>
                <div
                  style={{ backgroundColor: bg, color: primary }}
                  className="flex flex-1 items-center px-2 text-[9px] font-mono"
                >
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
