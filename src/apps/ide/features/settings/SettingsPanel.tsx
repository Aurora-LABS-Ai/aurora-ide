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
 * See: src/kernel/types/theme.ts for TypeScript interfaces
 * See: src/apps/ide/services/theme-service.ts for theme utilities
 */

import React, { useState } from 'react';
import { useUiStore } from '@/apps/ide/store/useUiStore';
import { useSettingsStore } from '@/kernel/store/useSettingsStore';
import { getAppVersion, PACKAGE_VERSION } from '@/apps/ide/lib/app-version';
import { X, Layout, Palette, Info } from 'lucide-react';
import clsx from 'clsx';
import { ThemeSettingsTab } from './ThemeSettingsTab';
import { GeneralSettingsTab } from './GeneralSettingsTab';
import { AboutSettingsTab } from './AboutSettingsTab';
import {
  settingsShellStyle,
  settingsRowDividerColor,
} from './settings-shared';

// ============================================
// SETTINGS SHELL CHROME
// ============================================

const sidebarStyle: React.CSSProperties = {
  backgroundColor: 'color-mix(in srgb, var(--aurora-title-bar-background) 60%, var(--aurora-sidebar-background) 40%)',
  borderRight: '1px solid color-mix(in srgb, var(--aurora-common-border) 70%, transparent)',
};

const headerStyle: React.CSSProperties = {
  backgroundColor: 'color-mix(in srgb, var(--aurora-title-bar-background) 50%, var(--aurora-sidebar-background) 50%)',
  borderBottom: '1px solid color-mix(in srgb, var(--aurora-common-border) 70%, transparent)',
};


// ============================================
// MAIN SETTINGS PANEL
// ============================================

/**
 * The editor's own settings. Everything about the agent — providers, models,
 * tools, approvals, MCP, skills, team, voice — now lives in the agent window's
 * settings page, which owns that configuration end to end. Adding an agent
 * setting here again would give the same value two homes.
 */
type SettingsTabKey = 'general' | 'themes' | 'about';

interface SidebarItem {
  id: SettingsTabKey;
  label: string;
  icon: React.ComponentType<React.SVGProps<SVGSVGElement>>;
  group: 'system';
}

type TabMeta = { eyebrow: string; title: string; description: string };

const TAB_TITLES: Record<SettingsTabKey, TabMeta> = {
  themes: {
    eyebrow: 'Appearance',
    title: 'Appearance & Theme',
    description: 'Built-in themes, custom themes, and import/export for VS Code-compatible packs.',
  },
  general: {
    eyebrow: 'System',
    title: 'General Settings',
    description: 'Editor, UI font, OS integrations, and workspace defaults.',
  },
  about: {
    eyebrow: 'System',
    title: 'About Aurora',
    description: 'Version, capabilities overview, and credits.',
  },
};

export const SettingsPanel: React.FC = () => {
  const {
    isSettingsOpen,
    setSettingsOpen,
    settingsInitialTab,
    consumeSettingsInitialTab,
  } = useUiStore();
  const {
    fontSize,
    setFontSize,
    wrapMode,
    setWrapMode,
    autoSave,
    setAutoSave,
    uiFontFamily,
    uiTextScale,
    setUiFontFamily,
    setUiTextScale,
  } = useSettingsStore();

  const [activeTab, setActiveTab] = useState<SettingsTabKey>('general');
  const [appVersion, setAppVersion] = useState(PACKAGE_VERSION);

  React.useEffect(() => {
    if (isSettingsOpen && settingsInitialTab) {
      // Deep-links that named an agent tab ('providers', 'local', 'tools',
      // 'mcp', 'skills', 'speech', 'agent', 'fireworks') no longer resolve
      // here — that configuration moved to the agent window. Land on General
      // rather than rendering a blank pane.
      if (settingsInitialTab in TAB_TITLES) {
        setActiveTab(settingsInitialTab as SettingsTabKey);
      } else {
        setActiveTab('general');
      }
      consumeSettingsInitialTab();
    }
  }, [isSettingsOpen, settingsInitialTab, consumeSettingsInitialTab]);

  // Load app version
  React.useEffect(() => {
    getAppVersion().then(setAppVersion).catch(() => setAppVersion(PACKAGE_VERSION));
  }, []);

  if (!isSettingsOpen) return null;

  const sidebarItems: SidebarItem[] = [
    { id: 'themes', label: 'Appearance', icon: Palette, group: 'system' },
    { id: 'general', label: 'General', icon: Layout, group: 'system' },
    { id: 'about', label: 'About', icon: Info, group: 'system' },
  ];

  const groupedItems: Array<{ label: string; items: SidebarItem[] }> = [
    { label: 'System', items: sidebarItems.filter((i) => i.group === 'system') },
  ];

  const meta = TAB_TITLES[activeTab];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{
        backgroundColor: 'color-mix(in srgb, var(--aurora-common-shadow) 62%, transparent)',
      }}
    >
      <div
        className="flex h-[820px] w-[1240px] overflow-hidden"
        style={{ ...settingsShellStyle, borderRadius: 12 }}
      >
        {/* ============================================ */}
        {/* SIDEBAR                                       */}
        {/* ============================================ */}
        <aside className="flex w-[228px] flex-col" style={sidebarStyle}>
          {/* Sidebar header */}
          <div
            className="px-4 py-3.5"
            style={{
              borderBottom: `1px solid ${settingsRowDividerColor}`,
            }}
          >
            <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-text-disabled">
              Aurora
            </div>
            <div className="mt-0.5 text-[13px] font-semibold text-text-primary">
              Preferences
            </div>
          </div>

          {/* Grouped nav */}
          <nav className="flex-1 overflow-y-auto p-2 scrollbar-thin">
            {groupedItems.map((group, groupIdx) => (
              <div key={group.label} className={clsx(groupIdx > 0 && 'mt-3')}>
                <div className="px-2 pb-1.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-text-disabled">
                  {group.label}
                </div>
                <div className="space-y-0.5">
                  {group.items.map(({ id, label, icon: Icon }) => {
                    const isActive = activeTab === id;
                    return (
                      <button
                        key={id}
                        onClick={() => setActiveTab(id)}
                        className={clsx(
                          'group flex w-full items-center gap-2.5 px-2.5 py-1.5 text-left text-[12px] transition-colors',
                          isActive
                            ? 'font-semibold'
                            : 'font-medium text-text-secondary hover:text-text-primary',
                        )}
                        style={{
                          color: isActive
                            ? 'var(--aurora-common-primary)'
                            : undefined,
                          backgroundColor: isActive
                            ? 'color-mix(in srgb, var(--aurora-common-primary) 14%, transparent)'
                            : 'transparent',
                          borderRadius: 4,
                          borderLeft: isActive
                            ? '2px solid var(--aurora-common-primary)'
                            : '2px solid transparent',
                          paddingLeft: isActive ? 8 : 10,
                        }}
                      >
                        <Icon
                          className="h-3.5 w-3.5 shrink-0"
                          style={{
                            color: isActive
                              ? 'var(--aurora-common-primary)'
                              : 'var(--aurora-text-secondary, var(--aurora-editor-foreground))',
                          }}
                        />
                        <span className="truncate">{label}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </nav>

          {/* Sidebar footer */}
          <div
            className="px-4 py-2.5 text-[10px] text-text-disabled"
            style={{
              borderTop: `1px solid ${settingsRowDividerColor}`,
            }}
          >
            <span className="font-mono">v{appVersion}</span>
          </div>
        </aside>

        {/* ============================================ */}
        {/* CONTENT                                       */}
        {/* ============================================ */}
        <main className="flex min-w-0 flex-1 flex-col">
          {/* Tab header */}
          <header
            className="flex h-14 shrink-0 items-center justify-between gap-4 px-6"
            style={headerStyle}
          >
            <div className="min-w-0">
              <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-text-disabled">
                {meta.eyebrow}
              </div>
              <h2 className="mt-0.5 truncate text-[14px] font-semibold text-text-primary">
                {meta.title}
              </h2>
            </div>
            <button
              onClick={() => setSettingsOpen(false)}
              className="inline-flex h-7 w-7 shrink-0 items-center justify-center text-text-secondary transition-colors hover:text-text-primary"
              style={{
                backgroundColor:
                  'color-mix(in srgb, var(--aurora-common-secondary) 60%, var(--aurora-title-bar-background) 40%)',
                border:
                  '1px solid color-mix(in srgb, var(--aurora-common-border) 60%, transparent)',
                borderRadius: 6,
              }}
              aria-label="Close settings"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </header>

          {/* Tab content */}
          <div
            className="flex-1 overflow-y-auto px-6 py-5 scrollbar-thin"
            style={{
              scrollbarGutter: 'stable',
              backgroundColor:
                'color-mix(in srgb, var(--aurora-editor-background) 60%, var(--aurora-sidebar-background) 40%)',
            }}
          >
            {activeTab === 'themes' && <ThemeSettingsTab />}

            {activeTab === 'general' && (
              <GeneralSettingsTab
                autoSave={autoSave}
                fontSize={fontSize}
                setAutoSave={setAutoSave}
                setFontSize={setFontSize}
                setUiFontFamily={setUiFontFamily}
                setUiTextScale={setUiTextScale}
                setWrapMode={setWrapMode}
                uiFontFamily={uiFontFamily}
                uiTextScale={uiTextScale}
                wrapMode={wrapMode}
              />
            )}

            {activeTab === 'about' && <AboutSettingsTab />}
          </div>
        </main>
      </div>
    </div>
  );
};
