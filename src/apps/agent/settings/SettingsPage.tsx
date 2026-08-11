/**
 * Agent Window — Settings page (full-surface view).
 *
 * Codex-style: a grouped left nav + a content pane, replacing the conversation
 * workspace (no modal). Opened from the conversation header's 3-dot; "Back to
 * app" returns to the chat. Themed entirely with `--agw-*`.
 *
 * SECTION_REGISTRY is the single source of truth for what appears in the nav —
 * a section shows up only once it's actually built, so there are never empty or
 * "coming soon" tabs. It pairs each entry of `settings-catalog.ts` (the names
 * and searchable contents, shared with the command center) with the component
 * that draws it; a section unregistered here cannot be reached, whatever the
 * catalog says.
 */

import React, { useEffect, useMemo, useRef } from "react";

import { AgentIcon } from "../shared/AgentIcon";
import { useAgentUiStore, type SettingsSection } from "@/apps/agent/store/ui/useAgentUiStore";
import { ProfileSettings } from "./ProfileSettings";
import { ProvidersSettings } from "./ProvidersSettings";
import { ToolsSettings } from "./ToolsSettings";
import { AgentSettings } from "./AgentSettings";
import { TeamSettings } from "./TeamSettings";
import { McpSettings } from "./McpSettings";
import { SkillsSettings } from "./SkillsSettings";
import { AppearanceSettings } from "./AppearanceSettings";
import { PreferencesSettings } from "./PreferencesSettings";
import { DiagnosticsSettings } from "./DiagnosticsSettings";
import { SETTINGS_CATALOG, type SettingsCatalogEntry } from "./settings-catalog";
import {
  SettingsQueryContext,
  filterSettingsSearch,
  normalizeQuery,
} from "./settings-search";

type SectionDef = SettingsCatalogEntry & { render: () => React.ReactNode };

/** The component behind each catalog entry. A missing id simply never renders. */
const SECTION_VIEWS: Partial<Record<SettingsSection, () => React.ReactNode>> = {
  profile: () => <ProfileSettings />,
  providers: () => <ProvidersSettings />,
  tools: () => <ToolsSettings />,
  execution: () => <AgentSettings />,
  team: () => <TeamSettings />,
  mcp: () => <McpSettings />,
  skills: () => <SkillsSettings />,
  preferences: () => <PreferencesSettings />,
  appearance: () => <AppearanceSettings />,
  diagnostics: () => <DiagnosticsSettings />,
};

const SECTION_REGISTRY: SectionDef[] = SETTINGS_CATALOG.flatMap((entry) => {
  const render = SECTION_VIEWS[entry.id];
  return render ? [{ ...entry, render }] : [];
});

export const SettingsPage: React.FC = () => {
  const active = useAgentUiStore((s) => s.settingsSection);
  const setSection = useAgentUiStore((s) => s.setSection);
  const closeSettings = useAgentUiStore((s) => s.closeSettings);
  // The query lives in the store so the command center can hand one over on the
  // way in; see `settingsQuery` there.
  const filter = useAgentUiStore((s) => s.settingsQuery);
  const setFilter = useAgentUiStore((s) => s.setSettingsQuery);
  const searchRef = useRef<HTMLInputElement>(null);

  // Fall back to the first registered section if the stored one isn't built yet.
  const current =
    SECTION_REGISTRY.find((s) => s.id === active) ?? SECTION_REGISTRY[0];

  // The nav is NOT filtered. It is how you navigate, and a sidebar that
  // rearranges itself while you type removes the map exactly when you are lost.
  // Searching changes the CONTENT area instead — see the results view below.
  const groups = useMemo(() => {
    const byGroup = new Map<string, SectionDef[]>();
    for (const s of SECTION_REGISTRY) {
      const arr = byGroup.get(s.group) ?? [];
      arr.push(s);
      byGroup.set(s.group, arr);
    }
    return Array.from(byGroup, ([label, items]) => ({ label, items }));
  }, []);

  const query = useMemo(() => normalizeQuery(filter), [filter]);
  const searching = query.length > 0;
  const results = useMemo(
    () => (searching ? filterSettingsSearch(SECTION_REGISTRY, query) : []),
    [searching, query],
  );

  // A search that appears while this box is NOT focused came from somewhere
  // else — the command center handing one over — and the person was already
  // typing. Take the caret so refining is one keystroke rather than a hunt for
  // the box. When they are typing here the box is focused by definition, so the
  // guard makes this a no-op and never fights the caret.
  useEffect(() => {
    const input = searchRef.current;
    if (!searching || !input || document.activeElement === input) return;
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }, [searching]);

  return (
    <div className="agw-settings">
      {/* Left nav */}
      <aside className="agw-settings-nav">
        <div className="agw-settings-nav-head">
          <div className="agw-settings-nav-eyebrow">Aurora Agent</div>
          <div className="agw-settings-nav-title">Settings</div>
        </div>
        <nav className="agw-settings-nav-scroll agw-scroll">
          {groups.map((group) => (
            <div key={group.label} className="agw-settings-nav-group">
              <div className="agw-settings-nav-group-label">{group.label}</div>
              {group.items.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  className="agw-settings-nav-item"
                  data-active={s.id === current.id || undefined}
                  onClick={() => setSection(s.id)}
                >
                  <AgentIcon name={s.icon} size={15} />
                  <span style={{ flex: 1, minWidth: 0 }}>{s.navLabel}</span>
                </button>
              ))}
            </div>
          ))}
        </nav>
      </aside>

      {/* Main */}
      <div className="agw-settings-main">
        <header className="agw-settings-header">
          <button
            type="button"
            className="agw-settings-back"
            onClick={closeSettings}
            title="Back to app"
          >
            <AgentIcon name="arrow-left" size={14} />
            Back to app
          </button>
          <div className="agw-settings-head-titles">
            <div className="agw-settings-head-eyebrow">
              {searching ? "Search" : current.eyebrow}
            </div>
            <div className="agw-settings-head-title">
              {searching ? `Results for “${filter.trim()}”` : current.title}
            </div>
          </div>
          <div style={{ flex: 1 }} />
          <div className="agw-br-address agw-settings-search" style={{ width: 190, height: 30 }}>
            <AgentIcon name="search" size={13} style={{ color: "var(--agw-text-subtle)" }} />
            <input
              ref={searchRef}
              className="agw-br-input"
              aria-label="Search settings"
              placeholder="Search settings"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") setFilter("");
              }}
              spellCheck={false}
            />
          </div>
        </header>

        {/* One provider around BOTH branches. With no query it carries `""`,
            which every primitive treats as "not searching" — so the normal page
            is byte-for-byte what it was before this feature existed. */}
        <SettingsQueryContext.Provider value={searching ? query : ""}>
          <div
            className="agw-settings-content agw-scroll"
            data-full-bleed={(!searching && current.fullBleed) || undefined}
          >
            {!searching ? (
              current.render()
            ) : results.length === 0 ? (
              <div className="agw-settings-noresults" role="status">
                <div className="agw-settings-noresults-title">
                  Nothing matches “{filter.trim()}”
                </div>
                <p className="agw-settings-noresults-hint">
                  Try what the setting does rather than its name — “approval”,
                  “font”, “shortcut”, “model”.
                </p>
              </div>
            ) : (
              results.map((s) => (
                <div
                  key={s.id}
                  className="agw-settings-result"
                  // Only an inline result can end up empty (every one of its
                  // sections filtered itself away). The CSS below drops the
                  // heading in that case, so a page never announces matches it
                  // is not showing.
                  data-inline={s.inlineResults || undefined}
                >
                  <button
                    type="button"
                    className="agw-settings-result-head"
                    onClick={() => setSection(s.id)}
                    title={`Open ${s.title}`}
                  >
                    <AgentIcon name={s.icon} size={13} />
                    <span className="agw-settings-result-name">{s.navLabel}</span>
                    <span className="agw-timeline-rule" aria-hidden="true" />
                    <span className="agw-settings-result-open">Open</span>
                  </button>
                  {s.inlineResults ? (
                    s.render()
                  ) : (
                    // No shared primitives on this page, so its controls cannot
                    // be narrowed to the ones that matched. Offering the
                    // destination is more honest than pasting the whole page
                    // under a heading that promises a specific answer.
                    <p className="agw-settings-result-desc">{s.description}</p>
                  )}
                </div>
              ))
            )}
          </div>
        </SettingsQueryContext.Provider>
      </div>
    </div>
  );
};
