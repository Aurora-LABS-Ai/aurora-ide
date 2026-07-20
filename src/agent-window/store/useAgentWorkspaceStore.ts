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
} from "../types";

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
        // Only singleton tabs survive a reload — file tabs are project-specific.
        tabs: s.tabs.filter((t) => t.kind !== "file"),
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
