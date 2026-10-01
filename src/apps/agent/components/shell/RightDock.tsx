/**
 * Agent Window — right side dock [view].
 *
 * The dock is a browser (probe: Documents/aurora-dock-browser-designs.html, 03):
 *  - Open surfaces are tabs, closeable like browser tabs. Only the active one is
 *    a filled pill; the rest are an icon and a name.
 *  - `+` (and Ctrl+T) opens a New tab page: an address bar, Aurora's panels as
 *    tiles, running local servers and recent sites. It turns into whatever is
 *    picked on it.
 *  - Browser tabs each own a native page. The agent drives one of them, the
 *    `browser` tab; the others are the user's.
 *  - Files open as their own tabs via `openFileTab`; an Expand toggle widens the
 *    panel toward full.
 *
 * Closing the panel only unmounts the view: tabs stay in the store and browser
 * pages stay alive, hidden, so reopening finds everything where it was. A
 * tab's × is what destroys its page.
 *
 * Themed entirely with `--agw-*`.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { AgentIcon, type AgentIconName } from "@/apps/agent/shared/AgentIcon";
import { FileIcon } from "@/kernel/ui/FileIcons";
import { ReviewPanel } from "@/apps/agent/components/files/ReviewPanel";
import { FilesPanel } from "@/apps/agent/components/files/FilesPanel";
import { FileViewer } from "@/apps/agent/components/files/FileViewer";
import { TerminalPanel } from "@/apps/agent/components/panels/TerminalPanel";
import { BrowserPanel, closeBrowserPage } from "@/apps/agent/components/panels/BrowserPanel";
import { NewTabPage } from "@/apps/agent/components/panels/NewTabPage";
import { AGENT_BROWSER_LABEL } from "@/apps/agent/services/browser/browser-visibility";
import { CanvasPanel } from "@/apps/agent/components/canvas/CanvasPanel";
import { ProjectPanel } from "@/apps/agent/components/panels/ProjectPanel";
import { SessionPanel } from "@/apps/agent/components/panels/SessionPanel";
import { TeamPanel } from "@/apps/agent/components/team/TeamPanel";
import { MemoryPanel } from "@/apps/agent/components/panels/MemoryPanel";
import { MemberPanel } from "@/apps/agent/components/team/MemberPanel";
import { ChatPanel } from "@/apps/agent/components/shell/ChatPanel";
import { StreamingDotMatrix } from "@/apps/agent/components/theme/StreamingDotMatrix";
import { useAgentSettingsStore } from "@/apps/agent/store/settings/useAgentSettingsStore";
import { useAgentChatStore } from "@/apps/agent/store/conversation/useAgentChatStore";
import { useAgentBrowserDriving } from "@/apps/agent/store/workspace/useAgentBrowserDriving";
import { authorColor } from "@/apps/agent/components/team/team-ui";
import type { DockSingletonKind, DockTabInstance } from "@/apps/agent/types";
import {
  isTabOnSurface,
  useAgentWorkspaceStore,
} from "@/apps/agent/store/workspace/useAgentWorkspaceStore";
import { formatCommandShortcut } from "@/apps/agent/lib/command/command-shortcut";
import { tabIndexForKey } from "@/apps/agent/lib/workspace/tab-keys";
import { NEW_TAB_SHORTCUT } from "@/apps/agent/hooks/window/useNewTabShortcut";

const SINGLETON_ICON: Record<DockSingletonKind, AgentIconName> = {
  review: "review",
  canvas: "panel-right",
  files: "files",
  browser: "browser",
  terminal: "terminal",
  team: "users",
  memory: "database",
};

/**
 * A chat tab's glyph — the streaming dot matrix while THAT conversation is
 * working, the static chat icon otherwise.
 *
 * The point of docking a chat is watching it without watching it: with two
 * models answering at once, the tab you aren't reading still has to say it's
 * busy. `size={18}` renders a ~13px grid, matching the other tab glyphs.
 */
const ChatTabGlyph: React.FC<{ threadId: string }> = ({ threadId }) => {
  const streaming = useAgentChatStore((s) => !!s.liveTurns[threadId]);
  return streaming ? (
    <StreamingDotMatrix size={18} />
  ) : (
    <AgentIcon name="chat" size={13} />
  );
};

/**
 * The Browser tab's glyph — accent and pulsing while the agent is driving the
 * page, the static browser icon otherwise.
 *
 * Same reasoning as `ChatTabGlyph`: the agent can click, scroll and navigate
 * while the user is reading Files or a diff, and the panel's own cue is
 * unreachable behind another tab. This is the only place that says the page is
 * moving without switching to it.
 */
const BrowserTabGlyph: React.FC = () => {
  const driving = useAgentBrowserDriving((s) => s.driving);
  return (
    <span className="agw-tabpill-browser" data-agw-driving={driving ? "true" : undefined}>
      <AgentIcon name="browser" size={13} />
      {/* Colour and motion are not state cues on their own. */}
      {driving && <span className="agw-sr-only">Agent is working in the browser</span>}
    </span>
  );
};

const TabPill: React.FC<{
  tab: DockTabInstance;
  active: boolean;
  onSelect: () => void;
  onClose: () => void;
  onKeyDown: (event: React.KeyboardEvent<HTMLButtonElement>) => void;
}> = ({ tab, active, onSelect, onClose, onKeyDown }) => {
  const pillRef = useRef<HTMLDivElement>(null);
  const [closing, setClosing] = useState(false);

  /**
   * Close with one motion: the tab fades while its width folds to nothing, so
   * its neighbours slide in instead of jumping a whole tab-width in one frame.
   * The tab is removed from the store only when the fold ends. Reduced motion
   * (or no Web Animations) removes it at once.
   */
  const close = () => {
    if (closing) return;
    const el = pillRef.current;
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (!el || reduced || typeof el.animate !== "function") {
      onClose();
      return;
    }
    setClosing(true);
    const width = el.getBoundingClientRect().width;
    const fold = el.animate(
      [
        { width: `${width}px`, opacity: 1, marginRight: "0px" },
        // Also give back the strip's 3px gap, or the row settles with a hop.
        { width: "0px", opacity: 0, marginRight: "-3px" },
      ],
      { duration: 150, easing: "cubic-bezier(0.2, 0, 0, 1)", fill: "forwards" },
    );
    fold.onfinish = onClose;
    fold.oncancel = onClose;
  };

  return (
    <div
      ref={pillRef}
      className="agw-tabpill"
      data-active={active || undefined}
      data-closing={closing || undefined}
      data-tab-id={tab.id}
    >
      <button
        type="button"
        role="tab"
        aria-selected={active}
        // One Tab stop for the whole strip: the open tab. Arrows move between tabs.
        tabIndex={active ? 0 : -1}
        className="agw-tabpill-main"
        onClick={onSelect}
        onKeyDown={onKeyDown}
        title={tab.title}
      >
        <TabGlyph tab={tab} />
        <span className="agw-tabpill-label">{tab.title}</span>
      </button>
      <button
        type="button"
        className="agw-tabpill-close"
        onClick={(e) => {
          e.stopPropagation();
          close();
        }}
        title={`Close ${tab.title}`}
        aria-label={`Close ${tab.title}`}
      >
        <AgentIcon name="close" size={12} />
      </button>
    </div>
  );
};

/** The icon at the start of a tab. */
const TabGlyph: React.FC<{ tab: DockTabInstance }> = ({ tab }) => {
  switch (tab.kind) {
    case "file":
      return <FileIcon name={tab.title} path={tab.path} className="agw-file-ico" />;
    case "member":
      // A team member's tab carries their identity color as a small dot —
      // the same color as their name chip in the group chat.
      return (
        <span className="agw-tabpill-dot" style={{ background: authorColor(tab.memberId ?? "") }} />
      );
    case "project":
      return <AgentIcon name="folder" size={13} />;
    case "session":
      // Same glyph as "Conversation details" in the rail's context menu, so
      // the entry and the tab it produces are recognisably one thing.
      return <AgentIcon name="sliders" size={13} />;
    case "chat":
      return <ChatTabGlyph threadId={tab.threadId ?? ""} />;
    case "browser":
      // Only the agent's page can be driven, so only its tab can pulse.
      return tab.browserLabel ? <AgentIcon name="browser" size={13} /> : <BrowserTabGlyph />;
    case "newtab":
      return <AgentIcon name="browser" size={13} />;
    case "artifact":
      return <AgentIcon name="panel-right" size={13} />;
    default:
      return <AgentIcon name={SINGLETON_ICON[tab.kind]} size={13} />;
  }
};

/** Which edges of the tab strip have tabs hidden past them. */
type StripOverflow = "none" | "start" | "end" | "both";

/**
 * Make the tab strip reachable once it overflows.
 *
 * The strip hides its scrollbar (a visible one in a 44px header reads as
 * debris), which left a plain mouse with no way to move it and nothing saying
 * more tabs existed — open enough tabs and the ones past the edge became
 * unreachable. Three affordances, one per input method:
 *
 *  - **wheel** → horizontal scroll, so a mouse can drive a one-axis strip with
 *    the gesture it already has;
 *  - **the active tab is always revealed**, so opening or selecting a tab can
 *    never leave it off-screen (this also covers keyboard, since focus reveal
 *    is the browser's own behaviour);
 *  - **an edge fade** on whichever side has more, because a hidden scrollbar
 *    also hides the fact that there is anything to scroll to.
 *
 * Touch needs nothing extra — drag already works.
 */
function useTabStripScroll(activeId: string | null, tabCount: number) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [overflow, setOverflow] = useState<StripOverflow>("none");

  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    // Sub-pixel layout means scrollWidth can exceed clientWidth by a hair with
    // nothing actually clipped; 1px of slack keeps the fade off in that case.
    const max = el.scrollWidth - el.clientWidth;
    if (max <= 1) {
      setOverflow("none");
      return;
    }
    const atStart = el.scrollLeft <= 1;
    const atEnd = el.scrollLeft >= max - 1;
    setOverflow(atStart ? "end" : atEnd ? "start" : "both");
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const onWheel = (event: WheelEvent) => {
      // A horizontal wheel / trackpad swipe already does the right thing.
      if (event.deltaY === 0) return;
      if (el.scrollWidth - el.clientWidth <= 0) return;
      // Only claim the gesture when there is somewhere to go, so the event
      // stays available to anything else when the strip fits.
      event.preventDefault();
      el.scrollLeft += event.deltaY;
      measure();
    };
    // Non-passive: translating the axis requires preventing the default.
    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("scroll", measure, { passive: true });

    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("scroll", measure);
      observer.disconnect();
    };
  }, [measure]);

  // Re-measure when the tab set changes (closing a tab can end the overflow).
  // Deferred one frame on purpose: a pill added in this same commit has not
  // been laid out yet, so measuring synchronously would read the PREVIOUS
  // scrollWidth and miss the overflow that the new tab just caused.
  useEffect(() => {
    const frame = requestAnimationFrame(measure);
    return () => cancelAnimationFrame(frame);
  }, [measure, tabCount, activeId]);

  // Reveal the active tab. `block: "nearest"` keeps this to the one axis the
  // strip scrolls — without it the whole dock can be nudged vertically.
  useEffect(() => {
    const el = ref.current;
    if (!el || !activeId) return;
    const pill = el.querySelector<HTMLElement>("[data-active]");
    if (!pill) return;
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    pill.scrollIntoView({
      block: "nearest",
      inline: "nearest",
      behavior: reduced ? "auto" : "smooth",
    });
  }, [activeId]);

  return { ref, overflow };
}

const TabBody: React.FC<{ tab: DockTabInstance }> = ({ tab }) => {
  switch (tab.kind) {
    case "review":
      return <ReviewPanel />;
    case "canvas":
      return <CanvasPanel />;
    case "artifact":
      // The same panel, pinned to one artifact. Canvas without an id is the
      // index of them all.
      return <CanvasPanel artifactId={tab.artifactId ?? ""} />;
    case "team":
      return <TeamPanel />;
    case "memory":
      return <MemoryPanel />;
    case "member":
      return <MemberPanel agentId={tab.memberId ?? ""} />;
    case "chat":
      return (
        <ChatPanel
          threadId={tab.threadId ?? ""}
          projectRoot={tab.threadProjectRoot ?? null}
          fallbackTitle={tab.title}
        />
      );
    case "files":
      return <FilesPanel />;
    case "file":
      // No back button — the pill's × closes it (it's a tab, not a drill-in).
      return <FileViewer path={tab.path ?? ""} name={tab.title} />;
    case "terminal":
      return <TerminalPanel />;
    case "browser":
      return (
        <BrowserPanel
          tabId={tab.id}
          label={tab.browserLabel ?? AGENT_BROWSER_LABEL}
          initialUrl={tab.url}
          pendingUrl={tab.pendingUrl}
          device={tab.device}
          zoom={tab.zoom}
          toolsOpen={tab.toolsOpen}
        />
      );
    case "newtab":
      return <NewTabPage tabId={tab.id} />;
    case "project":
      return <ProjectPanel root={tab.projectRoot ?? ""} />;
    case "session":
      return <SessionPanel threadId={tab.threadId ?? ""} />;
    default: {
      const _exhaustive: never = tab.kind;
      return _exhaustive;
    }
  }
};

export const RightDock: React.FC = () => {
  /** Aurora Chat's dock holds Canvas and Memory; see `isTabOnSurface`. */
  const chatSurface = useAgentSettingsStore((s) => s.auroraSurface) === "chat";
  const allTabs = useAgentWorkspaceStore((s) => s.tabs);
  const activeTabId = useAgentWorkspaceStore((s) => s.activeTabId);
  /** The tabs THIS surface shows — the rule lives with the store. */
  const tabs: DockTabInstance[] = useMemo(
    () => allTabs.filter((tab) => isTabOnSurface(tab, chatSurface)),
    [allTabs, chatSurface],
  );
  const expanded = useAgentWorkspaceStore((s) => s.expanded);
  const openNewTab = useAgentWorkspaceStore((s) => s.openNewTab);
  const setActiveTab = useAgentWorkspaceStore((s) => s.setActiveTab);
  const closeTab = useAgentWorkspaceStore((s) => s.closeTab);
  const closeDock = useAgentWorkspaceStore((s) => s.closeDock);
  const toggleExpanded = useAgentWorkspaceStore((s) => s.toggleExpanded);

  const active = tabs.find((t) => t.id === activeTabId) ?? tabs[0] ?? null;
  const { ref: stripRef, overflow: stripOverflow } = useTabStripScroll(
    active?.id ?? null,
    tabs.length,
  );

  // No show/hide here: only the active tab's body is mounted, so switching away
  // from a browser tab unmounts its panel and that alone hides its page
  // (`services/browser/browser-visibility.ts`). `+` opens a tab rather than a
  // menu, so nothing ever drops over a live page from this strip.
  const newTabTitle = `New tab (${formatCommandShortcut(NEW_TAB_SHORTCUT)})`;

  /**
   * Arrow keys on a focused tab (`tabIndexForKey`): Left/Right open the
   * previous/next tab, wrapping; Home/End the first/last. Focus follows, so
   * holding an arrow walks the strip; the active tab is scrolled into view by
   * `useTabStripScroll`.
   */
  const onTabKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    const target = tabIndexForKey(event.key, index, tabs.length);
    if (target === null) return;
    event.preventDefault();
    const next = tabs[target];
    setActiveTab(next.id);
    // The new tab's button becomes focusable on the next render.
    requestAnimationFrame(() => {
      stripRef.current
        ?.querySelector<HTMLButtonElement>(
          `[data-tab-id="${CSS.escape(next.id)}"] .agw-tabpill-main`,
        )
        ?.focus();
    });
  };

  // The panel is never open on nothing. Every path that opens it — the header
  // toggle, a rail button, a restored layout, switching to a surface whose tabs
  // are all filtered out — ends here with no tab to show, so this one rule
  // covers them all: open a New tab. Gated on `dockOpen` because the dock
  // stays mounted through its closing glide, and must not grow a tab then.
  // `ensureVisibleTab` re-checks the store when it runs: React runs effects
  // twice in development, and checking the render's copy opened two tabs.
  const dockOpen = useAgentWorkspaceStore((s) => s.dockOpen);
  const ensureVisibleTab = useAgentWorkspaceStore((s) => s.ensureVisibleTab);
  const nothingToShow = tabs.length === 0;
  useEffect(() => {
    if (dockOpen && nothingToShow) ensureVisibleTab(chatSurface);
  }, [dockOpen, nothingToShow, chatSurface, ensureVisibleTab]);

  return (
    <div
      className="agw-zone"
      // Frame tier — continuous with the canvas gutters; the recessed center
      // sheet's own edge does the separating, so no divider line here.
      style={{ background: "var(--agw-dock)" }}
    >
      {/* Tab strip */}
      <div className="agw-tabstrip">
        <div
          ref={stripRef}
          role="tablist"
          aria-label="Panel tabs"
          className="agw-tabstrip-scroll agw-scroll"
          data-overflow={stripOverflow === "none" ? undefined : stripOverflow}
        >
          {tabs.map((tab, index) => (
            <TabPill
              key={tab.id}
              tab={tab}
              active={tab.id === active?.id}
              onSelect={() => setActiveTab(tab.id)}
              onKeyDown={(event) => onTabKeyDown(event, index)}
              onClose={() => {
                // Tear down the tab's native page before dropping the tab.
                if (tab.kind === "browser") {
                  void closeBrowserPage(tab.browserLabel ?? AGENT_BROWSER_LABEL);
                }
                closeTab(tab.id);
                // The last tab THIS surface shows closes the panel, like closing
                // a browser's last tab. The store only knows when the whole list
                // is empty; the other surface's tabs may still be in it.
                if (tabs.length === 1) closeDock();
              }}
            />
          ))}
        </div>
        <button
          type="button"
          className="agw-icon-btn"
          title={newTabTitle}
          aria-label={newTabTitle}
          onClick={openNewTab}
        >
          <AgentIcon name="plus" size={16} />
        </button>
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

      {/* Body. Never a "no tab" message: an open panel with nothing to show
          gets a New tab (effect above), so this is empty for one frame at most. */}
      {active && <TabBody key={active.id} tab={active} />}
    </div>
  );
};
