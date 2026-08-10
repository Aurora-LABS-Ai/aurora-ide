/**
 * Agent Window — Settings page (full-surface view).
 *
 * Codex-style: a grouped left nav + a content pane, replacing the conversation
 * workspace (no modal). Opened from the conversation header's 3-dot; "Back to
 * app" returns to the chat. Themed entirely with `--agw-*`.
 *
 * SECTION_REGISTRY is the single source of truth for what appears in the nav —
 * a section shows up only once it's actually built, so there are never empty or
 * "coming soon" tabs. New sections are added by registering them here.
 */

import React, { useMemo, useState } from "react";

import { AgentIcon, type AgentIconName } from "../shared/AgentIcon";
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

interface SectionDef {
  id: SettingsSection;
  navLabel: string;
  icon: AgentIconName;
  group: string;
  eyebrow: string;
  title: string;
  description: string;
  /**
   * Full-bleed sections own the whole content area (no padding, no page
   * scroll) so they can run their own sidebar + pane layout edge-to-edge —
   * e.g. Providers' list sidebar. Default sections keep the padded,
   * scrolling content column.
   */
  fullBleed?: boolean;
  render: () => React.ReactNode;
}

const SECTION_REGISTRY: SectionDef[] = [
  {
    id: "profile",
    navLabel: "Profile",
    icon: "users",
    group: "Personal",
    eyebrow: "Personal",
    title: "Profile",
    description: "Your local usage stats — tokens, streaks, longest task, most-used tools.",
    render: () => <ProfileSettings />,
  },
  {
    id: "providers",
    navLabel: "Providers",
    icon: "providers",
    group: "Models",
    eyebrow: "Models",
    title: "Providers & Models",
    description: "Connect providers and configure models with models.dev auto-fill.",
    fullBleed: true,
    render: () => <ProvidersSettings />,
  },
  {
    id: "tools",
    navLabel: "Tools",
    icon: "shield",
    group: "Agent",
    eyebrow: "Agent",
    title: "Tools & Approvals",
    description: "What the agent may run on its own, and what needs your sign-off.",
    render: () => <ToolsSettings />,
  },
  {
    id: "execution",
    navLabel: "Agent",
    icon: "sliders",
    group: "Agent",
    eyebrow: "Agent",
    title: "Agent",
    description: "Global instructions, execution mode, context compaction, and chat titling — how the agent behaves everywhere.",
    render: () => <AgentSettings />,
  },
  {
    id: "team",
    navLabel: "Team",
    icon: "users",
    group: "Agent",
    eyebrow: "Agent",
    title: "Agent Team",
    description: "A team of agents that plans, splits your project by scope, and builds in parallel — coordinated by a lead you chat with.",
    render: () => <TeamSettings />,
  },
  {
    id: "mcp",
    navLabel: "MCP",
    icon: "plug",
    group: "Agent",
    eyebrow: "Agent",
    title: "MCP Servers",
    description: "Connect Model Context Protocol servers for external tools and resources.",
    render: () => <McpSettings />,
  },
  {
    id: "skills",
    navLabel: "Skills",
    icon: "book",
    group: "Agent",
    eyebrow: "Agent",
    title: "Skills",
    description: "Reusable coding playbooks the agent loads into context — enable per workspace.",
    render: () => <SkillsSettings />,
  },
  {
    id: "preferences",
    navLabel: "Preferences",
    icon: "sliders",
    group: "Window",
    eyebrow: "Window",
    title: "Preferences",
    description: "Personal window preferences — status cues, notifications, and other how-it-feels-for-me toggles.",
    render: () => <PreferencesSettings />,
  },
  {
    id: "appearance",
    navLabel: "Appearance",
    icon: "palette",
    group: "Window",
    eyebrow: "Window",
    title: "Appearance",
    description: "Theme the agent window — colors, fonts, contrast, and per-region controls.",
    render: () => <AppearanceSettings />,
  },
];

export const SettingsPage: React.FC = () => {
  const active = useAgentUiStore((s) => s.settingsSection);
  const setSection = useAgentUiStore((s) => s.setSection);
  const closeSettings = useAgentUiStore((s) => s.closeSettings);
  const [filter, setFilter] = useState("");

  // Fall back to the first registered section if the stored one isn't built yet.
  const current =
    SECTION_REGISTRY.find((s) => s.id === active) ?? SECTION_REGISTRY[0];

  const groups = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const matched = q
      ? SECTION_REGISTRY.filter(
          (s) =>
            s.navLabel.toLowerCase().includes(q) ||
            s.title.toLowerCase().includes(q) ||
            s.description.toLowerCase().includes(q),
        )
      : SECTION_REGISTRY;
    const byGroup = new Map<string, SectionDef[]>();
    for (const s of matched) {
      const arr = byGroup.get(s.group) ?? [];
      arr.push(s);
      byGroup.set(s.group, arr);
    }
    return Array.from(byGroup, ([label, items]) => ({ label, items }));
  }, [filter]);

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
          {groups.length === 0 && (
            <div style={{ padding: "10px 12px", fontSize: "var(--agw-fs-label)", color: "var(--agw-text-subtle)" }}>
              No settings match “{filter}”.
            </div>
          )}
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
            <div className="agw-settings-head-eyebrow">{current.eyebrow}</div>
            <div className="agw-settings-head-title">{current.title}</div>
          </div>
          <div style={{ flex: 1 }} />
          <div className="agw-br-address" style={{ width: 190, height: 30 }}>
            <AgentIcon name="search" size={13} style={{ color: "var(--agw-text-subtle)" }} />
            <input
              className="agw-br-input"
              placeholder="Search settings"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              spellCheck={false}
            />
          </div>
        </header>

        <div
          className="agw-settings-content agw-scroll"
          data-full-bleed={current.fullBleed || undefined}
        >
          {current.render()}
        </div>
      </div>
    </div>
  );
};
