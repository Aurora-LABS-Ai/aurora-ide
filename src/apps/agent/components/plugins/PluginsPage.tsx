/**
 * Agent Window — Plugins [view].
 *
 * What the agent can be extended with, in one place: MCP servers (external
 * tools and resources over the Model Context Protocol) and Skills (playbooks
 * loaded into context, enabled per workspace). Opened from the icon rail.
 *
 * Two panes in the settings chrome (`.agw-settings*`), because the Skills
 * pane IS the settings component and the MCP pane reuses its cards, and the
 * cards sit at the density they were drawn for. The sidebar carries the two
 * panes and, under them, every installed server with its status dot, so a
 * server is one click away from anywhere on the page. Settings no longer
 * lists MCP or Skills; every old door redirects here (`sectionPluginsTab`).
 */

import React, { useEffect, useRef, useState } from "react";

import { AgentIcon, type AgentIconName } from "@/apps/agent/shared/AgentIcon";
import { SkillsSettings } from "@/apps/agent/settings/SkillsSettings";
import { statusDotTone } from "@/apps/agent/settings/mcp-status";
import { McpPane } from "./McpPane";
import { inspectServers, issueByServer } from "@/apps/agent/lib/plugins/inspect";
import { useMcpStore } from "@/apps/agent/store/tools/useMcpStore";
import { useAgentUiStore, type PluginsTab } from "@/apps/agent/store/ui/useAgentUiStore";

interface PaneSpec {
  id: PluginsTab;
  label: string;
  icon: AgentIconName;
}

/** Same glyphs as the settings catalog used, so old habits still land. */
const PANES: readonly PaneSpec[] = [
  { id: "mcp", label: "MCP servers", icon: "plug" },
  { id: "skills", label: "Skills", icon: "book" },
];

export const PluginsPage: React.FC = () => {
  const tab = useAgentUiStore((s) => s.pluginsTab);
  const setTab = useAgentUiStore((s) => s.setPluginsTab);
  const servers = useMcpStore((s) => s.servers);
  const loadServers = useMcpStore((s) => s.loadServers);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const didLoad = useRef(false);

  useEffect(() => {
    if (didLoad.current) return;
    didLoad.current = true;
    void loadServers();
  }, [loadServers]);

  const issueFor = issueByServer(inspectServers(servers));
  const current = PANES.find((pane) => pane.id === tab) ?? PANES[0];

  return (
    <div className="agw-settings agw-plugins">
      <aside className="agw-settings-nav">
        <div className="agw-settings-nav-head">
          <div className="agw-settings-nav-eyebrow">Aurora Agent</div>
          <div className="agw-settings-nav-title">Plugins</div>
        </div>
        <nav className="agw-settings-nav-scroll agw-scroll" aria-label="Plugins">
          <div className="agw-settings-nav-group">
            {PANES.map((pane) => (
              <button
                key={pane.id}
                type="button"
                className="agw-settings-nav-item"
                data-active={pane.id === current.id || undefined}
                aria-current={pane.id === current.id ? "page" : undefined}
                onClick={() => setTab(pane.id)}
              >
                <AgentIcon name={pane.icon} size={15} />
                <span style={{ flex: 1, minWidth: 0 }}>{pane.label}</span>
                {pane.id === "mcp" && servers.length > 0 && (
                  <span className="agw-plug-nav-count">{servers.length}</span>
                )}
              </button>
            ))}
          </div>
          {servers.length > 0 && (
            <div className="agw-settings-nav-group">
              <div className="agw-settings-nav-group-label">Installed</div>
              {servers.map((server) => {
                const issue = issueFor.get(server.config.id);
                return (
                  <button
                    key={server.config.id}
                    type="button"
                    className="agw-plug-side"
                    data-active={(tab === "mcp" && server.config.id === selectedId) || undefined}
                    title={issue ? `${server.config.name} · ${issue.message}` : server.config.name}
                    onClick={() => {
                      setTab("mcp");
                      setSelectedId(server.config.id);
                    }}
                  >
                    <span
                      className="agw-mcp-card-dot"
                      data-tone={issue ? "warn" : statusDotTone(server.status)}
                    />
                    <span className="agw-plug-side-name">{server.config.name}</span>
                  </button>
                );
              })}
            </div>
          )}
        </nav>
      </aside>

      <div className="agw-settings-main">
        {current.id === "mcp" ? (
          <div className="agw-settings-content" data-full-bleed>
            <McpPane selectedId={selectedId} onSelect={setSelectedId} />
          </div>
        ) : (
          <>
            <header className="agw-settings-header">
              <div className="agw-settings-head-titles">
                <div className="agw-settings-head-eyebrow">Plugins</div>
                <div className="agw-settings-head-title">Skills</div>
              </div>
            </header>
            <div className="agw-settings-content agw-scroll">
              <SkillsSettings />
            </div>
          </>
        )}
      </div>
    </div>
  );
};
