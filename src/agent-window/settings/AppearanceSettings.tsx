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
 * All `--agw-*` native — no IDE/Tailwind reuse.
 */

import React, { useMemo, useRef, useState } from "react";

import { AgentIcon, type AgentIconName } from "../shared/AgentIcon";
import {
  DEFAULT_RAIL_GLIDE_MS,
  useAgentThemeStore,
  type AgentTokenKey,
} from "../store/useAgentThemeStore";
import { AGENT_THEMES, DEFAULT_AGENT_THEME_ID } from "../theme/themes";
import { toColorInputValue } from "../theme/color";
import { writeClipboardText } from "../../lib/clipboard";
import type { AgentThemeTokens } from "../types";
import {
  SettingsSection,
  SettingsRow,
  SettingsBlock,
  AgwSwitch,
  AgwButton,
  AgwSegmented,
} from "./primitives";

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
    title: "Composer — input box",
    icon: "send",
    description: "Scoped to the message input only.",
    fields: [
      { key: "composerSurface", label: "Input fill", hint: "The message composer and its inner typing surface." },
      { key: "controlMuted", label: "Idle control", hint: "Off switches, counters, quiet status pills, and range tracks." },
    ],
  },
  {
    title: "Conversation",
    icon: "chat",
    description: "The message thread and its bubbles.",
    fields: [
      { key: "conversation", label: "Thread background", hint: "The center conversation canvas behind every turn." },
      { key: "bubbleUser", label: "Your message", hint: "The filled bubble around messages you send." },
      { key: "bubbleAssistant", label: "Assistant message", hint: "The background behind each assistant turn; transparent keeps it unboxed." },
    ],
  },
  {
    title: "Panels — rail & dock",
    icon: "panel-left",
    description: "The left conversation rail and the right tool dock.",
    fields: [
      { key: "rail", label: "Left rail", hint: "The project and chat navigator background." },
      { key: "dock", label: "Right dock", hint: "The Files, Browser, Terminal, and Review panel background." },
    ],
  },
  {
    title: "Text",
    icon: "type",
    description: "Foreground text at three emphasis levels (window-wide).",
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
      { key: "surface", label: "Quiet surface", hint: "Resting buttons, quiet cards, unselected tiles, and inset panels." },
      { key: "surfaceElevated", label: "Elevated surface", hint: "Popover menus, selected rows and tabs, dialog panels, and the command center." },
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

const UI_FONT_SUGGESTIONS = [
  '"Inter", "Segoe UI", system-ui, sans-serif',
  "system-ui, -apple-system, sans-serif",
  '"Segoe UI", system-ui, sans-serif',
  '"Roboto", system-ui, sans-serif',
];
const CODE_FONT_SUGGESTIONS = [
  '"JetBrains Mono", "Cascadia Code", Consolas, monospace',
  '"Cascadia Code", Consolas, monospace',
  '"Fira Code", monospace',
  '"SF Mono", ui-monospace, monospace',
];

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
  const contrast = useAgentThemeStore((s) => s.contrast);
  const reduceMotion = useAgentThemeStore((s) => s.reduceMotion);
  const syntaxHighlighting = useAgentThemeStore((s) => s.syntaxHighlighting);
  const railGlide = useAgentThemeStore((s) => s.railGlide);
  const railGlideMs = useAgentThemeStore((s) => s.railGlideMs);

  const setActiveTheme = useAgentThemeStore((s) => s.setActiveTheme);
  const setToken = useAgentThemeStore((s) => s.setToken);
  const setTokens = useAgentThemeStore((s) => s.setTokens);
  const resetCustomizations = useAgentThemeStore((s) => s.resetCustomizations);
  const setTranslucentSidebar = useAgentThemeStore((s) => s.setTranslucentSidebar);
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
  const hasAppearanceChanges =
    hasOverrides ||
    contrast !== 50 ||
    translucentSidebar ||
    reduceMotion ||
    !syntaxHighlighting ||
    !railGlide ||
    railGlideMs !== DEFAULT_RAIL_GLIDE_MS;
  const radiusPreset: RadiusPreset =
    (Object.keys(RADIUS_PRESETS) as RadiusPreset[]).find(
      (p) => RADIUS_PRESETS[p].radiusMd === tokens.radiusMd,
    ) ?? "default";

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

      {/* Preset themes + drop zone */}
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

      {/* Quick controls */}
      <SettingsSection
        title="Quick controls"
        icon="sliders"
        description="The dials you reach for most."
      >
        <ColorRow
          field={{
            key: "accent",
            label: "Accent",
            hint: "The primary highlight — send button, links, active/selected rows, focus rings and the effort label.",
          }}
          value={tokens.accent}
          onChange={(v) => setToken("accent", v)}
        />
        <ColorRow
          field={{
            key: "accentHover",
            label: "Accent (hover)",
            hint: "The accent's hover shade — accent buttons and controls when you point at them.",
          }}
          value={tokens.accentHover}
          onChange={(v) => setToken("accentHover", v)}
        />
        <ColorRow
          field={{
            key: "canvas",
            label: "Background",
            hint: "The base canvas behind the whole window (behind the rail, thread and dock).",
          }}
          value={tokens.canvas}
          onChange={(v) => setToken("canvas", v)}
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
        <SettingsRow label="Contrast" hint="Foreground / line separation. 50 is neutral.">
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
        <SettingsRow label="Translucent sidebar" hint="Frosted, semi-transparent rail and dock.">
          <AgwSwitch
            checked={translucentSidebar}
            onChange={setTranslucentSidebar}
            ariaLabel="Translucent sidebar"
          />
        </SettingsRow>
        <SettingsRow label="Reduce motion" hint="Minimize non-essential animation." last>
          <AgwSwitch checked={reduceMotion} onChange={setReduceMotion} ariaLabel="Reduce motion" />
        </SettingsRow>
      </SettingsSection>

      {/* Panel open/close motion */}
      <SettingsSection
        title="Panel motion"
        icon="panel-left"
        description="How the left rail and right dock open and close."
      >
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

      {/* Typography */}
      <SettingsSection title="Typography" icon="type" description="Interface and code typefaces.">
        <SettingsRow label="UI font" hint="Used across the window chrome and messages.">
          <input
            className="agw-set-input"
            list="agw-ui-fonts"
            value={tokens.fontUi}
            onChange={(e) => setToken("fontUi", e.target.value)}
            spellCheck={false}
            style={{ width: 280, fontFamily: tokens.fontUi }}
            aria-label="UI font"
          />
          <datalist id="agw-ui-fonts">
            {UI_FONT_SUGGESTIONS.map((f) => (
              <option key={f} value={f} />
            ))}
          </datalist>
        </SettingsRow>
        <SettingsRow label="Code font" hint="Used for code blocks and the terminal." last>
          <input
            className="agw-set-input"
            list="agw-code-fonts"
            value={tokens.fontCode}
            onChange={(e) => setToken("fontCode", e.target.value)}
            spellCheck={false}
            style={{ width: 280, fontFamily: tokens.fontCode }}
            aria-label="Code font"
          />
          <datalist id="agw-code-fonts">
            {CODE_FONT_SUGGESTIONS.map((f) => (
              <option key={f} value={f} />
            ))}
          </datalist>
        </SettingsRow>
      </SettingsSection>

      {/* Per-region color editors */}
      {REGION_GROUPS.map((group) => {
        const isCode = group.title === "Code & chips";
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
              const props = {
                key: field.key,
                field,
                value: tokens[field.key],
                last: i === group.fields.length - 1,
                onChange: (value: string) => setToken(field.key, value),
              };
              return field.editor === "text" ? <TextTokenRow {...props} /> : <ColorRow {...props} />;
            })}
          </SettingsSection>
        );
      })}

      {/* Reset */}
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
    </div>
  );
};
