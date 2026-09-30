/**
 * Agent Window — New tab page [view].
 *
 * What `+` opens in the dock. It is a browser New tab and the dock's front door
 * at once: one address bar, then Aurora's panels as tiles, then the local
 * servers the agent started, then recent sites. Picking a panel turns this tab
 * into that panel; entering an address turns it into a browser tab
 * (`resolveNewTab`). Typing filters all three lists.
 *
 * Aurora Chat has no project, so its New tab offers only its own panels —
 * Canvas, Memory and Gallery — and no browser.
 *
 * This page is plain DOM with no native webview behind it, so nothing here
 * needs to hold a browser page hidden.
 */

import React, { useEffect, useMemo, useRef, useState } from "react";

import { AgentIcon, type AgentIconName } from "@/apps/agent/shared/AgentIcon";
import { auroraInvoke, isAuroraRuntimeAvailable } from "@/kernel/lib/ipc/runtime";
import { useAgentSettingsStore } from "@/apps/agent/store/settings/useAgentSettingsStore";
import { useAgentWorkspaceStore } from "@/apps/agent/store/workspace/useAgentWorkspaceStore";
import { useAgentBrowserHistory } from "@/apps/agent/store/workspace/useAgentBrowserHistory";
import { addressTitle, normalizeAddress } from "@/apps/agent/lib/browser/browser-tabs";
import { fmtDuration } from "@/apps/agent/lib/time/duration";
import { CHAT_DOCK_TABS, DOCK_TAB_LABELS, type DockSingletonKind } from "@/apps/agent/types";

/** One row of `browser_local_servers`. */
interface LocalServer {
  processId: string;
  name?: string | null;
  command: string;
  url: string;
  answering: boolean;
  startedAtMs: number;
}

const PANEL_ICON: Record<DockSingletonKind, AgentIconName> = {
  review: "review",
  canvas: "panel-right",
  files: "files",
  browser: "browser",
  terminal: "terminal",
  team: "users",
  memory: "database",
  gallery: "image",
};

/** Build's panels, in the order they are reached for. Team only when it is on. */
const BUILD_PANELS: readonly DockSingletonKind[] = ["files", "terminal", "canvas", "review"];

/** How often "Running" is re-read. A dev server starts in seconds. */
const SERVERS_POLL_MS = 5_000;
const MAX_RECENT = 6;

/**
 * Live servers the agent started, re-read while this page is showing, with the
 * moment they were read — uptimes are measured from that, not from render.
 */
function useLocalServers(enabled: boolean): { servers: LocalServer[]; readAt: number } {
  const [state, setState] = useState<{ servers: LocalServer[]; readAt: number }>({
    servers: [],
    readAt: 0,
  });
  useEffect(() => {
    if (!enabled || !isAuroraRuntimeAvailable()) return;
    let cancelled = false;
    const read = async () => {
      try {
        const rows = await auroraInvoke<LocalServer[]>("browser_local_servers");
        if (!cancelled && Array.isArray(rows)) setState({ servers: rows, readAt: Date.now() });
      } catch (err) {
        // The list stays as last read; an empty list would claim nothing runs.
        console.warn("[agent-window] could not list local servers:", err);
      }
    };
    void read();
    const timer = window.setInterval(() => void read(), SERVERS_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [enabled]);
  return state;
}

export const NewTabPage: React.FC<{ tabId: string }> = ({ tabId }) => {
  const chatSurface = useAgentSettingsStore((s) => s.auroraSurface) === "chat";
  const teamEnabled = useAgentSettingsStore((s) => s.teamEnabled);
  const resolveNewTab = useAgentWorkspaceStore((s) => s.resolveNewTab);
  const recent = useAgentBrowserHistory((s) => s.recent);
  const { servers, readAt } = useLocalServers(!chatSurface);
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  // Ready to type when opened with `+` or Ctrl+T — but not when the user is
  // walking the tab strip with the arrow keys and merely passing through,
  // which would pull focus out of the strip and end the walk.
  useEffect(() => {
    if (document.activeElement?.getAttribute("role") === "tab") return;
    inputRef.current?.focus();
  }, []);

  const panels = useMemo<DockSingletonKind[]>(() => {
    if (chatSurface) return [...CHAT_DOCK_TABS];
    return teamEnabled ? [...BUILD_PANELS, "team"] : [...BUILD_PANELS];
  }, [chatSurface, teamEnabled]);

  const q = query.trim().toLowerCase();
  const shownPanels = panels.filter((kind) => !q || DOCK_TAB_LABELS[kind].toLowerCase().includes(q));
  const shownServers = servers.filter(
    (s) => !q || s.url.toLowerCase().includes(q) || s.command.toLowerCase().includes(q),
  );
  const shownRecent = recent.filter((u) => !q || u.toLowerCase().includes(q)).slice(0, MAX_RECENT);

  const openPanel = (panel: DockSingletonKind) => resolveNewTab(tabId, { panel });
  const openAddress = (url: string) => resolveNewTab(tabId, { url });

  // Enter: a panel named exactly is opened; anything else is an address or a
  // search. "files" opens Files, "files.com" goes to the site.
  const submit = () => {
    if (!q) return;
    const exact = panels.find((kind) => DOCK_TAB_LABELS[kind].toLowerCase() === q);
    if (exact) openPanel(exact);
    else if (!chatSurface) openAddress(normalizeAddress(query));
  };

  return (
    <div className="agw-ntp agw-scroll">
      <div className="agw-ntp-address">
        <AgentIcon name={chatSurface ? "search" : "browser"} size={14} style={{ color: "var(--agw-text-subtle)" }} />
        <input
          ref={inputRef}
          className="agw-ntp-input"
          placeholder={chatSurface ? "Open a panel" : "Search, enter a URL, or open a panel"}
          aria-label={chatSurface ? "Open a panel" : "Search, enter a URL, or open a panel"}
          value={query}
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="off"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
        />
      </div>

      {shownPanels.length > 0 && (
        <section className="agw-ntp-section" aria-label="Open in panel">
          <div className="agw-ntp-head">Open in panel</div>
          <div className="agw-ntp-tiles">
            {shownPanels.map((kind) => (
              <button key={kind} type="button" className="agw-ntp-tile" onClick={() => openPanel(kind)}>
                <span className="agw-ntp-glyph">
                  <AgentIcon name={PANEL_ICON[kind]} size={18} />
                </span>
                <span className="agw-ntp-tile-label">{DOCK_TAB_LABELS[kind]}</span>
              </button>
            ))}
          </div>
        </section>
      )}

      {!chatSurface && shownServers.length > 0 && (
        <section className="agw-ntp-section" aria-label="Running">
          <div className="agw-ntp-head">
            Running
            <span className="agw-ntp-head-aside">started by the agent</span>
          </div>
          <div className="agw-ntp-rows">
            {shownServers.map((server) => {
              const runFor = fmtDuration((readAt - server.startedAtMs) / 1000);
              const what = server.name?.trim() || server.command;
              return (
                <button
                  key={`${server.processId}-${server.url}`}
                  type="button"
                  className="agw-ntp-row"
                  onClick={() => openAddress(server.url)}
                  title={server.answering ? server.url : `${server.url} is not answering`}
                >
                  <span
                    className="agw-ntp-live"
                    data-answering={server.answering ? "true" : undefined}
                    aria-hidden="true"
                  />
                  <span className="agw-ntp-url">{addressTitle(server.url)}</span>
                  <span className="agw-ntp-meta">
                    {what} · {server.answering ? runFor : "not answering"}
                  </span>
                </button>
              );
            })}
          </div>
        </section>
      )}

      {!chatSurface && shownRecent.length > 0 && (
        <section className="agw-ntp-section" aria-label="Recent">
          <div className="agw-ntp-head">Recent</div>
          <div className="agw-ntp-rows">
            {shownRecent.map((url) => (
              <button key={url} type="button" className="agw-ntp-row" onClick={() => openAddress(url)} title={url}>
                <AgentIcon name="browser" size={14} style={{ color: "var(--agw-text-subtle)", flexShrink: 0 }} />
                <span className="agw-ntp-title">{addressTitle(url)}</span>
                <span className="agw-ntp-meta agw-ntp-meta-url">{url}</span>
              </button>
            ))}
          </div>
        </section>
      )}

      {q && shownPanels.length === 0 && shownServers.length === 0 && shownRecent.length === 0 && (
        <p className="agw-ntp-hint">
          {chatSurface ? (
            <>No panel is called “{query.trim()}”.</>
          ) : (
            <>
              Press Enter to open <span className="agw-ntp-hint-url">{normalizeAddress(query)}</span>
            </>
          )}
        </p>
      )}
    </div>
  );
};
