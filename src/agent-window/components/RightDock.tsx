/**
 * Agent Window — right side dock [view].
 *
 * A dynamic, browser-style tab system (Codex parity, CODEX-UI-REFERENCE §12.7):
 *  - Open surfaces are tab PILLS, closeable like browser tabs.
 *  - A `+` button opens a menu: Files / Browser / Terminal.
 *  - Files open as their own pills (titled by filename) via `openFileTab`.
 *  - An Expand toggle widens the panel toward full.
 *
 * Bodies: Review (diff), Files (tree + filter), per-file read-only viewer.
 * Browser / Terminal are structurally present in the `+` menu but disabled until
 * their surfaces are wired — no fake "coming soon" content is ever rendered.
 * Themed entirely with `--agw-*`.
 */

import React, { useEffect, useRef, useState } from "react";

import { AgentIcon, type AgentIconName } from "../shared/AgentIcon";
import { FileIcon } from "../../components/explorer/FileIcons";
import { ReviewPanel } from "./ReviewPanel";
import { FilesPanel } from "./FilesPanel";
import { FileViewer } from "./FileViewer";
import { TerminalPanel } from "./TerminalPanel";
import { BrowserPanel, closeAgentBrowser, hideAgentBrowser, showAgentBrowser } from "./BrowserPanel";
import type { DockSingletonKind, DockTabInstance } from "../types";
import { DOCK_TAB_LABELS } from "../types";
import { useAgentWorkspaceStore } from "../store/useAgentWorkspaceStore";

const SINGLETON_ICON: Record<DockSingletonKind, AgentIconName> = {
  review: "review",
  files: "files",
  browser: "browser",
  terminal: "terminal",
};

/** Entries in the `+` menu. `enabled:false` = structurally present, not wired. */
const ADD_MENU: Array<{ kind: DockSingletonKind; shortcut?: string; enabled: boolean }> = [
  { kind: "files", shortcut: "Ctrl+P", enabled: true },
  { kind: "browser", shortcut: "Ctrl+T", enabled: true },
  { kind: "terminal", enabled: true },
];

const TabPill: React.FC<{
  tab: DockTabInstance;
  active: boolean;
  onSelect: () => void;
  onClose: () => void;
}> = ({ tab, active, onSelect, onClose }) => (
  <div className="agw-tabpill" data-active={active || undefined}>
    <button type="button" className="agw-tabpill-main" onClick={onSelect} title={tab.title}>
      {tab.kind === "file" ? (
        <FileIcon name={tab.title} path={tab.path} className="agw-file-ico" />
      ) : (
        <AgentIcon name={SINGLETON_ICON[tab.kind]} size={13} />
      )}
      <span className="agw-tabpill-label">{tab.title}</span>
    </button>
    <button
      type="button"
      className="agw-tabpill-close"
      onClick={(e) => {
        e.stopPropagation();
        onClose();
      }}
      title={`Close ${tab.title}`}
      aria-label={`Close ${tab.title}`}
    >
      <AgentIcon name="close" size={12} />
    </button>
  </div>
);

const AddMenu: React.FC<{
  onPick: (kind: DockSingletonKind) => void;
  onOpenChange?: (open: boolean) => void;
}> = ({ onPick, onOpenChange }) => {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Single setter so visibility changes always notify the parent (which hides
  // the native browser webview so this menu isn't painted behind it).
  const change = (v: boolean) => {
    setOpen(v);
    onOpenChange?.(v);
  };

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) change(false);
    };
    const onEsc = (e: KeyboardEvent) => e.key === "Escape" && change(false);
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onEsc);
    };
  }, [open]);

  return (
    <div ref={ref} style={{ position: "relative", flexShrink: 0 }}>
      <button
        type="button"
        className="agw-icon-btn"
        title="Open side panel tab"
        aria-label="Open side panel tab"
        aria-expanded={open}
        onClick={() => change(!open)}
      >
        <AgentIcon name="plus" size={16} />
      </button>
      {open && (
        <div className="agw-addmenu" role="menu">
          {ADD_MENU.map((entry) => (
            <button
              key={entry.kind}
              type="button"
              role="menuitem"
              className="agw-addmenu-item"
              disabled={!entry.enabled}
              title={entry.enabled ? undefined : "Not available yet"}
              onClick={() => {
                if (!entry.enabled) return;
                onPick(entry.kind);
                change(false);
              }}
            >
              <AgentIcon name={SINGLETON_ICON[entry.kind]} size={14} />
              <span className="agw-addmenu-label">{DOCK_TAB_LABELS[entry.kind]}</span>
              {entry.shortcut && <span className="agw-addmenu-kbd">{entry.shortcut}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

const TabBody: React.FC<{ tab: DockTabInstance }> = ({ tab }) => {
  switch (tab.kind) {
    case "review":
      return <ReviewPanel />;
    case "files":
      return <FilesPanel />;
    case "file":
      // No back button — the pill's × closes it (it's a tab, not a drill-in).
      return <FileViewer path={tab.path ?? ""} name={tab.title} />;
    case "terminal":
      return <TerminalPanel />;
    case "browser":
      return <BrowserPanel />;
    default: {
      const _exhaustive: never = tab.kind;
      return _exhaustive;
    }
  }
};

export const RightDock: React.FC = () => {
  const tabs = useAgentWorkspaceStore((s) => s.tabs);
  const activeTabId = useAgentWorkspaceStore((s) => s.activeTabId);
  const expanded = useAgentWorkspaceStore((s) => s.expanded);
  const openTab = useAgentWorkspaceStore((s) => s.openTab);
  const setActiveTab = useAgentWorkspaceStore((s) => s.setActiveTab);
  const closeTab = useAgentWorkspaceStore((s) => s.closeTab);
  const closeDock = useAgentWorkspaceStore((s) => s.closeDock);
  const toggleExpanded = useAgentWorkspaceStore((s) => s.toggleExpanded);

  const active = tabs.find((t) => t.id === activeTabId) ?? tabs[0] ?? null;

  // Switching to a different tab is instant (no glide), so hide the native
  // webview immediately — it paints above DOM and would otherwise cover the new
  // tab. Dock CLOSE is handled differently: the webview slides out with the rail
  // (BrowserPanel tracks the animating outer) and is hidden on unmount, so we do
  // NOT hide on `!dockOpen` here — that would kill the slide-out.
  useEffect(() => {
    if (active?.kind !== "browser") void hideAgentBrowser();
  }, [active?.kind]);

  return (
    <div
      className="agw-zone"
      style={{ background: "var(--agw-dock)", borderLeft: "1px solid var(--agw-border)" }}
    >
      {/* Tab strip */}
      <div className="agw-tabstrip">
        <div className="agw-tabstrip-scroll agw-scroll">
          {tabs.map((tab) => (
            <TabPill
              key={tab.id}
              tab={tab}
              active={tab.id === active?.id}
              onSelect={() => setActiveTab(tab.id)}
              onClose={() => {
                // Tear down the native child webview before dropping the tab.
                if (tab.kind === "browser") void closeAgentBrowser();
                closeTab(tab.id);
              }}
            />
          ))}
        </div>
        <AddMenu
          onPick={openTab}
          onOpenChange={(menuOpen) => {
            // The native browser webview paints above DOM — hide it so this
            // menu (which drops into the body) isn't clipped behind the page.
            if (menuOpen) {
              void hideAgentBrowser();
              return;
            }
            // Re-show only if the browser is STILL the live active tab (reading
            // the store, not a stale closure — picking another tab must not
            // resurrect the webview over it).
            const st = useAgentWorkspaceStore.getState();
            const live = st.tabs.find((t) => t.id === st.activeTabId);
            if (live?.kind === "browser") void showAgentBrowser();
          }}
        />
        <button
          type="button"
          className="agw-icon-btn"
          title={expanded ? "Restore panel width" : "Expand panel"}
          aria-label={expanded ? "Restore panel width" : "Expand panel"}
          aria-pressed={expanded}
          onClick={toggleExpanded}
          style={expanded ? { color: "var(--agw-accent)" } : undefined}
        >
          <AgentIcon name="chevrons-left" size={16} />
        </button>
        <button
          type="button"
          className="agw-icon-btn"
          title="Close panel"
          aria-label="Close panel"
          onClick={closeDock}
        >
          <AgentIcon name="close" size={16} />
        </button>
      </div>

      {/* Body */}
      {active ? (
        <TabBody key={active.id} tab={active} />
      ) : (
        <div className="agw-files-empty">
          <AgentIcon name="files" size={22} style={{ color: "var(--agw-text-subtle)" }} />
          <div style={{ fontSize: 13, color: "var(--agw-text-muted)", fontWeight: 600 }}>No tab open</div>
          <div style={{ fontSize: 12, color: "var(--agw-text-subtle)", maxWidth: 220 }}>
            Use <span style={{ fontWeight: 600 }}>＋</span> to open Files, or review changes from a message.
          </div>
        </div>
      )}
    </div>
  );
};
