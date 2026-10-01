/**
 * Agent Window — Plugins › MCP servers [view].
 *
 * Two screens. The **overview**: Installed as compact tiles (mark, name, one
 * line of state, tool count) with the page's own reading of the config on top
 * — duplicates, generated names, failed starts — counted as "Needs attention";
 * then the **Add** directory of well-known public servers, where + opens the
 * add form with the command already written. A **server's own page** opens
 * from a tile or the sidebar: a breadcrumb back to Plugins, then the full
 * server card (the same `ServerCard` the settings list used), with the
 * connection, tools, environment and the edit form.
 *
 * Nothing here talks to the MCP backend directly: the tiles, the card and the
 * add form all read and write `useMcpStore`, exactly as settings did.
 */

import React, { useEffect, useMemo, useRef, useState } from "react";

import { AgentIcon } from "@/apps/agent/shared/AgentIcon";
import { AgwButton, AgwPill } from "@/apps/agent/settings/primitives";
import { AddServerCard, ServerCard, type AddServerSeed } from "@/apps/agent/settings/McpSettings";
import { statusDotTone } from "@/apps/agent/settings/mcp-status";
import {
  DIRECTORY_CATEGORY_LABEL,
  isInstalled,
  searchDirectory,
  seedNote,
  templateConfig,
  type DirectoryCategory,
  type DirectoryEntry,
} from "@/apps/agent/lib/plugins/directory";
import {
  inspectServers,
  issueByServer,
  markOf,
  tileLine,
  type ServerIssue,
} from "@/apps/agent/lib/plugins/inspect";
import { useMcpStore, type McpServerState } from "@/apps/agent/store/tools/useMcpStore";

const CATEGORIES: readonly DirectoryCategory[] = ["popular", "developer", "data", "work"];

const ServerTile: React.FC<{
  server: McpServerState;
  issue?: ServerIssue;
  onOpen: () => void;
}> = ({ server, issue, onOpen }) => (
  <button
    type="button"
    className="agw-plug-tile"
    onClick={onOpen}
    title={`Open ${server.config.name}`}
  >
    <span className="agw-plug-mark">
      {markOf(server.config.name)}
      <span
        className="agw-mcp-card-dot"
        data-tone={issue ? "warn" : statusDotTone(server.status)}
      />
    </span>
    <span className="agw-plug-tile-text">
      <span className="agw-plug-tile-name">{server.config.name}</span>
      <span className="agw-plug-tile-line" data-issue={issue?.kind}>
        {tileLine(server, issue)}
      </span>
    </span>
  </button>
);

const DirectoryRow: React.FC<{
  entry: DirectoryEntry;
  installed: boolean;
  onAdd: () => void;
}> = ({ entry, installed, onAdd }) => (
  <div className="agw-plug-row">
    <span className="agw-plug-mark agw-plug-mark-dir">{entry.mark}</span>
    <span className="agw-plug-tile-text">
      <span className="agw-plug-tile-name">{entry.name}</span>
      <span className="agw-plug-tile-line">{entry.blurb}</span>
    </span>
    {installed ? (
      <AgwPill tone="neutral" dot={false}>
        Installed
      </AgwPill>
    ) : (
      <button
        type="button"
        className="agw-plug-plus"
        aria-label={`Add ${entry.name}`}
        title={`Add ${entry.name}`}
        onClick={onAdd}
      >
        <AgentIcon name="plus" size={15} />
      </button>
    )}
  </div>
);

/** One server's own page: breadcrumb, the problem if there is one, the card. */
const ServerPage: React.FC<{
  server: McpServerState;
  issue?: ServerIssue;
  onBack: () => void;
}> = ({ server, issue, onBack }) => (
  <div className="agw-plug-scroll agw-scroll">
    <div className="agw-plug-col">
      <nav className="agw-plug-crumbs" aria-label="Breadcrumb">
        <button type="button" className="agw-plug-crumb" onClick={onBack}>
          Plugins
        </button>
        <AgentIcon name="chevron-right" size={12} />
        <span className="agw-plug-crumb-here" aria-current="page">
          {server.config.name}
        </span>
      </nav>
      {issue && (
        <div className="agw-set-notice" data-tone="warning" style={{ marginBottom: 12 }}>
          <span>{issue.message}</span>
        </div>
      )}
      <ServerCard server={server} open onToggle={onBack} />
    </div>
  </div>
);

export const McpPane: React.FC<{
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}> = ({ selectedId, onSelect }) => {
  const servers = useMcpStore((s) => s.servers);
  const isLoading = useMcpStore((s) => s.isLoading);
  const refreshServers = useMcpStore((s) => s.refreshServers);

  const [query, setQuery] = useState("");
  const [attentionOnly, setAttentionOnly] = useState(false);
  const [adding, setAdding] = useState<{ key: number; seed?: AddServerSeed } | null>(null);
  // Each opened add form gets a new key so a second + remounts it with the new
  // template instead of patching a half-edited draft.
  const addCount = useRef(0);

  const issues = useMemo(() => inspectServers(servers), [servers]);
  const issueFor = useMemo(() => issueByServer(issues), [issues]);
  const attentionCount = issueFor.size;

  const q = query.trim().toLowerCase();
  const shown = servers.filter(
    (server) =>
      (!q || server.config.name.toLowerCase().includes(q)) &&
      (!attentionOnly || issueFor.has(server.config.id)),
  );
  const directory = useMemo(() => searchDirectory(query), [query]);
  const configs = useMemo(() => servers.map((server) => server.config), [servers]);
  const selected = servers.find((server) => server.config.id === selectedId) ?? null;
  const connected = servers.filter((server) => server.status === "connected").length;

  // A page opened from the sidebar starts at its top, not wherever the
  // overview had been scrolled to.
  useEffect(() => {
    if (!selectedId) return;
    document.querySelector(".agw-plug-scroll")?.scrollTo({ top: 0 });
  }, [selectedId]);

  const openAdd = (seed?: AddServerSeed) => {
    addCount.current += 1;
    setAdding({ key: addCount.current, seed });
    onSelect(null);
    // The card mounts at the top of the scroller; make sure it is in view.
    window.requestAnimationFrame(() =>
      document.getElementById("agw-plug-add")?.scrollIntoView({ block: "start" }),
    );
  };

  const addFromDirectory = (entry: DirectoryEntry) =>
    openAdd({ config: templateConfig(entry), note: seedNote(entry) });

  if (selected) {
    return (
      <div className="agw-plug">
        <ServerPage
          server={selected}
          issue={issueFor.get(selected.config.id)}
          onBack={() => onSelect(null)}
        />
      </div>
    );
  }

  return (
    <div className="agw-plug">
      <header className="agw-plug-head">
        <div className="agw-plug-col agw-plug-head-row">
          <div className="agw-plug-titles">
            <h2 className="agw-plug-title">MCP servers</h2>
            <p className="agw-plug-sub">
              Connect servers so the agent can work across your tools
            </p>
          </div>
          <label className="agw-plug-search">
            <AgentIcon name="search" size={13} />
            <input
              type="search"
              aria-label="Search servers"
              placeholder="Search servers"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <AgwButton icon="retry" onClick={() => void refreshServers()} disabled={isLoading}>
            Refresh
          </AgwButton>
          <AgwButton variant="primary" icon="plus" onClick={() => openAdd()} disabled={!!adding}>
            Add
          </AgwButton>
        </div>
      </header>

      <div className="agw-plug-scroll agw-scroll">
        <div className="agw-plug-col">
          {adding && (
            <div id="agw-plug-add" className="agw-plug-add">
              <AddServerCard
                key={adding.key}
                seed={adding.seed}
                onCancel={() => setAdding(null)}
                onAdded={(firstName) => {
                  setAdding(null);
                  const match = useMcpStore
                    .getState()
                    .servers.find((server) => server.config.name === firstName);
                  onSelect(match?.config.id ?? null);
                }}
              />
            </div>
          )}

          <section aria-labelledby="agw-plug-installed">
            <div className="agw-plug-sec">
              <h3 id="agw-plug-installed">Installed</h3>
              <span className="agw-plug-n">
                {servers.length} {servers.length === 1 ? "server" : "servers"} · {connected}{" "}
                connected
              </span>
              {attentionCount > 0 && (
                <button
                  type="button"
                  className="agw-plug-attn"
                  aria-pressed={attentionOnly}
                  onClick={() => setAttentionOnly((v) => !v)}
                  title={
                    attentionOnly ? "Show every server" : "Show only servers with a problem"
                  }
                >
                  Needs attention {attentionCount}
                </button>
              )}
            </div>

            {servers.length === 0 && !isLoading ? (
              <p className="agw-plug-empty">
                No servers yet. Pick one below, or press Add to write your own.
              </p>
            ) : shown.length === 0 ? (
              <p className="agw-plug-empty" role="status">
                {attentionOnly ? "Nothing needs attention." : "No installed server matches."}
              </p>
            ) : (
              <div className="agw-plug-tiles">
                {shown.map((server) => (
                  <ServerTile
                    key={server.config.id}
                    server={server}
                    issue={issueFor.get(server.config.id)}
                    onOpen={() => onSelect(server.config.id)}
                  />
                ))}
              </div>
            )}
          </section>

          <section aria-labelledby="agw-plug-directory">
            <div className="agw-plug-sec">
              <h3 id="agw-plug-directory">Add</h3>
              <span className="agw-plug-n">well-known servers, one click to configure</span>
            </div>
            {directory.length === 0 ? (
              <p className="agw-plug-empty" role="status">
                Nothing in the directory matches. Press Add to write your own.
              </p>
            ) : (
              CATEGORIES.map((category) => {
                const entries = directory.filter((entry) => entry.category === category);
                if (entries.length === 0) return null;
                return (
                  <div key={category} className="agw-plug-cat">
                    <div className="agw-plug-cat-label">
                      {DIRECTORY_CATEGORY_LABEL[category]}
                    </div>
                    <div className="agw-plug-dir">
                      {entries.map((entry) => (
                        <DirectoryRow
                          key={entry.id}
                          entry={entry}
                          installed={isInstalled(entry, configs)}
                          onAdd={() => addFromDirectory(entry)}
                        />
                      ))}
                    </div>
                  </div>
                );
              })
            )}
          </section>
        </div>
      </div>
    </div>
  );
};
