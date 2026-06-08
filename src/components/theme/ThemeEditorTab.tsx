import React, { useMemo, useState } from "react";
import { AlertCircle, CheckCircle2, Eye, Save, X } from "lucide-react";
import clsx from "clsx";

import type { ThemeDefinition, ThemeFile } from "../../types/theme";

export interface ThemeEditorState {
  jsonInput: string;
  parseError: string | null;
  isPreviewing: boolean;
  previewTheme: ThemeDefinition | null;
  saveStatus: "idle" | "saving" | "success" | "error";
  saveError: string | null;
}

type ThemeJsonMap = Record<string, unknown>;
type FlatColorMap = Record<
  string,
  { path: string; value: string; category: string }
>;

/**
 * Visual editor sections expose the most-used tokens grouped by surface.
 * Order matters: the first section is shown first in the scroll list.
 *
 * Coverage rule: every section should include enough tokens that a user
 * can recolor the surface without dropping to JSON. The full token
 * contract (121 tokens) is documented in DOCS/theme-dev.md.
 */
const VISUAL_EDITOR_SECTIONS = [
  {
    id: "core-text",
    title: "App Text & Surfaces",
    paths: [
      "common.textPrimary",
      "common.textSecondary",
      "common.textDisabled",
      "common.muted",
      "common.mutedForeground",
      "common.border",
      "common.borderHover",
    ],
  },
  {
    id: "core-action",
    title: "Primary & Accent",
    paths: [
      "common.primary",
      "common.primaryHover",
      "common.primaryForeground",
      "common.secondary",
      "common.secondaryHover",
      "common.secondaryForeground",
      "common.accent",
      "common.accentForeground",
      "common.accentMuted",
    ],
  },
  {
    id: "core-state",
    title: "Semantic States",
    paths: [
      "common.success",
      "common.successForeground",
      "common.warning",
      "common.warningForeground",
      "common.error",
      "common.errorForeground",
      "common.info",
      "common.infoForeground",
      "common.destructive",
      "common.destructiveForeground",
    ],
  },
  {
    id: "core-effects",
    title: "Shadows, Scrim & Focus",
    paths: [
      "common.shadow",
      "common.shadowElevated",
      "common.overlay",
      "common.scrim",
      "common.focusRing",
      "common.scrollbar",
      "common.scrollbarHover",
    ],
  },
  {
    id: "editor",
    title: "Editor",
    paths: [
      "editor.background",
      "editor.foreground",
      "editor.cursor",
      "editor.cursorLine",
      "editor.lineNumbers",
      "editor.lineNumbersActive",
      "editor.selection",
      "editor.selectionHighlight",
      "editor.wordHighlight",
      "editor.findMatch",
      "editor.findMatchHighlight",
      "editor.matchingBracket",
      "editor.indentGuide",
      "editor.whitespace",
    ],
  },
  {
    id: "sidebar",
    title: "Sidebar / Explorer",
    paths: [
      "sidebar.background",
      "sidebar.foreground",
      "sidebar.border",
      "sidebar.sectionHeader",
      "sidebar.itemHover",
      "sidebar.itemActive",
      "sidebar.itemSelected",
    ],
  },
  {
    id: "chat",
    title: "Chat / Agent",
    paths: [
      "chat.background",
      "chat.surface",
      "chat.surfaceBorder",
      "chat.surfaceMuted",
      "chat.inputBackground",
      "chat.inputBorder",
      "chat.userMessage",
      "chat.assistantMessage",
      "chat.thinkingBackground",
      "chat.thinkingBorder",
      "chat.toolCallBackground",
      "chat.toolCallBorder",
      "chat.codeBlock",
      "chat.usageLow",
      "chat.usageMedium",
      "chat.usageHigh",
    ],
  },
  {
    id: "titleBar",
    title: "Title Bar",
    paths: [
      "titleBar.background",
      "titleBar.foreground",
      "titleBar.border",
      "titleBar.buttonHover",
    ],
  },
  {
    id: "statusBar",
    title: "Status Bar",
    paths: [
      "statusBar.background",
      "statusBar.foreground",
      "statusBar.border",
      "statusBar.itemHover",
    ],
  },
  {
    id: "diff",
    title: "Git Diff",
    paths: [
      "common.diffAdded",
      "common.diffAddedForeground",
      "common.diffRemoved",
      "common.diffRemovedForeground",
      "common.diffModified",
      "common.diffModifiedForeground",
    ],
  },
  {
    id: "status-task",
    title: "Status & Tasks",
    paths: [
      "common.statusActive",
      "common.statusInactive",
      "common.statusError",
      "common.statusWarning",
      "common.taskPending",
      "common.taskInProgress",
      "common.taskCompleted",
      "common.taskCancelled",
      "common.checkpoint",
      "common.checkpointForeground",
    ],
  },
  {
    id: "connection-action",
    title: "Connection & Quick Actions",
    paths: [
      "common.secureConnection",
      "common.insecureConnection",
      "common.localConnection",
      "common.actionAnalyze",
      "common.actionDebug",
      "common.actionGenerate",
      "common.actionTest",
    ],
  },
  {
    id: "terminal-base",
    title: "Terminal — Base",
    paths: [
      "terminal.background",
      "terminal.foreground",
      "terminal.cursor",
      "terminal.selection",
    ],
  },
  {
    id: "terminal-ansi",
    title: "Terminal — ANSI Palette",
    paths: [
      "terminal.black",
      "terminal.red",
      "terminal.green",
      "terminal.yellow",
      "terminal.blue",
      "terminal.magenta",
      "terminal.cyan",
      "terminal.white",
      "terminal.brightBlack",
      "terminal.brightRed",
      "terminal.brightGreen",
      "terminal.brightYellow",
      "terminal.brightBlue",
      "terminal.brightMagenta",
      "terminal.brightCyan",
      "terminal.brightWhite",
    ],
  },
] as const;

interface ThemeEditorTabProps {
  editorState: ThemeEditorState;
  onJsonChange: (value: string) => void;
  onPreview: () => void;
  onCancelPreview: () => void;
  onSave: () => void;
  onLoadTemplate: () => void;
  headerStyle: React.CSSProperties;
  panelStyle: React.CSSProperties;
  surfaceStyle: React.CSSProperties;
  footerStyle?: React.CSSProperties;
  primaryButtonStyle: React.CSSProperties;
}

export const ThemeEditorTab: React.FC<ThemeEditorTabProps> = ({
  editorState,
  onJsonChange,
  onPreview,
  onCancelPreview,
  onSave,
  onLoadTemplate,
  headerStyle,
  panelStyle,
  surfaceStyle,
  footerStyle,
  primaryButtonStyle,
}) => {
  const { jsonInput, parseError, isPreviewing, previewTheme, saveStatus, saveError } =
    editorState;
  const [showVisualEditor, setShowVisualEditor] = useState(true);
  const [editedColors, setEditedColors] = useState<Record<string, string>>({});

  const themeColors = useMemo(() => {
    try {
      const parsed = JSON.parse(jsonInput) as ThemeFile;
      return parsed.colors || {};
    } catch {
      return {};
    }
  }, [jsonInput]);

  const flatColors = useMemo(() => {
    const colors: FlatColorMap = {};

    const isColorString = (v: string): boolean => {
      const t = v.trim().toLowerCase();
      return t.startsWith("#") || t.startsWith("rgb(") || t.startsWith("rgba(");
    };

    const flatten = (
      obj: ThemeJsonMap,
      prefix = "",
      category = "",
    ) => {
      for (const key in obj) {
        const value = obj[key];
        const fullPath = prefix ? `${prefix}.${key}` : key;
        // Accept hex, rgb(), and rgba() — anything matching our color
        // grammar — so partial themes with alpha tokens (e.g. "#00000080"
        // or "rgba(0,0,0,.4)") are editable instead of silently dropped.
        if (typeof value === "string" && isColorString(value)) {
          colors[fullPath] = { path: fullPath, value, category };
        } else if (
          typeof value === "object" &&
          value !== null &&
          !Array.isArray(value)
        ) {
          flatten(value as ThemeJsonMap, fullPath, category || key);
        }
      }
    };

    flatten(themeColors as ThemeJsonMap);
    return colors;
  }, [themeColors]);

  /**
   * `<input type="color">` only accepts `#RRGGBB`. Strip alpha and coerce
   * rgb()/rgba() to a hex preview so the swatch renders. The text field
   * still shows the raw value so users can edit alpha directly.
   */
  const toHexForPicker = (value: string): string => {
    const t = value.trim();
    if (/^#[0-9a-fA-F]{6}$/.test(t)) return t;
    if (/^#[0-9a-fA-F]{8}$/.test(t)) return t.slice(0, 7);
    if (/^#[0-9a-fA-F]{3}$/.test(t)) {
      return `#${t[1]}${t[1]}${t[2]}${t[2]}${t[3]}${t[3]}`;
    }
    if (/^#[0-9a-fA-F]{4}$/.test(t)) {
      return `#${t[1]}${t[1]}${t[2]}${t[2]}${t[3]}${t[3]}`;
    }
    const m = t.match(/^rgba?\(\s*(\d+)\s*[,\s]\s*(\d+)\s*[,\s]\s*(\d+)/i);
    if (m) {
      const r = Math.min(255, parseInt(m[1], 10)).toString(16).padStart(2, "0");
      const g = Math.min(255, parseInt(m[2], 10)).toString(16).padStart(2, "0");
      const b = Math.min(255, parseInt(m[3], 10)).toString(16).padStart(2, "0");
      return `#${r}${g}${b}`;
    }
    return "#000000";
  };

  const handleColorChange = (path: string, value: string) => {
    setEditedColors((previous) => ({ ...previous, [path]: value }));

    try {
      const parsed = JSON.parse(jsonInput) as ThemeFile;
      const pathParts = path.split(".");
      let current: ThemeJsonMap = parsed.colors as ThemeJsonMap;

      for (let index = 0; index < pathParts.length - 1; index += 1) {
        const next = current[pathParts[index]];
        if (!next || typeof next !== "object" || Array.isArray(next)) {
          return;
        }
        current = next as ThemeJsonMap;
      }

      current[pathParts[pathParts.length - 1]] = value;
      onJsonChange(JSON.stringify(parsed, null, 2));

      if (!parseError) {
        onPreview();
      }
    } catch (error) {
      console.error("Error updating color:", error);
    }
  };

  const visibleSections = useMemo(() => {
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
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b px-3 py-3" style={headerStyle}>
        <div className="flex items-center justify-between gap-3">
          <div>
            <span className="text-sm font-semibold uppercase tracking-[0.14em]">
              Theme Editor
            </span>
            <div className="mt-1 text-[10px] text-text-secondary">
              {showVisualEditor
                ? "Visual editor - click colors to edit"
                : "Paste JSON to preview and save"}
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => setShowVisualEditor(!showVisualEditor)}
              className="rounded-[10px] px-2.5 py-1.5 text-[10px] text-text-secondary transition-colors hover:text-text-primary"
              style={panelStyle}
            >
              {showVisualEditor ? "Show JSON" : "Show Visual"}
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

      {isPreviewing && previewTheme ? (
        <div
          className="flex items-center gap-2 border-b px-3 py-2"
          style={panelStyle}
        >
          <Eye size={12} className="text-primary" />
          <span className="flex-1 text-[11px] font-medium text-primary">
            Previewing: {previewTheme.name}
          </span>
          <button
            onClick={onCancelPreview}
            className="rounded-[9px] px-2 py-1 text-[10px] text-text-secondary transition-colors"
            style={surfaceStyle}
          >
            Cancel
          </button>
        </div>
      ) : null}

      {showVisualEditor ? (
        <div className="flex-1 min-h-0 overflow-y-auto p-3 scrollbar-thin">
          {visibleSections.map((section) => (
            <div
              key={section.id}
              className="mb-4 rounded-[18px] p-3"
              style={panelStyle}
            >
              <div className="mb-3 text-xs font-semibold uppercase tracking-[0.14em] text-text-secondary">
                {section.title}
              </div>
              <div className="grid grid-cols-2 gap-2">
                {section.colors.map((color) => {
                  const currentValue = editedColors[color.path] || color.value;

                  return (
                    <div
                      key={color.path}
                      className="flex items-center gap-2 rounded-[14px] p-2"
                      style={surfaceStyle}
                    >
                      <input
                        type="color"
                        value={toHexForPicker(currentValue)}
                        onChange={(event) =>
                          handleColorChange(color.path, event.target.value)
                        }
                        className="h-8 w-8 cursor-pointer rounded border-0"
                        title={color.path}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="mb-1 truncate text-[10px] font-medium text-text-secondary">
                          {color.path}
                        </div>
                        <input
                          type="text"
                          value={currentValue}
                          onChange={(event) =>
                            handleColorChange(color.path, event.target.value)
                          }
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
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden p-3">
          <textarea
            value={jsonInput}
            onChange={(event) => onJsonChange(event.target.value)}
            placeholder="Paste your theme JSON here..."
            className={clsx(
              "flex-1 w-full resize-none rounded-[16px] border p-3 font-mono text-[11px] leading-relaxed",
              "focus:outline-none focus:ring-1 transition-all",
              parseError
                ? "border-error/50 focus:border-error focus:ring-error/50"
                : "focus:border-primary focus:ring-primary/50",
            )}
            style={panelStyle}
            spellCheck={false}
          />

          {parseError ? (
            <div className="mt-2 rounded-[14px] border border-error/30 bg-error/10 p-2">
              <div className="flex items-start gap-2">
                <AlertCircle size={14} className="mt-0.5 shrink-0 text-error" />
                <pre className="flex-1 whitespace-pre-wrap break-words text-[10px] text-error">
                  {parseError}
                </pre>
              </div>
            </div>
          ) : null}

          {saveError ? (
            <div className="mt-2 rounded-[14px] border border-error/30 bg-error/10 p-2">
              <div className="flex items-start gap-2">
                <AlertCircle size={14} className="mt-0.5 shrink-0 text-error" />
                <span className="text-[10px] text-error">{saveError}</span>
              </div>
            </div>
          ) : null}

          {saveStatus === "success" ? (
            <div className="mt-2 rounded-[14px] border border-success/30 bg-success/10 p-2">
              <div className="flex items-center gap-2">
                <CheckCircle2 size={14} className="text-success" />
                <span className="text-[10px] text-success">
                  Theme saved successfully!
                </span>
              </div>
            </div>
          ) : null}
        </div>
      )}

      <div
        className="flex gap-2 border-t p-3"
        style={footerStyle ?? headerStyle}
      >
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
              disabled={saveStatus === "saving"}
              className={clsx(
                "flex flex-1 items-center justify-center gap-1.5 rounded-[12px] px-3 py-2 text-xs font-medium transition-colors",
                saveStatus === "saving"
                  ? "cursor-not-allowed bg-primary/50 text-primary-foreground/50"
                  : "text-primary-foreground",
              )}
              style={saveStatus === "saving" ? undefined : primaryButtonStyle}
            >
              <Save size={14} />
              {saveStatus === "saving" ? "Saving..." : "Save Theme"}
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
