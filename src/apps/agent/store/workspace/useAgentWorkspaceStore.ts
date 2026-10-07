/**
 * Agent Window — workspace layout store (feature state).
 *
 * Owns the 3-zone shell layout: the left rail (projects + chats) and the right
 * tabbed dock. Persisted so the agent window reopens in the same arrangement.
 * Independent of `useUiStore` so the agent layout never fights the IDE's panels.
 *
 * The dock is a browser: open surfaces are tabs (closeable like browser tabs),
 * `+` opens a New tab page that loads an address or turns into one of Aurora's
 * panels, browser tabs each own a native page, files open as their own tabs,
 * and an Expand toggle widens the panel. File tabs are session-only;
 * everything else persists.
 */

import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
  CHAT_DOCK_TABS,
  DOCK_TAB_LABELS,
  type DockSingletonKind,
  type DockTabInstance,
} from "@/apps/agent/types";
import { addressTitle, userBrowserLabel } from "@/apps/agent/lib/browser/browser-tabs";

/**
 * Tab kinds an older build saved that this one no longer has. Dropped when the
 * saved layout is read back, so a retired surface never comes back as a tab
 * with nothing to render.
 */
const RETIRED_TAB_KINDS: ReadonlySet<string> = new Set(["gallery", "team", "member"]);

/** Review diff layout — side-by-side (Codex default) vs single-column. */
export type DiffMode = "split" | "unified";

/**
 * Does `tab` belong in the strip of the surface being shown?
 *
 * Tabs are persisted, so a Files or Terminal tab opened while working on a
 * project stayed in the strip after switching to Aurora Chat — a surface with
 * no files and no terminal. Filtered rather than closed: going back to Build
 * should find the dock exactly as it was left, not emptied by a visit next
 * door. A New tab adapts to whichever surface shows it.
 */
export function isTabOnSurface(tab: DockTabInstance, chatSurface: boolean): boolean {
  if (tab.kind === "newtab") return true;
  if (chatSurface) {
    return (
      CHAT_DOCK_TABS.includes(tab.kind as (typeof CHAT_DOCK_TABS)[number]) ||
      tab.kind === "artifact" ||
      (tab.kind === "chat" && tab.threadSurface === "chat")
    );
  }
  return tab.kind !== "chat" || tab.threadSurface === "build";
}

/** A fresh New tab page — ids are unique so several can be open at once. */
function newTab(): DockTabInstance {
  const id = `newtab:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  return { id, kind: "newtab", title: "New tab" };
}

function basename(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i >= 0 ? p.slice(i + 1) : p;
}

interface AgentWorkspaceState {
  /** Left rail visibility + size (percentage of the shell width). */
  railOpen: boolean;
  railWidth: number;
  /** Right dock visibility + size (percentage), and whether it's expanded wide. */
  dockOpen: boolean;
  dockWidth: number;
  expanded: boolean;
  /** Open tabs + the active one. */
  tabs: DockTabInstance[];
  activeTabId: string | null;
  /** Review panel diff layout. */
  diffMode: DiffMode;

  toggleRail: () => void;
  setRailOpen: (open: boolean) => void;
  setRailWidth: (width: number) => void;

  closeDock: () => void;
  toggleDock: () => void;
  setDockWidth: (width: number) => void;
  toggleExpanded: () => void;
  setExpanded: (expanded: boolean) => void;
  setDiffMode: (mode: DiffMode) => void;

  /** Open (or refocus) a singleton surface and reveal the dock. */
  openTab: (kind: DockSingletonKind) => void;
  /** Open (or refocus) a file in its own tab. */
  openFileTab: (path: string, title?: string) => void;
  /** Open (or focus) the details tab for a project folder. */
  openProjectTab: (root: string, title: string) => void;
  /** Open the details tab for one conversation (turn timeline, tool outcomes,
   *  tokens). Opened from a chat row's context menu in the rail. */
  openSessionTab: (threadId: string, title: string) => void;
  /**
   * Open (or refocus) one saved artifact in its own tab.
   *
   * Canvas is the INDEX of what a conversation made; this is one thing off that
   * index. Keyed by artifact id alone rather than by conversation: an artifact
   * id is already unique within the conversation that owns it, and the tab
   * follows the open conversation the way every other dock surface does.
   */
  openArtifactTab: (artifactId: string, title: string) => void;
  /**
   * Open (or refocus) a CONVERSATION in its own dock tab — a second, fully live
   * chat beside the main one, so two models can be watched answering at once
   * instead of switching back and forth between them.
   */
  openChatTab: (
    threadId: string,
    title: string,
    projectRoot: string | null,
    surface: "chat" | "build",
  ) => void;
  /** Open a New tab page (what `+` and Ctrl+T do) and show it. */
  openNewTab: () => void;
  /**
   * Open a New tab only if the surface being shown has no tab at all. Checks
   * the store at the moment it runs, so calling it twice opens one tab.
   */
  ensureVisibleTab: (chatSurface: boolean) => void;
  /**
   * Turn New tab `id` into what was picked on it, in place.
   *
   * - a panel: the tab becomes that panel. When the panel is already open
   *   elsewhere in the strip, the New tab closes and that tab is focused
   *   instead — panels are one-per-dock.
   * - an address: the tab becomes a browser tab. The first browser tab is the
   *   AGENT's (id `browser`), so the page you open is the page the agent can
   *   see, as it always was; with that tab already open, the New tab gets a
   *   page of its own.
   */
  resolveNewTab: (id: string, target: { panel: DockSingletonKind } | { url: string }) => void;
  /** Record what a browser tab's page is showing now, or how it is being viewed. */
  updateBrowserTab: (
    id: string,
    patch: Partial<Pick<DockTabInstance, "url" | "title" | "pendingUrl" | "device" | "zoom" | "toolsOpen">>,
  ) => void;
  /** Activate an existing tab by id. */
  setActiveTab: (id: string) => void;
  /** Close a tab; activates a neighbor, or closes the dock if it was the last. */
  closeTab: (id: string) => void;
}

export const useAgentWorkspaceStore = create<AgentWorkspaceState>()(
  persist(
    (set) => ({
      railOpen: true,
      railWidth: 18,
      dockOpen: false,
      dockWidth: 36,
      expanded: false,
      tabs: [],
      activeTabId: null,
      diffMode: "split",

      toggleRail: () => set((s) => ({ railOpen: !s.railOpen })),
      setRailOpen: (open) => set({ railOpen: open }),
      setRailWidth: (width) => set({ railWidth: width }),

      closeDock: () => set({ dockOpen: false, expanded: false }),
      toggleDock: () =>
        set((s) => {
          if (s.dockOpen) return { dockOpen: false, expanded: false };
          if (s.tabs.length === 0) {
            // An empty dock opens on a New tab — the page that offers every
            // panel and the browser — never on a "No tab open" message. The New
            // tab adapts to the surface, so this is right on Build and on
            // Aurora Chat alike.
            const tab = newTab();
            return { dockOpen: true, tabs: [tab], activeTabId: tab.id };
          }
          return { dockOpen: true, activeTabId: s.activeTabId ?? s.tabs[0].id };
        }),
      setDockWidth: (width) => set({ dockWidth: width }),
      toggleExpanded: () => set((s) => ({ expanded: !s.expanded })),
      setExpanded: (expanded) => set({ expanded }),
      setDiffMode: (mode) => set({ diffMode: mode }),

      openTab: (kind) =>
        set((s) => {
          const id = kind;
          const exists = s.tabs.some((t) => t.id === id);
          const tabs = exists
            ? s.tabs
            : [...s.tabs, { id, kind, title: DOCK_TAB_LABELS[kind] }];
          return { dockOpen: true, activeTabId: id, tabs };
        }),

      openFileTab: (path, title) =>
        set((s) => {
          const id = `file:${path}`;
          const exists = s.tabs.some((t) => t.id === id);
          const tabs = exists
            ? s.tabs
            : [...s.tabs, { id, kind: "file" as const, title: title ?? basename(path), path }];
          return { dockOpen: true, activeTabId: id, tabs };
        }),

      openProjectTab: (root, title) =>
        set((s) => {
          const id = `project:${root}`;
          const exists = s.tabs.some((t) => t.id === id);
          const tabs = exists
            ? s.tabs.map((t) => (t.id === id ? { ...t, title } : t))
            : [...s.tabs, { id, kind: "project" as const, title, projectRoot: root }];
          return { dockOpen: true, activeTabId: id, tabs };
        }),

      // One conversation's numbers. Keyed by thread id so re-opening the same
      // conversation's details refocuses that tab instead of stacking a second
      // copy — the same rule every other per-thing tab follows.
      openSessionTab: (threadId, title) =>
        set((s) => {
          const id = `session:${threadId}`;
          const exists = s.tabs.some((t) => t.id === id);
          const tabs = exists
            ? s.tabs.map((t) => (t.id === id ? { ...t, title } : t))
            : [...s.tabs, { id, kind: "session" as const, title, threadId }];
          return { dockOpen: true, activeTabId: id, tabs };
        }),

      openArtifactTab: (artifactId, title) =>
        set((s) => {
          const id = `artifact:${artifactId}`;
          const exists = s.tabs.some((t) => t.id === id);
          const tabs = exists
            ? // Re-titled on reopen: an artifact keeps its id across versions
              // and the model renames one as the work changes shape.
              s.tabs.map((t) => (t.id === id ? { ...t, title } : t))
            : [...s.tabs, { id, kind: "artifact" as const, title, artifactId }];
          return { dockOpen: true, activeTabId: id, tabs };
        }),

      openChatTab: (threadId, title, projectRoot, surface) =>
        set((s) => {
          const id = `chat:${threadId}`;
          const exists = s.tabs.some((t) => t.id === id);
          const tabs = exists
            ? // Re-opening refocuses and re-titles (the chat may have been
              // renamed, or auto-titled since it was docked).
              s.tabs.map((t) =>
                t.id === id
                  ? { ...t, title, threadProjectRoot: projectRoot, threadSurface: surface }
                  : t,
              )
            : [
                ...s.tabs,
                {
                  id,
                  kind: "chat" as const,
                  title,
                  threadId,
                  threadProjectRoot: projectRoot,
                  threadSurface: surface,
                },
              ];
          return { dockOpen: true, activeTabId: id, tabs };
        }),

      openNewTab: () =>
        set((s) => {
          const tab = newTab();
          return { dockOpen: true, activeTabId: tab.id, tabs: [...s.tabs, tab] };
        }),

      ensureVisibleTab: (chatSurface) =>
        set((s) => {
          if (s.tabs.some((t) => isTabOnSurface(t, chatSurface))) return s;
          const tab = newTab();
          return { activeTabId: tab.id, tabs: [...s.tabs, tab] };
        }),

      resolveNewTab: (id, target) =>
        set((s) => {
          const idx = s.tabs.findIndex((t) => t.id === id && t.kind === "newtab");
          if (idx < 0) return s;
          const replaceWith = (tab: DockTabInstance) => {
            const tabs = [...s.tabs];
            tabs[idx] = tab;
            return { tabs, activeTabId: tab.id, dockOpen: true };
          };

          if ("panel" in target) {
            const kind = target.panel;
            if (s.tabs.some((t) => t.id === kind)) {
              return { tabs: s.tabs.filter((t) => t.id !== id), activeTabId: kind, dockOpen: true };
            }
            return replaceWith({ id: kind, kind, title: DOCK_TAB_LABELS[kind] });
          }

          const url = target.url;
          const title = addressTitle(url);
          if (!s.tabs.some((t) => t.id === "browser")) {
            return replaceWith({ id: "browser", kind: "browser", title, url, pendingUrl: url });
          }
          const browserLabel = userBrowserLabel();
          return replaceWith({
            id: `browser:${browserLabel}`,
            kind: "browser",
            title,
            browserLabel,
            url,
            pendingUrl: url,
          });
        }),

      updateBrowserTab: (id, patch) =>
        set((s) => {
          const tab = s.tabs.find((t) => t.id === id);
          if (!tab) return s;
          const next: DockTabInstance = { ...tab, ...patch };
          // An `undefined` in the patch REMOVES that field — "no device", "no
          // pending load" — so the saved tab carries no stale key.
          for (const key of Object.keys(patch) as (keyof typeof patch)[]) {
            if (patch[key] === undefined) delete next[key];
          }
          const changed = (Object.keys(patch) as (keyof typeof patch)[]).some(
            (key) => next[key] !== tab[key] || (key in tab) !== (key in next),
          );
          if (!changed) return s;
          return { tabs: s.tabs.map((t) => (t.id === id ? next : t)) };
        }),

      setActiveTab: (id) => set({ activeTabId: id, dockOpen: true }),

      closeTab: (id) =>
        set((s) => {
          const idx = s.tabs.findIndex((t) => t.id === id);
          if (idx < 0) return s;
          const tabs = s.tabs.filter((t) => t.id !== id);
          let activeTabId = s.activeTabId;
          if (s.activeTabId === id) {
            const neighbor = tabs[idx] ?? tabs[idx - 1] ?? null;
            activeTabId = neighbor?.id ?? null;
          }
          const dockOpen = tabs.length > 0 && s.dockOpen;
          return { tabs, activeTabId, dockOpen, expanded: dockOpen ? s.expanded : false };
        }),
    }),
    {
      name: "aurora-agent-window-workspace",
      partialize: (s) => ({
        railOpen: s.railOpen,
        railWidth: s.railWidth,
        dockWidth: s.dockWidth,
        diffMode: s.diffMode,
        // File tabs are project-specific, so they do not survive a reload. Chat
        // tabs DO: a thread id is durable, and a side-by-side comparison you set
        // up is worth keeping — the panel handles a since-deleted thread as an
        // honest empty state rather than a broken tab.
        tabs: s.tabs.filter((t) => t.kind !== "file"),
        activeTabId: s.activeTabId,
      }),
      // After rehydrate, make sure activeTabId still points at a surviving tab.
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<AgentWorkspaceState>;
        // Older chat tabs have no surface owner. Their thread ids cannot be
        // safely inferred from a nullable project root, so require a reopen.
        const tabs = (p.tabs ?? []).filter(
          (tab) =>
            // Retired kinds an older build may have saved, with nothing left to
            // render: the gallery (the Library page took it over) and the
            // removed Agent Team's tabs.
            !RETIRED_TAB_KINDS.has(tab.kind as string) &&
            (tab.kind !== "chat" ||
              tab.threadSurface === "chat" ||
              tab.threadSurface === "build"),
        );
        const activeTabId =
          p.activeTabId && tabs.some((t) => t.id === p.activeTabId)
            ? p.activeTabId
            : (tabs[0]?.id ?? null);
        return { ...current, ...p, tabs, activeTabId, expanded: false };
      },
    },
  ),
);
