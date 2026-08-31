/**
 * Agent Window — workspace layout store (feature state).
 *
 * Owns the 3-zone shell layout: the left rail (projects + chats) and the right
 * tabbed dock. Persisted so the agent window reopens in the same arrangement.
 * Independent of `useUiStore` so the agent layout never fights the IDE's panels.
 *
 * The dock is a DYNAMIC, browser-style tab system (Codex parity, §12.7): open
 * surfaces are tab pills (closeable like browser tabs), a `+` menu opens Files /
 * Browser / Terminal, files open as their own pills, and an Expand toggle widens
 * the panel. Only singleton tabs persist — file tabs are session-only (their
 * paths are project-specific).
 */

import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
  DOCK_TAB_LABELS,
  type DockSingletonKind,
  type DockTabInstance,
} from "@/apps/agent/types";

/** Review diff layout — side-by-side (Codex default) vs single-column. */
export type DiffMode = "split" | "unified";

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
  /** Open (or refocus) a team member's live stream in its own tab. */
  openMemberTab: (agentId: string, title: string) => void;
  /** Open (or focus) the details tab for a project folder. */
  openProjectTab: (root: string, title: string) => void;
  /**
   * Open (or refocus) a CONVERSATION in its own dock tab — a second, fully live
   * chat beside the main one, so two models can be watched answering at once
   * instead of switching back and forth between them.
   */
  openChatTab: (threadId: string, title: string, projectRoot: string | null) => void;
  /** Activate an existing tab by id. */
  setActiveTab: (id: string) => void;
  /** Close a tab; activates a neighbor, or closes the dock if it was the last. */
  closeTab: (id: string) => void;
  /**
   * Close the team screen and every member stream at once.
   *
   * Turning Agent Team off in Settings has to take the team OUT of the window,
   * not just out of the model's tools — and the team tab is persisted, so a
   * stale one can also come back on a reload after the feature was disabled.
   */
  closeTeamTabs: () => void;
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
            const tab: DockTabInstance = { id: "files", kind: "files", title: DOCK_TAB_LABELS.files };
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

      openMemberTab: (agentId, title) =>
        set((s) => {
          const id = `member:${agentId}`;
          const exists = s.tabs.some((t) => t.id === id);
          const tabs = exists
            ? s.tabs.map((t) => (t.id === id ? { ...t, title } : t))
            : [...s.tabs, { id, kind: "member" as const, title, memberId: agentId }];
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

      openChatTab: (threadId, title, projectRoot) =>
        set((s) => {
          const id = `chat:${threadId}`;
          const exists = s.tabs.some((t) => t.id === id);
          const tabs = exists
            ? // Re-opening refocuses and re-titles (the chat may have been
              // renamed, or auto-titled since it was docked).
              s.tabs.map((t) => (t.id === id ? { ...t, title } : t))
            : [
                ...s.tabs,
                {
                  id,
                  kind: "chat" as const,
                  title,
                  threadId,
                  threadProjectRoot: projectRoot,
                },
              ];
          return { dockOpen: true, activeTabId: id, tabs };
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

      closeTeamTabs: () =>
        set((s) => {
          const tabs = s.tabs.filter((t) => t.kind !== "team" && t.kind !== "member");
          if (tabs.length === s.tabs.length) return s;
          const activeTabId = tabs.some((t) => t.id === s.activeTabId)
            ? s.activeTabId
            : (tabs[0]?.id ?? null);
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
        // File tabs are project-specific and member tabs die with their run (a
        // re-dispatch mints new agent ids), so neither survives a reload. Chat
        // tabs DO: a thread id is durable, and a side-by-side comparison you set
        // up is worth keeping — the panel handles a since-deleted thread as an
        // honest empty state rather than a broken tab.
        tabs: s.tabs.filter((t) => t.kind !== "file" && t.kind !== "member"),
        activeTabId: s.activeTabId,
      }),
      // After rehydrate, make sure activeTabId still points at a surviving tab.
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<AgentWorkspaceState>;
        const tabs = p.tabs ?? [];
        const activeTabId =
          p.activeTabId && tabs.some((t) => t.id === p.activeTabId)
            ? p.activeTabId
            : (tabs[0]?.id ?? null);
        return { ...current, ...p, tabs, activeTabId, expanded: false };
      },
    },
  ),
);
