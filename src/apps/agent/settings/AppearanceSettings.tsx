/**
 * Agent Window — Appearance settings (view).
 *
 * Full theming control for the agent window, applied INSTANTLY (no save button)
 * the same way the IDE theme works: every control writes a token override to
 * `useAgentThemeStore`, which `AgentThemeProvider` resolves live. Supports
 * preset themes, drop-a-JSON-file import, export/copy, a curated "quick" dial
 * set (accent / background / foreground / fonts / contrast / translucent) and
 * per-region color editors (rail, conversation, composer, code, status…).
 *
 * ## Why this page is tabbed and the others are not
 *
 * Every control here edits one token, and there are around fifty of them — as
 * one column that is a page nobody reaches the bottom of, where the Reset that
 * undoes a mistake is the furthest thing from the mistake. The tabs are the
 * groupings that already existed as section headings, promoted to navigation so
 * only one is on screen at a time.
 *
 * Search deliberately un-tabs the page: with a query active every group renders
 * and the tab bar is gone, because a result the tabs are hiding is a result the
 * search has failed to return. See `searching` below.
 *
 * All `--agw-*` native — no IDE/Tailwind reuse.
 */

import React, { useMemo, useRef, useState } from "react";

import { AgentIcon, type AgentIconName } from "../shared/AgentIcon";
import {
  DEFAULT_RAIL_GLIDE_MS,
  useAgentThemeStore,
  type AgentUiVersion,
  type AgentTokenKey,
} from "@/apps/agent/store/ui/useAgentThemeStore";
import {
  AGENT_THEMES,
  DEFAULT_AGENT_THEME_ID,
  TYPOGRAPHY_TOKEN_KEYS,
} from "../theme/themes";
import { toColorInputValue } from "../theme/color";
import { AGENT_UI_FONT_STACK, CODE_FONT_STACK } from "@/kernel/lib/fonts/stacks";
import { listExplorerIconPacks } from "@/kernel/lib/icons/icon-packs";
import { useIconPackStore } from "@/kernel/store/useIconPackStore";
import { useSettingsStore } from "@/kernel/store/useSettingsStore";
import { FontStackPicker } from "./FontStackPicker";
import { writeClipboardText } from "@/kernel/lib/clipboard";
import type { AgentThemeTokens } from "../types";
import {
  SettingsSection,
  SettingsRow,
  SettingsBlock,
  AgwSwitch,
  AgwButton,
  AgwSegmented,
  AgwSelect,
  type SelectOption,
} from "./primitives";
import { useSettingsQuery } from "./settings-search";
import { useAgentUiStore, type AppearanceTab } from "@/apps/agent/store/ui/useAgentUiStore";

// ── Tabs ────────────────────────────────────────────────────────────────────

const TABS: { id: AppearanceTab; label: string; icon: AgentIconName }[] = [
  { id: "theme", label: "Theme", icon: "palette" },
  { id: "layout", label: "Layout", icon: "panel-left" },
  { id: "text", label: "Text", icon: "type" },
  { id: "colours", label: "Colours", icon: "contrast" },
  { id: "advanced", label: "Advanced", icon: "sliders" },
];

/**
 * Which tab owns each per-region colour group.
 *
 * "Shared surfaces" is the one group whose tokens repaint the entire window
 * rather than one region, so it sits under Advanced beside Reset — the two
 * things worth reaching deliberately rather than stumbling into.
 */
const ADVANCED_GROUP = "Shared surfaces";

// ── Region / token groupings (full coverage of the editable token set) ───────

interface TokenField {
  key: AgentTokenKey;
  label: string;
  hint: string;
  editor?: "color" | "text";
}
interface TokenGroup {
  title: string;
  icon: AgentIconName;
  description: string;
  fields: TokenField[];
}

// Each control edits ONE token. Tokens are grouped by what they ACTUALLY paint:
// the first groups are scoped to a single region; the final "Shared surfaces"
// group holds tokens reused across the whole window (editing one of those
// repaints everywhere on purpose — hence the explicit hint).
const REGION_GROUPS: TokenGroup[] = [
  {
    title: "Content sheet",
    icon: "chat",
    description:
      "The recessed panel inset into the window frame — it holds the conversation, the settings pages, and the dock's content areas.",
    fields: [
      { key: "conversation", label: "Sheet fill", hint: "The rounded content panel the conversation and settings sit on." },
      { key: "bubbleUser", label: "Your message", hint: "The filled bubble around messages you send." },
      { key: "bubbleAssistant", label: "Assistant message", hint: "The background behind each assistant turn; transparent keeps it unboxed." },
    ],
  },
  {
    title: "Window frame — rail & dock",
    icon: "panel-left",
    description:
      "The frame around the content sheet. Both panels follow the Window frame colour in Quick controls until you set them here.",
    fields: [
      { key: "rail", label: "Left rail", hint: "The project and chat navigator. The titlebar and the gutters around the content sheet follow this colour." },
      { key: "dock", label: "Right dock", hint: "The chrome of the Files, Browser, Terminal, and Review panel." },
    ],
  },
  {
    title: "Composer — input box",
    icon: "send",
    description: "Scoped to the message input only.",
    fields: [
      { key: "composerSurface", label: "Input fill", hint: "The message composer, its inner typing surface, and the pickers it opens — model, reasoning, and the @ / menus." },
      { key: "controlMuted", label: "Idle control", hint: "Off switches, counters, quiet status pills, and range tracks." },
    ],
  },
  {
    title: "Text",
    icon: "type",
    description:
      "Foreground text at three emphasis levels (window-wide). Selection highlights, active tabs, and quiet control fills are derived from Primary automatically, so they stay visible on any background you choose.",
    fields: [
      { key: "text", label: "Primary", hint: "Main message, heading, button, and input text." },
      { key: "textMuted", label: "Muted", hint: "Secondary labels, inactive controls, and supporting values." },
      { key: "textSubtle", label: "Subtle", hint: "Placeholders, metadata, helper copy, and low-emphasis icons." },
    ],
  },
  {
    title: "Code & chips",
    icon: "terminal",
    description: "Inline code, fenced blocks and metadata chips.",
    fields: [
      { key: "codeSurface", label: "Code fill", hint: "Fenced code blocks, inline code panels, and tool output code." },
      { key: "codeBorder", label: "Code border", hint: "Outlines around fenced code and code result panels." },
      { key: "chipSurface", label: "Chip fill", hint: "File, command, keyboard, and metadata chip backgrounds." },
      { key: "chipText", label: "Chip text", hint: "Text and icons inside metadata chips." },
    ],
  },
  {
    title: "Status & diffs",
    icon: "diff",
    description: "Added / removed / warning / info signals.",
    fields: [
      { key: "added", label: "Added", hint: "Success states and added-line text, borders, and markers." },
      { key: "addedSurface", label: "Added fill", hint: "Background behind added diff lines and success result blocks." },
      { key: "removed", label: "Removed", hint: "Errors, destructive actions, and removed-line text and markers." },
      { key: "removedSurface", label: "Removed fill", hint: "Background behind removed diff lines and error result blocks." },
      { key: "warning", label: "Warning", hint: "Plan mode, cautions, and warning badges or notices." },
      { key: "info", label: "Info", hint: "Informational badges such as usage and account-status labels." },
    ],
  },
  {
    title: "Shared surfaces",
    icon: "columns",
    description:
      "These are reused across the whole window — editing one repaints menus, pills, cards, selected rows and dividers everywhere. That's expected.",
    fields: [
      { key: "surface", label: "Quiet surface", hint: "Resting cards, hover fills on list rows, and inset panels." },
      { key: "surfaceElevated", label: "Elevated surface", hint: "Popover menus, dialog panels, the context tooltip, and the command center. The composer's own pickers (model, reasoning, @ and /) follow Input fill instead, so the input cluster stays one colour. Selected rows and tabs derive from Primary text." },
      { key: "overlay", label: "Modal backdrop", hint: "The full-window scrim behind dialogs, image preview, and the command center." },
      { key: "border", label: "Divider line", hint: "Standard separators and outlines between rows, cards, fields, and panels." },
      { key: "borderStrong", label: "Strong line", hint: "Higher-emphasis outlines on popovers, dialogs, active fields, and resize handles." },
      { key: "ring", label: "Focus ring", hint: "Keyboard-focus outline around interactive controls." },
      { key: "hover", label: "Hover fill", hint: "Background shown while pointing at quiet rows, chips, and buttons." },
      { key: "onAccent", label: "On-accent text", hint: "Text and icons drawn on primary accent-filled controls." },
      { key: "scrollThumb", label: "Scrollbar", hint: "The resting scrollbar thumb in scrollable panes." },
      { key: "scrollThumbHover", label: "Scrollbar hover", hint: "The scrollbar thumb while it is hovered." },
      { key: "shadowPop", label: "Popover shadow", hint: "The CSS shadow under menus, popovers, and the command center.", editor: "text" },
    ],
  },
];

// Faces that SHIP with Aurora (kernel/lib/fonts/bundled.ts) — always offered
// at the top of the pickers; everything else in the dropdown comes from the
// machine's own installed-font scan.
//
// MUST stay in step with `bundled.ts`. A name here that isn't imported there
// offers a face that silently renders as a fallback, which is the failure this
// list exists to prevent — the picker's whole promise is "these work whatever
// is installed on your machine".
//
// Ordered by default first, then by how different each one is from it, so the
// list reads as a set of real alternatives rather than an alphabetical dump.
const BUNDLED_UI_FONTS = ["Inter Variable", "Geist", "Inter", "Manrope", "IBM Plex Sans"];
const BUNDLED_CODE_FONTS = [
  "JetBrains Mono",
  "Geist Mono",
  "Cascadia Code",
  "Fira Code",
];

type MessageWeight = "400" | "450" | "500";

/**
 * Parse a numeric token ("15px", "1.75") with a hard default — a custom theme
 * saved before the message-typography tokens existed simply lacks them, and a
 * slider bound to NaN renders broken.
 */
function tokenNumber(raw: string | undefined, fallback: number): number {
  const n = Number.parseFloat(raw ?? "");
  return Number.isFinite(n) ? n : fallback;
}

type RadiusPreset = "sharp" | "default" | "round";
const RADIUS_PRESETS: Record<RadiusPreset, Pick<AgentThemeTokens, "radiusSm" | "radiusMd" | "radiusLg">> = {
  sharp: { radiusSm: "3px", radiusMd: "5px", radiusLg: "7px" },
  default: { radiusSm: "6px", radiusMd: "10px", radiusLg: "14px" },
  round: { radiusSm: "10px", radiusMd: "14px", radiusLg: "20px" },
};

// ── Color row ────────────────────────────────────────────────────────────────

const ColorRow: React.FC<{
  field: TokenField;
  value: string;
  last?: boolean;
  onChange: (value: string) => void;
}> = ({ field, value, last, onChange }) => (
  <SettingsRow label={field.label} hint={field.hint} last={last}>
    <div className="agw-appr-color">
      <label className="agw-appr-swatch" title="Pick a color">
        <span className="agw-appr-swatch-fill" style={{ background: value || "transparent" }} />
        <input
          type="color"
          value={toColorInputValue(value)}
          onChange={(e) => onChange(e.target.value)}
          aria-label={`${field.label} color`}
        />
      </label>
      <input
        className="agw-set-input agw-appr-hex"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
        autoCorrect="off"
        autoCapitalize="off"
        aria-label={`${field.label} value`}
      />
    </div>
  </SettingsRow>
);

const TextTokenRow: React.FC<{
  field: TokenField;
  value: string;
  last?: boolean;
  onChange: (value: string) => void;
}> = ({ field, value, last, onChange }) => (
  <SettingsRow label={field.label} hint={field.hint} last={last}>
    <input
      className="agw-set-input"
      value={value}
      onChange={(event) => onChange(event.target.value)}
      spellCheck={false}
      aria-label={`${field.label} value`}
      style={{ width: 320 }}
    />
  </SettingsRow>
);

// ── Page ─────────────────────────────────────────────────────────────────────

export const AppearanceSettings: React.FC = () => {
  const activeThemeId = useAgentThemeStore((s) => s.activeThemeId);
  const customThemes = useAgentThemeStore((s) => s.customThemes);
  const customizations = useAgentThemeStore((s) => s.customizations);
  const translucentSidebar = useAgentThemeStore((s) => s.translucentSidebar);
  const uiVersion = useAgentThemeStore((s) => s.uiVersion);
  const contrast = useAgentThemeStore((s) => s.contrast);
  const reduceMotion = useAgentThemeStore((s) => s.reduceMotion);
  const syntaxHighlighting = useAgentThemeStore((s) => s.syntaxHighlighting);
  const railGlide = useAgentThemeStore((s) => s.railGlide);
  const railGlideMs = useAgentThemeStore((s) => s.railGlideMs);

  // File icons live in the SHARED settings store rather than the agent theme
  // store: the editor window owns the same choice, and a second copy would let
  // the two windows show different icons for the same file.
  const explorerIconPack = useSettingsStore((s) => s.explorerIconPack);
  const setExplorerIconPack = useSettingsStore((s) => s.setExplorerIconPack);
  // Custom packs are imported at runtime, so the list has to be LIVE. The
  // registry behind `listExplorerIconPacks` is a plain module-level map with
  // nothing to subscribe to — reading it once at mount would show a pack
  // imported afterwards only on the next visit to this page. Recomputing when
  // `customPacks` changes is what makes an import appear immediately, and it is
  // the whole reason this depends on the store rather than on nothing.
  const customPacks = useIconPackStore((s) => s.customPacks);
  const iconPackOptions: SelectOption[] = useMemo(() => {
    // `customPacks` is READ here, not just depended on: it is what marks a row
    // as imported, and reading it is also what makes the dependency honest.
    // (Depending on it purely as a change signal is what `exhaustive-deps`
    // correctly objects to.)
    const imported = new Set(customPacks.map((bundle) => bundle.manifest.id));
    return listExplorerIconPacks().map((pack) => ({
      value: pack.manifest.id as string,
      label: pack.manifest.name,
      // Built-in and imported packs are indistinguishable by name alone once
      // there are several, and only one kind can be removed again.
      meta: imported.has(pack.manifest.id) ? "Imported" : undefined,
    }));
  }, [customPacks]);

  const setActiveTheme = useAgentThemeStore((s) => s.setActiveTheme);
  const setToken = useAgentThemeStore((s) => s.setToken);
  const setTokens = useAgentThemeStore((s) => s.setTokens);
  const resetCustomizations = useAgentThemeStore((s) => s.resetCustomizations);
  const resetTypography = useAgentThemeStore((s) => s.resetTypography);
  const setTranslucentSidebar = useAgentThemeStore((s) => s.setTranslucentSidebar);
  const setUiVersion = useAgentThemeStore((s) => s.setUiVersion);
  const setContrast = useAgentThemeStore((s) => s.setContrast);
  const setReduceMotion = useAgentThemeStore((s) => s.setReduceMotion);
  const setSyntaxHighlighting = useAgentThemeStore((s) => s.setSyntaxHighlighting);
  const setRailGlide = useAgentThemeStore((s) => s.setRailGlide);
  const setRailGlideMs = useAgentThemeStore((s) => s.setRailGlideMs);
  const importThemeJson = useAgentThemeStore((s) => s.importThemeJson);

  const themes = useMemo(() => {
    const map = new Map<string, (typeof AGENT_THEMES)[string]>();
    for (const t of Object.values(AGENT_THEMES)) map.set(t.id, t);
    for (const t of Object.values(customThemes)) map.set(t.id, t);
    return Array.from(map.values());
  }, [customThemes]);

  const fileRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [notice, setNotice] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  // Persisted, so reopening Appearance returns to the category last worked in
  // rather than to the top of the page.
  const storedTab = useAgentUiStore((s) => s.appearanceTab);
  const setTab = useAgentUiStore((s) => s.setAppearanceTab);
  // A persisted value survives a rename or removal of the tab it names, and an
  // id no section answers to renders a page with nothing on it. Fall back
  // rather than show an empty Appearance.
  const tab = TABS.some((t) => t.id === storedTab) ? storedTab : "theme";

  // A query turns the tabs off entirely rather than filtering within one: the
  // sections hide themselves when they do not match, so rendering all of them
  // is what lets a search for "scrollbar" find a token three tabs away.
  const searching = useSettingsQuery().length > 0;
  const shows = (id: AppearanceTab) => searching || tab === id;

  const tabsRef = useRef<HTMLDivElement>(null);

  /**
   * Switch category and return to the top of the page.
   *
   * Without the scroll, leaving a long tab part-way down lands the next one at
   * whatever offset the last one was at — a category that opens half-read, with
   * its heading already off screen.
   */
  const selectTab = (next: AppearanceTab) => {
    setTab(next);
    tabsRef.current?.closest(".agw-settings-content")?.scrollTo({ top: 0 });
  };

  const onTabKeys = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    const index = TABS.findIndex((t) => t.id === tab);
    if (index < 0) return;
    const step = e.key === "ArrowRight" ? 1 : TABS.length - 1;
    selectTab(TABS[(index + step) % TABS.length].id);
    e.preventDefault();
  };
  const noticeTimer = useRef<number | undefined>(undefined);

  // Editable (pre-contrast) token values: base theme + the user's overrides.
  const base = useMemo(
    () =>
      customThemes[activeThemeId] ??
      AGENT_THEMES[activeThemeId] ??
      AGENT_THEMES[DEFAULT_AGENT_THEME_ID],
    [customThemes, activeThemeId],
  );
  const tokens = useMemo<AgentThemeTokens>(
    () => ({ ...base.tokens, ...(customizations[activeThemeId] ?? {}) }),
    [base, customizations, activeThemeId],
  );

  const hasOverrides = Boolean(customizations[activeThemeId]);
  const hasTypographyOverrides = TYPOGRAPHY_TOKEN_KEYS.some(
    (key) => customizations[activeThemeId]?.[key] !== undefined,
  );
  const hasAppearanceChanges =
    hasOverrides ||
    contrast !== 50 ||
    translucentSidebar ||
    uiVersion !== "classic" ||
    reduceMotion ||
    !syntaxHighlighting ||
    !railGlide ||
    railGlideMs !== DEFAULT_RAIL_GLIDE_MS;
  const radiusPreset: RadiusPreset =
    (Object.keys(RADIUS_PRESETS) as RadiusPreset[]).find(
      (p) => RADIUS_PRESETS[p].radiusMd === tokens.radiusMd,
    ) ?? "default";

  // Message-typography tokens as slider-ready numbers (defaults are the
  // design values baked into the CSS fallbacks).
  const uiTextScaleVal = tokenNumber(tokens.uiTextScale, 1);
  const msgFontSizePx = tokenNumber(tokens.msgFontSize, 15);
  const msgLineHeightVal = tokenNumber(tokens.msgLineHeight, 1.75);
  const msgUserFontSizePx = tokenNumber(tokens.msgUserFontSize, 14);
  const msgUserLineHeightVal = tokenNumber(tokens.msgUserLineHeight, 1.6);
  const msgCodeFontSizePx = tokenNumber(tokens.msgCodeFontSize, 13);
  const msgWeightVal: MessageWeight = (["400", "450", "500"] as const).includes(
    tokens.msgFontWeight as MessageWeight,
  )
    ? (tokens.msgFontWeight as MessageWeight)
    : "400";

  const flash = (tone: "ok" | "err", text: string) => {
    setNotice({ tone, text });
    window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => setNotice(null), 2600);
  };

  const applyFile = async (file: File) => {
    if (!file.name.endsWith(".json")) {
      flash("err", "Drop a .json theme file.");
      return;
    }
    try {
      const text = await file.text();
      const { applied } = importThemeJson(text);
      flash("ok", `Applied ${applied} token${applied === 1 ? "" : "s"} from ${file.name}.`);
    } catch (e) {
      flash("err", e instanceof Error ? e.message : "Could not import that file.");
    }
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) void applyFile(file);
  };

  const exportTheme = () => {
    const payload = {
      id: `${base.id}-custom`,
      name: `${base.name} (custom)`,
      appearance: base.appearance,
      tokens,
    };
    const json = JSON.stringify(payload, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${base.id}-appearance.json`;
    a.click();
    URL.revokeObjectURL(url);
    flash("ok", "Exported theme JSON.");
  };

  const copyTheme = async () => {
    const json = JSON.stringify({ appearance: base.appearance, tokens }, null, 2);
    const ok = await writeClipboardText(json);
    flash(ok ? "ok" : "err", ok ? "Theme JSON copied." : "Couldn't copy.");
  };

  return (
    <div className="agw-set-wide">
      <header className="agw-set-section-head" style={{ marginBottom: 2 }}>
        <div className="agw-set-section-title-wrap">
          <span className="agw-set-section-ico">
            <AgentIcon name="palette" size={15} />
          </span>
          <div style={{ minWidth: 0 }}>
            <h3 className="agw-set-section-title">Appearance</h3>
            <p className="agw-set-section-desc">
              Theme the agent window. Every change applies instantly and is scoped to this
              window — the IDE theme is never touched.
            </p>
          </div>
        </div>
        <div className="agw-mcp-headtools">
          <AgwButton icon="upload" onClick={() => fileRef.current?.click()}>
            Import JSON
          </AgwButton>
          <AgwButton icon="download" onClick={exportTheme}>
            Export
          </AgwButton>
          <AgwButton icon="copy" onClick={() => void copyTheme()}>
            Copy
          </AgwButton>
        </div>
      </header>

      <input
        ref={fileRef}
        type="file"
        accept="application/json,.json"
        style={{ display: "none" }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void applyFile(f);
          e.target.value = "";
        }}
      />

      {notice && (
        <div className="agw-set-notice" data-tone={notice.tone === "ok" ? "success" : "warning"}>
          <AgentIcon name={notice.tone === "ok" ? "check" : "help"} size={14} />
          <span>{notice.text}</span>
        </div>
      )}

      {/* Category tabs. Hidden while searching — see `searching` above. */}
      {!searching && (
        <div
          ref={tabsRef}
          className="agw-set-tabs"
          role="tablist"
          aria-label="Appearance categories"
          onKeyDown={onTabKeys}
        >
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              id={`agw-appr-tab-${t.id}`}
              aria-selected={t.id === tab}
              aria-controls={`agw-appr-panel-${t.id}`}
              // Only the selected tab is in the tab order; the arrow keys move
              // between them, which is what a tablist is expected to do.
              tabIndex={t.id === tab ? 0 : -1}
              className="agw-set-tab"
              data-selected={t.id === tab || undefined}
              onClick={() => selectTab(t.id)}
            >
              <AgentIcon name={t.icon} size={14} />
              <span>{t.label}</span>
            </button>
          ))}
        </div>
      )}

      <div
        // Carries the column gap `.agw-set-wide` would have applied directly to
        // the sections, which this wrapper now sits between.
        className="agw-set-tabpanel"
        // One panel wrapper per rendered tab so the relationship the tabs
        // announce actually exists in the a11y tree. While searching there is
        // no selected tab, so the panel is a plain container.
        {...(searching
          ? {}
          : {
              role: "tabpanel",
              id: `agw-appr-panel-${tab}`,
              "aria-labelledby": `agw-appr-tab-${tab}`,
            })}
      >

      {/* Preset themes + drop zone */}
      {shows("theme") && (
      <SettingsSection
        title="Theme"
        icon="palette"
        description="Start from a preset, then tweak below. Drop a theme JSON to apply it."
      >
        <SettingsBlock>
          <div className="agw-appr-presets">
            {themes.map((t) => (
              <button
                key={t.id}
                type="button"
                className="agw-appr-card"
                data-active={t.id === activeThemeId || undefined}
                onClick={() => setActiveTheme(t.id)}
              >
                <span className="agw-appr-card-preview" data-appearance={t.appearance}>
                  <span style={{ background: t.tokens.canvas }} />
                  <span style={{ background: t.tokens.surfaceElevated }} />
                  <span style={{ background: t.tokens.accent }} />
                  <span style={{ background: t.tokens.text }} />
                </span>
                <span className="agw-appr-card-name">{t.name}</span>
                {t.id === activeThemeId && (
                  <span className="agw-appr-card-check">
                    <AgentIcon name="check" size={12} />
                  </span>
                )}
              </button>
            ))}
          </div>
        </SettingsBlock>

        <SettingsBlock last>
          <div
            className="agw-appr-drop"
            data-over={dragOver || undefined}
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={onDrop}
            onClick={() => fileRef.current?.click()}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") fileRef.current?.click();
            }}
          >
            <AgentIcon name="upload" size={18} />
            <span>
              <strong>Drop a theme JSON</strong> here, or click to browse. Cursor/Claude-style
              token maps and exported Aurora themes both work.
            </span>
          </div>
        </SettingsBlock>
      </SettingsSection>
      )}

      {/* Quick controls */}
      {shows("theme") && (
      <SettingsSection
        title="Quick controls"
        icon="sliders"
        description="The dials you reach for most."
      >
        <ColorRow
          field={{
            key: "accent",
            label: "Accent",
            hint: "The one brand colour, used sparingly so it keeps meaning: links, the reasoning switch when on, effort and mode chips, pinned and active markers in the rail, progress and activity indicators, and the mic waveform. Selected rows and the send button are deliberately neutral, and the focus outline has its own Focus ring setting.",
          }}
          value={tokens.accent}
          onChange={(v) => setToken("accent", v)}
        />
        <ColorRow
          field={{
            key: "accentHover",
            label: "Accent (hover)",
            hint: "Only used while pointing at a filled accent button — Confirm in dialogs, primary buttons in Settings, the microphone permission prompt, and Done in the image editor. Usually a shade or two lighter than Accent.",
          }}
          value={tokens.accentHover}
          onChange={(v) => setToken("accentHover", v)}
        />
        <ColorRow
          field={{
            key: "canvas",
            label: "Window frame",
            hint: "The frame around the content sheet — titlebar, gutters, and both side panels recolor together.",
          }}
          value={tokens.canvas}
          onChange={(v) => {
            // The frame is ONE visual tier painted by three tokens. Moving
            // only `canvas` would recolor just the titlebar + gutters and
            // leave the rail/dock behind — a visible fractured seam. The
            // per-panel pickers below still allow deliberate divergence.
            setToken("canvas", v);
            setToken("rail", v);
            setToken("dock", v);
          }}
        />
        <ColorRow
          field={{
            key: "text",
            label: "Foreground",
            hint: "The main text colour used across the window.",
          }}
          value={tokens.text}
          onChange={(v) => setToken("text", v)}
        />
        <SettingsRow label="Contrast" hint="Foreground / line separation. 50 is neutral." last>
          <div className="agw-appr-range-wrap">
            <input
              type="range"
              className="agw-appr-range"
              min={0}
              max={100}
              value={contrast}
              onChange={(e) => setContrast(Number(e.target.value))}
              aria-label="Contrast"
            />
            <span className="agw-appr-range-val">{contrast}</span>
          </div>
        </SettingsRow>
      </SettingsSection>
      )}

      {/* Shape, density, and the icon set — how the window is built rather than
          how it is coloured. */}
      {shows("layout") && (
      <SettingsSection
        title="Interface"
        icon="panel-left"
        description="Shape, density, and the file icon set."
      >
        <SettingsRow label="Corner radius" hint="Roundness of cards, inputs and buttons.">
          <AgwSegmented<RadiusPreset>
            value={radiusPreset}
            ariaLabel="Corner radius"
            options={[
              { value: "sharp", label: "Sharp" },
              { value: "default", label: "Default" },
              { value: "round", label: "Round" },
            ]}
            onChange={(p) => setTokens(RADIUS_PRESETS[p])}
          />
        </SettingsRow>
        <SettingsRow
          label="Interface"
          hint="V2 is Aurora's newer look: cards give up some fill and lift off the page instead — a soft shadow, a lit top edge, a faint grain — and dense pages are restructured, so Providers gets a pinned header with Connection and Models tabs. Same settings and same actions in both, and your colours are untouched."
        >
          <AgwSegmented<AgentUiVersion>
            value={uiVersion}
            ariaLabel="Interface"
            options={[
              { value: "classic", label: "Classic" },
              { value: "v2", label: "V2" },
            ]}
            onChange={setUiVersion}
          />
        </SettingsRow>
        {/* File icons. The setting is shared with the editor window on purpose:
            it is one answer to "what does a TypeScript file look like", and two
            controls would let the Files panel and the file tree disagree three
            feet apart. It reaches further than the name suggests — the shell
            badge on a tool row takes its mark from the same pack. */}
        <SettingsRow
          label="File icons"
          hint="Icon set for the Files panel, file chips and the shell badge on tool rows. Shared with the editor window, and imported packs appear here too."
        >
          {/* A dropdown, not a segmented control: packs can be imported, so the
              option count is unbounded and a pill row would overflow the row
              the moment someone adds a third. */}
          <AgwSelect
            value={explorerIconPack}
            ariaLabel="File icons"
            options={iconPackOptions}
            onChange={(id) => setExplorerIconPack(id as typeof explorerIconPack)}
            width={180}
          />
        </SettingsRow>
        <SettingsRow
          label="Translucent sidebar"
          hint="Frosted, semi-transparent rail and dock."
          last
        >
          <AgwSwitch
            checked={translucentSidebar}
            onChange={setTranslucentSidebar}
            ariaLabel="Translucent sidebar"
          />
        </SettingsRow>
      </SettingsSection>
      )}

      {/* Motion. Reduce motion leads because it overrides everything under it. */}
      {shows("layout") && (
      <SettingsSection
        title="Motion"
        icon="bolt"
        description="How much the window animates, and how the rail and dock open and close."
      >
        <SettingsRow label="Reduce motion" hint="Minimize non-essential animation.">
          <AgwSwitch checked={reduceMotion} onChange={setReduceMotion} ariaLabel="Reduce motion" />
        </SettingsRow>
        <SettingsRow
          label="Glide panels"
          hint="Animate the rail and dock sliding open and closed. Off snaps them open/closed instantly."
        >
          <AgwSwitch checked={railGlide} onChange={setRailGlide} ariaLabel="Glide panels" />
        </SettingsRow>
        <SettingsRow
          label="Glide speed"
          hint="Lower is snappier, higher is slower. Only applies while Glide panels is on."
          last
        >
          <div className="agw-appr-range-wrap">
            <input
              type="range"
              className="agw-appr-range"
              min={120}
              max={1200}
              step={20}
              value={railGlideMs}
              disabled={!railGlide}
              onChange={(e) => setRailGlideMs(Number(e.target.value))}
              aria-label="Glide speed"
            />
            <span className="agw-appr-range-val">{railGlideMs}ms</span>
          </div>
        </SettingsRow>
      </SettingsSection>
      )}

      {/* Typography */}
      {shows("text") && (
      <SettingsSection
        title="Typography"
        icon="type"
        description="Interface and code typefaces. The defaults — Inter Variable for the interface, JetBrains Mono for code, 15px reading text — are the shipped baseline."
        badge={
          hasTypographyOverrides ? (
            <AgwButton icon="reset" onClick={resetTypography}>
              Reset to defaults
            </AgwButton>
          ) : undefined
        }
      >
        <SettingsRow
          label="UI font"
          hint="Used across the window chrome and messages. Pick an installed font, or type a custom stack."
        >
          <FontStackPicker
            value={tokens.fontUi}
            baseStack={AGENT_UI_FONT_STACK}
            bundled={BUNDLED_UI_FONTS}
            onChange={(stack) => setToken("fontUi", stack)}
            ariaLabel="UI font"
          />
        </SettingsRow>
        <SettingsRow
          label="Code font"
          hint="Used for code blocks and the terminal. Pick an installed font, or type a custom stack."
        >
          <FontStackPicker
            value={tokens.fontCode}
            baseStack={CODE_FONT_STACK}
            bundled={BUNDLED_CODE_FONTS}
            onChange={(stack) => setToken("fontCode", stack)}
            ariaLabel="Code font"
          />
        </SettingsRow>
        <SettingsRow
          label="Interface text size"
          hint="Buttons, labels, tabs, list rows, panels and settings. Message text is set separately below."
        >
          <div className="agw-appr-range-wrap">
            <input
              type="range"
              className="agw-appr-range"
              min={0.9}
              max={1.15}
              step={0.05}
              value={uiTextScaleVal}
              onChange={(e) => setToken("uiTextScale", e.target.value)}
              aria-label="Interface text size"
            />
            <span className="agw-appr-range-val">
              {Math.round(uiTextScaleVal * 100)}%
            </span>
          </div>
        </SettingsRow>
        <SettingsRow
          label="Message text size"
          hint="The assistant's reply prose. Headings and code in a reply scale with it. Default 15px."
        >
          <div className="agw-appr-range-wrap">
            <input
              type="range"
              className="agw-appr-range"
              min={13}
              max={18}
              step={1}
              value={msgFontSizePx}
              onChange={(e) => setToken("msgFontSize", `${e.target.value}px`)}
              aria-label="Message text size"
            />
            <span className="agw-appr-range-val">{msgFontSizePx}px</span>
          </div>
        </SettingsRow>
        <SettingsRow
          label="Message line spacing"
          hint="Gap between lines of the assistant's reply. Default 1.75."
        >
          <div className="agw-appr-range-wrap">
            <input
              type="range"
              className="agw-appr-range"
              min={1.4}
              max={2}
              step={0.05}
              value={msgLineHeightVal}
              onChange={(e) => setToken("msgLineHeight", String(e.target.value))}
              aria-label="Message line height"
            />
            <span className="agw-appr-range-val">{msgLineHeightVal.toFixed(2)}</span>
          </div>
        </SettingsRow>
        <SettingsRow
          label="Code block text size"
          hint="Fenced code inside a reply. Code written inline in a sentence stays sized to the sentence. Default 13px."
        >
          <div className="agw-appr-range-wrap">
            <input
              type="range"
              className="agw-appr-range"
              min={11}
              max={18}
              step={1}
              value={msgCodeFontSizePx}
              onChange={(e) => setToken("msgCodeFontSize", `${e.target.value}px`)}
              aria-label="Code block text size"
            />
            <span className="agw-appr-range-val">{msgCodeFontSizePx}px</span>
          </div>
        </SettingsRow>
        <SettingsRow
          label="Message weight"
          hint="Stroke weight of the assistant's reply prose. Default Regular (400)."
        >
          <AgwSegmented<MessageWeight>
            value={msgWeightVal}
            ariaLabel="Message weight"
            options={[
              { value: "400", label: "Regular" },
              { value: "450", label: "Book" },
              { value: "500", label: "Medium" },
            ]}
            onChange={(w) => setToken("msgFontWeight", w)}
          />
        </SettingsRow>
        <SettingsRow
          label="Your message size"
          hint="Text in the bubbles you send; mid-turn notes follow it. Default 14px."
        >
          <div className="agw-appr-range-wrap">
            <input
              type="range"
              className="agw-appr-range"
              min={12}
              max={17}
              step={1}
              value={msgUserFontSizePx}
              onChange={(e) => setToken("msgUserFontSize", `${e.target.value}px`)}
              aria-label="Your message size"
            />
            <span className="agw-appr-range-val">{msgUserFontSizePx}px</span>
          </div>
        </SettingsRow>
        <SettingsRow
          label="Your message line spacing"
          hint="Gap between lines inside sent bubbles and mid-turn notes. Default 1.60."
          last
        >
          <div className="agw-appr-range-wrap">
            <input
              type="range"
              className="agw-appr-range"
              min={1.3}
              max={1.9}
              step={0.05}
              value={msgUserLineHeightVal}
              onChange={(e) => setToken("msgUserLineHeight", String(e.target.value))}
              aria-label="Your message line height"
            />
            <span className="agw-appr-range-val">{msgUserLineHeightVal.toFixed(2)}</span>
          </div>
        </SettingsRow>
      </SettingsSection>
      )}

      {/* Per-region color editors */}
      {REGION_GROUPS.map((group) => {
        const isCode = group.title === "Code & chips";
        // Window-wide tokens live under Advanced; everything region-scoped
        // under Colours.
        if (!shows(group.title === ADVANCED_GROUP ? "advanced" : "colours")) return null;
        return (
          <SettingsSection
            key={group.title}
            title={group.title}
            icon={group.icon}
            description={group.description}
          >
            {isCode && (
              <SettingsRow
                label="Syntax highlighting"
                hint="Colour code by language in tool cards, the file viewer and message code blocks. Off renders code in one foreground colour."
              >
                <AgwSwitch
                  checked={syntaxHighlighting}
                  onChange={setSyntaxHighlighting}
                  ariaLabel="Syntax highlighting"
                />
              </SettingsRow>
            )}
            {group.fields.map((field, i) => {
              // `key` is passed to the element directly and deliberately kept
              // OUT of this object. React treats `key` as a reserved directive,
              // not a prop, so spreading it in makes React fall back to reading
              // it off the spread — a pattern that warns in 18.x and stops
              // working in 19.
              const props = {
                field,
                value: tokens[field.key],
                last: i === group.fields.length - 1,
                onChange: (value: string) => setToken(field.key, value),
              };
              return field.editor === "text" ? (
                <TextTokenRow key={field.key} {...props} />
              ) : (
                <ColorRow key={field.key} {...props} />
              );
            })}
          </SettingsSection>
        );
      })}

      {/* Reset */}
      {shows("advanced") && (
      <SettingsSection
        title="Reset"
        icon="reset"
        description="Discard every customization and return to the preset's defaults."
      >
        <SettingsRow
          label="Reset appearance"
          hint={
            hasAppearanceChanges
              ? "This theme differs from its defaults."
              : "Nothing to reset — this theme is at its defaults."
          }
          last
        >
          <AgwButton
            variant="danger"
            icon="reset"
            disabled={!hasAppearanceChanges}
            onClick={resetCustomizations}
          >
            Reset to default
          </AgwButton>
        </SettingsRow>
      </SettingsSection>
      )}
      </div>
    </div>
  );
};
