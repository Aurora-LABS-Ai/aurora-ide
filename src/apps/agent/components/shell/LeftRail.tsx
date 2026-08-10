/**
 * Agent Window — Left rail (projects + chats) [view].
 *
 * Codex-style sidebar tree, multi-project:
 *   - "Projects" is a collapsible section (click the header to hide/show every
 *     project at once).
 *   - Each project row is itself collapsible. Clicking a project title ONLY
 *     expands/collapses its chats — it never re-scopes the window. Hovering a
 *     project reveals a pencil that starts a NEW chat in that project.
 *   - Clicking a chat opens it (and binds the window to that chat's project).
 *   - A global "Pinned" section floats pinned chats (from any project) on top.
 *   - The top `+` opens a folder picker to ADD a project.
 *   - Projects can be re-ordered (recent activity / name / oldest).
 *
 * Chats for every project come from the store's `allThreads` (one unscoped
 * fetch), so expanding a non-active project needs no extra round-trip.
 * Reads `--agw-*` tokens exclusively.
 */

import React, { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";

import { writeClipboardText } from "@/kernel/lib/clipboard";
import { openFileDialog, openInTerminal, revealInExplorer } from "@/kernel/lib/ipc/tauri";
import { deriveThreadTitle } from "@/apps/agent/lib/thread/thread-title";
import { AgentIcon } from "@/apps/agent/shared/AgentIcon";
import { AgentConfirm } from "@/apps/agent/components/modals/AgentConfirm";
import { RailMenu, type RailMenuItem, type RailMenuState } from "@/apps/agent/components/shell/RailMenu";
import { useAgentChatStore } from "@/apps/agent/store/conversation/useAgentChatStore";
import { useAgentTerminalStore } from "@/apps/agent/store/ui/useAgentTerminalStore";
import { useAgentWorkspaceStore } from "@/apps/agent/store/workspace/useAgentWorkspaceStore";
import { useTeamHistoryStore } from "@/apps/agent/store/team/useTeamHistoryStore";
import { useTeamStore } from "@/apps/agent/store/team/useTeamStore";
import { PHASE_LABEL, isActivePhase, teamProgress } from "@/apps/agent/components/team/team-ui";
import {
  threadService,
  type DbThread,
  type ThreadSummary,
} from "@/apps/agent/services/threads/thread-service";
import {
  folderName,
  loadPinnedProjects,
  loadProjectSort,
  orderProjects,
  projectActivity,
  PINNED_PROJECTS_KEY,
  SORT_KEY,
  SORT_LABEL,
  SORT_ORDER,
  type ProjectSort,
} from "@/apps/agent/lib/workspace/project-order";

// Project identity, ordering and its two localStorage preferences live in
// `lib/project-order` so the home screen's switcher lists projects in exactly
// this order — two lists of the same thing disagreeing in front of the user is
// the bug that sharing them prevents.
const SHOW_ALL_PROJECTS_KEY = "agw-rail-projects-show-all";

/** Codex-style: collapse a long project list to this many rows, with a
 *  "Show more" affordance to reveal the rest. */
const PROJECTS_PREVIEW_LIMIT = 8;


/**
 * Human "last worked" label + a staleness flag for a project row. Relative time
 * ("2d ago") answers "is this alive?" faster than an absolute date; `stale`
 * (untouched ≥ 30 days) lets the row visually recede.
 */
function describeAge(iso: string | undefined): { label: string | null; stale: boolean } {
  if (!iso) return { label: null, stale: false };
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return { label: null, stale: false };
  const diff = Date.now() - ms;
  const day = Math.floor(diff / 86_400_000);
  let label: string;
  if (diff < 60_000) label = "just now";
  else if (diff < 3_600_000) label = `${Math.floor(diff / 60_000)}m ago`;
  else if (diff < 86_400_000) label = `${Math.floor(diff / 3_600_000)}h ago`;
  else if (day < 30) label = `${day}d ago`;
  else if (day < 365) label = `${Math.floor(day / 30)}mo ago`;
  else label = `${Math.floor(day / 365)}y ago`;
  return { label, stale: day >= 30 };
}

/** Full, human date for the row tooltip — e.g. "Jul 8, 2026". Empty when unknown. */
function fullDate(iso: string | undefined): string {
  if (!iso) return "";
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return "";
  try {
    return new Date(ms).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  } catch {
    return "";
  }
}

/** Retention window for archived chats — must match the Rust `ARCHIVE_RETENTION_DAYS`. */
const ARCHIVE_RETENTION_DAYS = 15;

/** Whole days until an archived chat is auto-purged (clamped to ≥ 0). */
function archiveDaysLeft(archivedAt: string): number {
  const ms = Date.parse(archivedAt);
  if (Number.isNaN(ms)) return ARCHIVE_RETENTION_DAYS;
  const elapsedDays = Math.floor((Date.now() - ms) / 86_400_000);
  return Math.max(0, ARCHIVE_RETENTION_DAYS - elapsedDays);
}

/**
 * A compact fingerprint of the live-turn data the sidebar actually renders:
 * which chats are running, their project, title, and first user message. None
 * of these change while a turn streams assistant tokens — so subscribing to
 * THIS string (instead of the whole `liveTurns` object) means the sidebar only
 * re-renders when a chat starts, ends, or changes, NOT on every word the agent
 * types. That's what keeps the live stream smooth while turns run.
 */
function liveTurnsSignature(state: {
  liveTurns: Record<string, DbThread>;
  liveProjects: Record<string, string | null>;
}): string {
  return Object.keys(state.liveTurns)
    .sort()
    .map((id) => {
      const t = state.liveTurns[id];
      const firstUser = t.messages.find((m) => m.role === "user");
      return `${id}${state.liveProjects[id] ?? ""}${t.title}${(
        firstUser?.content ?? ""
      ).slice(0, 60)}`;
    })
    .join("");
}

/**
 * Smooth height/opacity glide for a collapsible rail section. Mounts/unmounts
 * its children (so collapsed content stays out of the layout) but animates the
 * transition instead of snapping. `initial={false}` means an already-open
 * section (e.g. when a search forces everything open) doesn't replay on mount.
 */
const Collapse: React.FC<{ open: boolean; children: React.ReactNode }> = ({
  open,
  children,
}) => (
  <AnimatePresence initial={false}>
    {open && (
      <motion.div
        initial={{ height: 0, opacity: 0 }}
        animate={{ height: "auto", opacity: 1 }}
        exit={{ height: 0, opacity: 0 }}
        transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
        style={{ overflow: "hidden" }}
      >
        {children}
      </motion.div>
    )}
  </AnimatePresence>
);

interface RailActionNotice {
  message: string;
  tone: "success" | "error";
}

export const LeftRail: React.FC = () => {
  const toggleRail = useAgentWorkspaceStore((s) => s.toggleRail);
  const openChatTab = useAgentWorkspaceStore((s) => s.openChatTab);

  // The Team lives in the right dock now ("Team" tab beside Canvas/Files).
  // Active when the dock is open on that tab.
  const teamTabActive = useAgentWorkspaceStore(
    (s) => s.dockOpen && s.tabs.find((t) => t.id === s.activeTabId)?.kind === "team",
  );

  // Live team run for the current project (kept warm in AgentWindow). Drives the
  // Team entry's tag; `null`/inactive → no tag.
  const teamSnapshot = useTeamStore((s) => s.snapshot);

  // Cross-project "has team work" index: which chats (and projects) have ever
  // dispatched a team run, read from each project's brain. Drives the passive
  // team badge on rail rows. Rebuilt when the project set or the live team phase
  // changes (a phase transition means a run just stamped a new origin chat).
  const teamThreadIds = useTeamHistoryStore((s) => s.threadIds);
  const teamProjectSet = useTeamHistoryStore((s) => s.projects);
  const refreshTeamHistory = useTeamHistoryStore((s) => s.refresh);

  const teamTag =
    teamSnapshot?.initialized && isActivePhase(teamSnapshot.team.phase)
      ? (() => {
          const { done, total } = teamProgress(teamSnapshot);
          const label = PHASE_LABEL[teamSnapshot.team.phase] ?? teamSnapshot.team.phase;
          return total > 0 ? `${label} ${done}/${total}` : label;
        })()
      : null;

  const projectRoot = useAgentChatStore((s) => s.projectRoot);
  const knownProjects = useAgentChatStore((s) => s.knownProjects);
  const setProject = useAgentChatStore((s) => s.setProject);
  const allThreads = useAgentChatStore((s) => s.allThreads);
  const currentThreadId = useAgentChatStore((s) => s.currentThreadId);
  const listLoading = useAgentChatStore((s) => s.listLoading);
  const newChat = useAgentChatStore((s) => s.newChat);
  const selectThread = useAgentChatStore((s) => s.selectThread);
  const togglePin = useAgentChatStore((s) => s.togglePin);
  const toggleArchive = useAgentChatStore((s) => s.toggleArchive);
  const deleteThread = useAgentChatStore((s) => s.deleteThread);
  const renameThread = useAgentChatStore((s) => s.renameThread);
  const refreshThreads = useAgentChatStore((s) => s.refreshThreads);
  // Background-turn indicators: which chats (and projects) are currently working.
  // We subscribe to a STABLE fingerprint of the live data (not the whole
  // `liveTurns` object, which changes on every streamed token) so the sidebar
  // re-renders only when a turn starts / ends / changes — not on every word.
  // The actual live data is read non-reactively below, gated by this signature.
  const liveSignature = useAgentChatStore(liveTurnsSignature);
  // Chats that finished a turn while the user was looking elsewhere. Small,
  // stable object (changes only on turn-end / open), so subscribing directly is
  // cheap and won't churn on streamed tokens.
  const unseenDone = useAgentChatStore((s) => s.unseenDone);

  // ── In-flight chats are first-class rail rows ──────────────────────────
  // A turn started from a fresh draft has no persisted JSONL yet (the runtime
  // only flushes the full session at turn end), so it would be missing from
  // `allThreads` — and therefore unreachable the moment the user navigates to
  // another project. We synthesize a summary row from each live turn, keyed by
  // the SAME thread id the runtime will persist under, so the row reconciles
  // seamlessly to the on-disk record when the turn completes (`selectThread`
  // already re-attaches to the live transcript on click). Recomputed only when
  // `liveSignature` changes (read via `getState()` — token churn is invisible
  // to the sidebar, so a stale-by-one-token read can't affect the output).
  const { liveExtras, runningIds, runningProjects } = useMemo(() => {
    const { liveTurns, liveProjects } = useAgentChatStore.getState();
    const ids = new Set(Object.keys(liveTurns));
    const projects = new Set(
      Object.values(liveProjects).filter((p): p is string => !!p),
    );
    const extras: ThreadSummary[] = [];
    for (const [id, live] of Object.entries(liveTurns)) {
      const firstUser = live.messages.find((m) => m.role === "user");
      const seed = firstUser?.content ?? "";
      const title =
        live.title && live.title !== "New Chat"
          ? live.title
          : deriveThreadTitle(seed) || "New Chat";
      extras.push({
        id,
        title,
        messageCount: Math.max(1, live.messages.length),
        preview: seed.replace(/\s+/g, " ").trim().slice(0, 120),
        workspaceRoot: liveProjects[id] ?? null,
        pinned: false,
        archivedAt: null,
        createdAt: live.created_at,
        updatedAt: live.updated_at,
      });
    }
    return { liveExtras: extras, runningIds: ids, runningProjects: projects };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveSignature]);

  const allWithLive = useMemo(() => {
    if (liveExtras.length === 0) return allThreads;
    const known = new Set(allThreads.map((t) => t.id));
    const fresh = liveExtras.filter((e) => !known.has(e.id));
    return fresh.length > 0 ? [...fresh, ...allThreads] : allThreads;
  }, [allThreads, liveExtras]);

  // Projects with at least one chat that finished unwatched — powers the
  // project-row "done" dot (mirrors how `runningProjects` drives the spinner).
  const unseenProjects = useMemo(() => {
    const set = new Set<string>();
    for (const t of allWithLive) {
      if (unseenDone[t.id] && t.workspaceRoot) set.add(t.workspaceRoot);
    }
    return set;
  }, [allWithLive, unseenDone]);

  const [query, setQuery] = useState("");
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<ThreadSummary | null>(null);
  const [menu, setMenu] = useState<RailMenuState | null>(null);
  const [actionNotice, setActionNotice] = useState<RailActionNotice | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [projectsCollapsed, setProjectsCollapsed] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [pinnedProjects, setPinnedProjects] = useState<string[]>(loadPinnedProjects);
  const pinnedProjectSet = useMemo(() => new Set(pinnedProjects), [pinnedProjects]);
  const [sortMode, setSortMode] = useState<ProjectSort>(loadProjectSort);
  // Codex-style "Show more / Show less" for the projects list (persisted).
  const [projectsShowAll, setProjectsShowAll] = useState<boolean>(
    () => typeof localStorage !== "undefined" && localStorage.getItem(SHOW_ALL_PROJECTS_KEY) === "1",
  );

  const q = query.trim().toLowerCase();

  useEffect(() => {
    if (!actionNotice) return;
    const timeoutId = window.setTimeout(() => setActionNotice(null), 3200);
    return () => window.clearTimeout(timeoutId);
  }, [actionNotice]);

  // The active tree never shows archived chats — those live in the Archived
  // view. In-flight (live) chats are folded in via `allWithLive`.
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const active = allWithLive.filter((t) => !t.archivedAt);
    if (!needle) return active;
    return active.filter(
      (t) =>
        t.title.toLowerCase().includes(needle) || t.preview.toLowerCase().includes(needle),
    );
  }, [allWithLive, query]);
  const pinned = useMemo(() => filtered.filter((t) => t.pinned), [filtered]);

  // Archived chats (every project), newest-archived first — powers the Archived
  // view + its footer count. Honours the same search box as the tree.
  const archivedThreads = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const arch = allThreads.filter((t) => !!t.archivedAt);
    const matched = needle
      ? arch.filter(
          (t) =>
            t.title.toLowerCase().includes(needle) ||
            t.preview.toLowerCase().includes(needle),
        )
      : arch;
    return [...matched].sort((a, b) =>
      (b.archivedAt ?? "").localeCompare(a.archivedAt ?? ""),
    );
  }, [allThreads, query]);
  const archivedCount = useMemo(
    () => allThreads.reduce((n, t) => n + (t.archivedAt ? 1 : 0), 0),
    [allThreads],
  );

  // Non-pinned chats grouped by their project (pinned live in their own section).
  const byProject = useMemo(() => {
    const map = new Map<string, ThreadSummary[]>();
    for (const t of filtered) {
      if (t.pinned) continue;
      const root = t.workspaceRoot;
      if (!root) continue;
      const arr = map.get(root) ?? [];
      arr.push(t);
      map.set(root, arr);
    }
    return map;
  }, [filtered]);

  // Latest / earliest activity per project (from ALL chats, not the filtered
  // view) — drives the sort modes.
  const activity = useMemo(() => projectActivity(allWithLive), [allWithLive]);

  // Per-project row meta: active (non-archived) chat count + last-activity, for
  // the "12 chats · 2d ago" subtitle on each project row.
  const projectMeta = useMemo(() => {
    const map = new Map<string, { count: number; last: string }>();
    for (const t of allWithLive) {
      if (t.archivedAt) continue;
      const root = t.workspaceRoot;
      if (!root) continue;
      const cur = map.get(root);
      if (!cur) map.set(root, { count: 1, last: t.updatedAt });
      else {
        cur.count += 1;
        if (t.updatedAt > cur.last) cur.last = t.updatedAt;
      }
    }
    return map;
  }, [allWithLive]);

  const projects = useMemo(
    () =>
      orderProjects({
        knownProjects,
        threads: allWithLive,
        projectRoot,
        sortMode,
        pinned: pinnedProjectSet,
        activity,
      }),
    [knownProjects, allWithLive, projectRoot, sortMode, activity, pinnedProjectSet],
  );

  // Rebuild the team-history index off the ROOT SET (not the sorted array), so
  // re-sorting/pinning projects doesn't refetch. A team phase change means a run
  // just advanced — refetch so a newly-stamped origin chat lights up promptly.
  const projectsKey = useMemo(() => [...projects].sort().join("|"), [projects]);
  const teamPhase = teamSnapshot?.team.phase;
  useEffect(() => {
    void refreshTeamHistory(projects);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectsKey, teamPhase, refreshTeamHistory]);

  const isOpen = (root: string) => (q ? true : (expanded[root] ?? root === projectRoot));
  const projectsOpen = q ? true : !projectsCollapsed;

  const cycleSort = () => {
    const next = SORT_ORDER[(SORT_ORDER.indexOf(sortMode) + 1) % SORT_ORDER.length];
    setSortMode(next);
    try {
      localStorage.setItem(SORT_KEY, next);
    } catch {
      /* ignore quota / privacy-mode failures */
    }
  };

  const toggleProject = (root: string) => {
    setExpanded((prev) => ({ ...prev, [root]: !(prev[root] ?? root === projectRoot) }));
  };

  // Is any project currently showing its chats? Drives the collapse/expand-all
  // affordance (ignores search, which force-opens everything).
  const anyProjectOpen = projects.some(
    (root) => expanded[root] ?? root === projectRoot,
  );
  // One click folds every project's chats away (or reveals them all again).
  const toggleAllProjects = () => {
    const target = !anyProjectOpen;
    const next: Record<string, boolean> = {};
    for (const root of projects) next[root] = target;
    setExpanded(next);
  };

  // Preview vs. full projects list. Searching force-reveals everything (you
  // can't find what's hidden). Persist the user's choice.
  const showingAllProjects = q !== "" || projectsShowAll;
  const visibleProjects = showingAllProjects
    ? projects
    : projects.slice(0, PROJECTS_PREVIEW_LIMIT);
  const toggleShowAllProjects = () => {
    setProjectsShowAll((v) => {
      const next = !v;
      try {
        localStorage.setItem(SHOW_ALL_PROJECTS_KEY, next ? "1" : "0");
      } catch {
        /* ignore quota / privacy-mode failures */
      }
      return next;
    });
  };

  const toggleProjectPin = (root: string) => {
    setPinnedProjects((prev) => {
      const next = prev.includes(root) ? prev.filter((p) => p !== root) : [...prev, root];
      try {
        localStorage.setItem(PINNED_PROJECTS_KEY, JSON.stringify(next));
      } catch {
        /* ignore quota / privacy-mode failures */
      }
      return next;
    });
  };

  const openChat = (id: string, ws?: string | null) => {
    void selectThread(id, ws);
  };

  const newChatInProject = (root: string) => {
    void setProject(root);
    setExpanded((prev) => ({ ...prev, [root]: true }));
    newChat();
  };

  const addProject = async () => {
    try {
      const picked = await openFileDialog({ directory: true });
      const root = Array.isArray(picked) ? picked[0] : picked;
      if (typeof root === "string" && root.length > 0) {
        void setProject(root);
        setExpanded((prev) => ({ ...prev, [root]: true }));
      }
    } catch (err) {
      console.error("[left-rail] add project failed:", err);
    }
  };

  const commitRename = (id: string, value: string) => {
    setRenamingId(null);
    void renameThread(id, value);
  };

  const duplicateChat = async (thread: ThreadSummary) => {
    try {
      const duplicate = await threadService.duplicateThread(thread.id);
      await refreshThreads();
      openChat(duplicate.id, duplicate.workspaceRoot);
      setActionNotice({ message: "Chat duplicated", tone: "success" });
    } catch (error) {
      console.error("[left-rail] duplicate chat failed:", error);
      setActionNotice({
        message: "Couldn’t duplicate this chat. Try again.",
        tone: "error",
      });
    }
  };

  const copyChatAsMarkdown = async (threadId: string) => {
    try {
      await threadService.copyThreadAsMarkdown(threadId);
      setActionNotice({ message: "Chat copied as Markdown", tone: "success" });
    } catch (error) {
      console.error("[left-rail] copy chat as Markdown failed:", error);
      setActionNotice({
        message: "Couldn’t copy this chat. Try again.",
        tone: "error",
      });
    }
  };

  const revealProject = async (root: string) => {
    try {
      await revealInExplorer(root);
      setActionNotice({ message: "Opened in File Explorer", tone: "success" });
    } catch (error) {
      console.error("[left-rail] reveal project failed:", error);
      setActionNotice({
        message: "Couldn’t open this project in File Explorer.",
        tone: "error",
      });
    }
  };

  const openProjectTerminal = async (root: string) => {
    try {
      await openInTerminal(root);
      setActionNotice({ message: "Terminal opened", tone: "success" });
    } catch (error) {
      console.error("[left-rail] open project terminal failed:", error);
      setActionNotice({
        message: "Couldn’t open a terminal for this project.",
        tone: "error",
      });
    }
  };

  const copyProjectPath = async (root: string) => {
    const copied = await writeClipboardText(root);
    setActionNotice(
      copied
        ? { message: "Folder path copied", tone: "success" }
        : { message: "Couldn’t copy the folder path.", tone: "error" },
    );
  };

  const openChatMenu = (event: React.MouseEvent, thread: ThreadSummary) => {
    event.preventDefault();
    event.stopPropagation();
    // Read synchronously: React clears `currentTarget` once dispatch ends.
    const anchor = event.currentTarget as HTMLElement;
    const items: RailMenuItem[] = thread.archivedAt
      ? [
          {
            icon: "chat",
            label: "Open chat",
            onSelect: () => openChat(thread.id, thread.workspaceRoot),
          },
          {
            icon: "reset",
            label: "Restore chat",
            onSelect: () => void toggleArchive(thread.id),
          },
          {
            icon: "files",
            label: "Duplicate chat",
            separatorBefore: true,
            onSelect: () => void duplicateChat(thread),
          },
          {
            icon: "copy",
            label: "Copy chat as Markdown",
            onSelect: () => void copyChatAsMarkdown(thread.id),
          },
          {
            icon: "trash",
            label: "Delete permanently…",
            danger: true,
            separatorBefore: true,
            onSelect: () => setPendingDelete(thread),
          },
        ]
      : [
          {
            // First, and the only entry that OPENS something: it is the reason
            // most people reach for this menu on a chat they can already click.
            icon: "panel-right",
            label: "Open in side panel",
            onSelect: () =>
              openChatTab(thread.id, thread.title, thread.workspaceRoot ?? null),
          },
          {
            icon: "file-edit",
            label: "Rename chat",
            separatorBefore: true,
            onSelect: () => setRenamingId(thread.id),
          },
          {
            icon: "files",
            label: "Duplicate chat",
            onSelect: () => void duplicateChat(thread),
          },
          {
            icon: "copy",
            label: "Copy chat as Markdown",
            onSelect: () => void copyChatAsMarkdown(thread.id),
          },
          {
            icon: "pin",
            label: thread.pinned ? "Unpin chat" : "Pin chat",
            separatorBefore: true,
            onSelect: () => void togglePin(thread.id),
          },
          {
            icon: "archive",
            label: "Archive chat",
            onSelect: () => void toggleArchive(thread.id),
          },
          {
            icon: "trash",
            label: "Delete chat…",
            danger: true,
            separatorBefore: true,
            onSelect: () => setPendingDelete(thread),
          },
        ];
    setMenu({ x: event.clientX, y: event.clientY, items, anchor });
  };

  const openProjectMenu = (event: React.MouseEvent, root: string) => {
    event.preventDefault();
    event.stopPropagation();
    const anchor = event.currentTarget as HTMLElement;
    const projectPinned = pinnedProjectSet.has(root);
    setMenu({
      x: event.clientX,
      y: event.clientY,
      anchor,
      items: [
        {
          icon: "inspect",
          label: "New chat here",
          onSelect: () => newChatInProject(root),
        },
        {
          icon: "sliders",
          label: "Project details",
          separatorBefore: true,
          onSelect: () =>
            useAgentWorkspaceStore
              .getState()
              .openProjectTab(root, folderName(root)),
        },
        {
          icon: "external",
          label: "Open in File Explorer",
          separatorBefore: true,
          onSelect: () => void revealProject(root),
        },
        {
          icon: "terminal",
          label: "Open in integrated terminal",
          onSelect: () => {
            // Session before tab, so the Terminal panel's first-show
            // auto-shell effect doesn't race a second session into being.
            useAgentTerminalStore.getState().createSession("powershell", root);
            useAgentWorkspaceStore.getState().openTab("terminal");
          },
        },
        {
          icon: "terminal",
          label: "Open in external terminal",
          onSelect: () => void openProjectTerminal(root),
        },
        {
          icon: "pin",
          label: projectPinned ? "Unpin project" : "Pin project",
          separatorBefore: true,
          onSelect: () => toggleProjectPin(root),
        },
        {
          icon: "copy",
          label: "Copy folder path",
          onSelect: () => void copyProjectPath(root),
        },
      ],
    });
  };

  const renderChat = (thread: ThreadSummary, subtitle?: string) => {
    const active = thread.id === currentThreadId;
    const running = runningIds.has(thread.id);
    const renaming = renamingId === thread.id;
    // A settled "done" dot for a background completion — never shown while the
    // spinner is up, and cleared the moment the chat is opened.
    const unseen = !running && !!unseenDone[thread.id];
    return (
      <div
        key={thread.id}
        className="agw-rail-item"
        data-active={active}
        data-sub={subtitle ? true : undefined}
        data-running={running || undefined}
        role="button"
        tabIndex={0}
        title={
          running
            ? `${thread.title} — working…`
            : unseen
              ? `${thread.title} — finished`
              : thread.title
        }
        onClick={() => {
          if (renaming) return;
          openChat(thread.id, thread.workspaceRoot);
        }}
        onDoubleClick={(e) => {
          e.preventDefault();
          setRenamingId(thread.id);
        }}
        onContextMenu={(e) => openChatMenu(e, thread)}
        onKeyDown={(e) => {
          if (renaming) return;
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            openChat(thread.id, thread.workspaceRoot);
          } else if (e.key === "F2") {
            e.preventDefault();
            setRenamingId(thread.id);
          }
        }}
      >
        {/* Stable leading glyph slot: the chat icon, which swaps IN PLACE to the
            streaming spinner while a turn runs, or the "done" dot when a
            background turn finished unwatched — so the row never reflows and
            every state reads from the same spot. */}
        <span className="agw-rail-item-glyph" aria-hidden>
          {running ? (
            <span className="agw-rail-spin" />
          ) : unseen ? (
            <span className="agw-rail-done-dot" />
          ) : (
            <AgentIcon name="chat" size={14} />
          )}
        </span>
        <div className="agw-rail-item-text">
          {renaming ? (
            <input
              className="agw-rail-rename"
              defaultValue={thread.title || "New Chat"}
              autoFocus
              spellCheck={false}
              aria-label="Rename chat"
              onFocus={(e) => e.currentTarget.select()}
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Enter") {
                  commitRename(thread.id, e.currentTarget.value);
                } else if (e.key === "Escape") {
                  // Flag the discard so the unmount-blur can't commit it.
                  e.currentTarget.dataset.cancel = "1";
                  setRenamingId(null);
                }
              }}
              onBlur={(e) => {
                if (e.currentTarget.dataset.cancel) return;
                commitRename(thread.id, e.currentTarget.value);
              }}
            />
          ) : (
            <span className="agw-rail-item-label">{thread.title || "New Chat"}</span>
          )}
          {!renaming && subtitle && <span className="agw-rail-item-sub">{subtitle}</span>}
        </div>
        {/* Trailing cluster — the always-on team badge sits alongside the
            hover-in archive / pin actions in one reserved lane, so they can
            never overlap or shove the title around. */}
        <div className="agw-rail-item-actions">
          {teamThreadIds[thread.id] && (
            <span
              className="agw-rail-team-badge"
              title="This chat has team work"
              aria-label="This chat has team work"
            >
              <AgentIcon name="users" size={12} />
            </span>
          )}
          <button
            type="button"
            className="agw-rail-pin"
            title="Archive chat"
            aria-label="Archive chat"
            onClick={(e) => {
              e.stopPropagation();
              void toggleArchive(thread.id);
            }}
          >
            <AgentIcon name="archive" size={13} />
          </button>
          <button
            type="button"
            className="agw-rail-pin"
            data-on={thread.pinned || undefined}
            title={thread.pinned ? "Unpin chat" : "Pin chat"}
            aria-label={thread.pinned ? "Unpin chat" : "Pin chat"}
            aria-pressed={thread.pinned || false}
            onClick={(e) => {
              e.stopPropagation();
              void togglePin(thread.id);
            }}
          >
            <AgentIcon name="pin" size={13} />
          </button>
        </div>
      </div>
    );
  };

  // A row in the Archived view: opens on click (read-only preview), with restore
  // + permanent-delete actions and a countdown to auto-purge.
  const renderArchivedChat = (thread: ThreadSummary) => {
    const daysLeft = thread.archivedAt ? archiveDaysLeft(thread.archivedAt) : ARCHIVE_RETENTION_DAYS;
    const countdown = daysLeft <= 0 ? "deletes today" : `deletes in ${daysLeft}d`;
    return (
      <div
        key={thread.id}
        className="agw-rail-item"
        data-active={thread.id === currentThreadId}
        data-sub
        role="button"
        tabIndex={0}
        title={thread.title}
        onClick={() => openChat(thread.id, thread.workspaceRoot)}
        onContextMenu={(e) => openChatMenu(e, thread)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            openChat(thread.id, thread.workspaceRoot);
          }
        }}
      >
        <span className="agw-rail-item-glyph" aria-hidden>
          <AgentIcon name="archive" size={13} />
        </span>
        <div className="agw-rail-item-text">
          <span className="agw-rail-item-label">{thread.title || "New Chat"}</span>
          <span className="agw-rail-item-sub">
            {folderName(thread.workspaceRoot ?? null)} · {countdown}
          </span>
        </div>
        <div className="agw-rail-item-actions">
          <button
            type="button"
            className="agw-rail-pin"
            title="Restore chat"
            aria-label="Restore chat"
            onClick={(e) => {
              e.stopPropagation();
              void toggleArchive(thread.id);
            }}
          >
            <AgentIcon name="reset" size={13} />
          </button>
          <button
            type="button"
            className="agw-rail-pin agw-rail-del"
            title="Delete permanently"
            aria-label="Delete permanently"
            onClick={(e) => {
              e.stopPropagation();
              setPendingDelete(thread);
            }}
          >
            <AgentIcon name="trash" size={13} />
          </button>
        </div>
      </div>
    );
  };

  return (
    <div
      className="agw-zone"
      style={{
        position: "relative",
        // Frame tier — continuous with the canvas gutters; the recessed center
        // sheet's own edge does the separating, so no divider line here.
        background: "var(--agw-rail)",
      }}
    >
      {/* Header — add project + collapse rail. */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 2,
          padding: "8px 8px 8px 10px",
        }}
      >
        <button
          type="button"
          className="agw-icon-btn"
          title="Add project"
          aria-label="Add project"
          onClick={() => void addProject()}
        >
          <AgentIcon name="plus" size={17} />
        </button>
        <div style={{ flex: 1 }} />
        <button
          type="button"
          className="agw-icon-btn"
          title="Collapse rail"
          aria-label="Collapse rail"
          onClick={toggleRail}
        >
          <AgentIcon name="chevrons-left" size={16} />
        </button>
      </div>

      {/* Search */}
      <div style={{ padding: "0 10px 8px" }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            height: 32,
            padding: "0 10px",
            borderRadius: "var(--agw-radius-md)",
            border: "1px solid var(--agw-border)",
            // Derived quiet fill — stays visible on any rail colour.
            background: "var(--agw-state-quiet)",
            color: "var(--agw-text-subtle)",
            fontSize: "var(--agw-fs-label)",
          }}
        >
          <AgentIcon name="search" size={14} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search chats"
            className="agw-rail-search"
            style={{
              flex: 1,
              minWidth: 0,
              background: "transparent",
              border: "none",
              outline: "none",
              color: "var(--agw-text)",
              fontSize: "var(--agw-fs-label)",
            }}
          />
        </div>
      </div>

      {/* Tree — reserve the scrollbar gutter so expanding a long project list
          (which introduces the scrollbar) never shifts the sort button / rows. */}
      <div
        className="agw-scroll"
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: "auto",
          scrollbarGutter: "stable",
          padding: "4px 8px 12px",
        }}
      >
        {/* Team — a center-column takeover for the current project, opened from
            here (above Pinned). Active state reflects the open team screen. */}
        <button
          type="button"
          className="agw-rail-team"
          data-active={teamTabActive || undefined}
          onClick={() => useAgentWorkspaceStore.getState().openTab("team")}
          title="Open the team panel for this project"
        >
          <AgentIcon name="users" size={15} />
          <span>Team</span>
          {teamTag && <span className="agw-rail-team-tag">{teamTag}</span>}
        </button>

        {/* Pinned (global, across projects) */}
        {pinned.length > 0 && (
          <>
            <div className="agw-rail-section-label">Pinned</div>
            {pinned.map((t) =>
              renderChat(t, t.workspaceRoot ? folderName(t.workspaceRoot) : undefined),
            )}
            <div style={{ height: 6 }} />
          </>
        )}

        {/* Projects (collapsible whole section) */}
        <div className="agw-rail-section">
          <button
            type="button"
            className="agw-rail-section-toggle"
            aria-expanded={projectsOpen}
            onClick={() => setProjectsCollapsed((c) => !c)}
            title={projectsOpen ? "Collapse projects" : "Expand projects"}
          >
            <AgentIcon
              name="chevron-down"
              size={12}
              className="agw-rail-project-caret"
              style={{ transform: projectsOpen ? "none" : "rotate(-90deg)" }}
            />
            <span>Projects</span>
          </button>
          {/* Scope toggle, beside the order button so view controls share one
              corner. "8 of 21" names what you're looking at (a preview), and
              the header row itself is sticky in the scroller — so this stays
              one click away from anywhere inside the expanded list. */}
          {projectsOpen && !q && projects.length > PROJECTS_PREVIEW_LIMIT && (
            <button
              type="button"
              className="agw-rail-scope"
              onClick={toggleShowAllProjects}
              aria-expanded={projectsShowAll}
              title={
                projectsShowAll
                  ? `Show only the first ${PROJECTS_PREVIEW_LIMIT} projects`
                  : `Show all ${projects.length} projects`
              }
            >
              {projectsShowAll
                ? "Show less"
                : `${PROJECTS_PREVIEW_LIMIT} of ${projects.length}`}
            </button>
          )}
          <button
            type="button"
            className="agw-rail-sort"
            onClick={cycleSort}
            title={`Sort projects: ${SORT_LABEL[sortMode]} (click to change)`}
          >
            <AgentIcon name="sliders" size={12} />
            <span>{SORT_LABEL[sortMode]}</span>
          </button>
          <button
            type="button"
            className="agw-rail-collapse-all"
            onClick={toggleAllProjects}
            title={anyProjectOpen ? "Collapse all projects" : "Expand all projects"}
            aria-label={anyProjectOpen ? "Collapse all projects" : "Expand all projects"}
          >
            <AgentIcon
              name="chevrons-left"
              size={13}
              style={{ transform: anyProjectOpen ? "rotate(-90deg)" : "rotate(90deg)" }}
            />
          </button>
        </div>

        <Collapse open={projectsOpen}>
          {projects.length === 0 ? (
            <div className="agw-rail-empty">No projects yet. Press + to add one.</div>
          ) : (
            visibleProjects.map((root) => {
              const open = isOpen(root);
              const chats = byProject.get(root) ?? [];
              const projectPinned = pinnedProjectSet.has(root);
              const projectRunning = runningProjects.has(root);
              // Collapsed-project completion cue: a chat inside finished while
              // you were elsewhere. Suppressed while the project is still working.
              const projectUnseen = !projectRunning && unseenProjects.has(root);
              const meta = projectMeta.get(root);
              const age = describeAge(meta?.last);
              const fullDateStr = fullDate(meta?.last);
              return (
                <div key={root}>
                  <div
                    className="agw-rail-project"
                    data-active={root === projectRoot || undefined}
                    data-open={open || undefined}
                    data-stale={age.stale || undefined}
                    onContextMenu={(e) => openProjectMenu(e, root)}
                  >
                    <button
                      type="button"
                      className="agw-rail-project-main"
                      title={
                        meta
                          ? `${root}\n${meta.count} chat${meta.count === 1 ? "" : "s"}${fullDateStr ? ` · last active ${fullDateStr}` : ""}`
                          : root
                      }
                      aria-expanded={open}
                      onClick={() => toggleProject(root)}
                    >
                      <AgentIcon
                        name="chevron-down"
                        size={13}
                        className="agw-rail-project-caret"
                        style={{ transform: open ? "none" : "rotate(-90deg)" }}
                      />
                      <AgentIcon name="folder" size={14} style={{ flexShrink: 0 }} />
                      <span className="agw-rail-project-name">{folderName(root)}</span>
                      {meta && (
                        <span className="agw-rail-project-meta" aria-hidden>
                          <span className="agw-rail-project-count">{meta.count}</span>
                          {age.label && (
                            <span className="agw-rail-project-age">{age.label}</span>
                          )}
                        </span>
                      )}
                    </button>
                    {/* Always-on status indicators share one spaced cluster so
                        the team badge and the running spinner never overlap. */}
                    {(teamProjectSet[root] || projectRunning || projectUnseen) && (
                      <span className="agw-rail-project-status">
                        {teamProjectSet[root] && (
                          <span
                            className="agw-rail-team-badge agw-rail-project-team"
                            title="This project has team work"
                            aria-label="This project has team work"
                          >
                            <AgentIcon name="users" size={12} />
                          </span>
                        )}
                        {projectRunning && <span className="agw-rail-spin" aria-hidden />}
                        {projectUnseen && <span className="agw-rail-done-dot" aria-hidden />}
                      </span>
                    )}
                    <button
                      type="button"
                      className="agw-rail-pin agw-rail-project-pin"
                      data-on={projectPinned || undefined}
                      title={projectPinned ? "Unpin project" : "Pin project"}
                      aria-label={projectPinned ? "Unpin project" : "Pin project"}
                      aria-pressed={projectPinned}
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleProjectPin(root);
                      }}
                    >
                      <AgentIcon name="pin" size={13} />
                    </button>
                    <button
                      type="button"
                      className="agw-rail-newchat"
                      title="New chat in this project"
                      aria-label="New chat in this project"
                      onClick={(e) => {
                        e.stopPropagation();
                        newChatInProject(root);
                      }}
                    >
                      <AgentIcon name="inspect" size={13} />
                    </button>
                  </div>

                  <Collapse open={open}>
                    <div className="agw-rail-chats">
                      {listLoading && allThreads.length === 0 ? (
                        <div className="agw-rail-empty">Loading…</div>
                      ) : chats.length === 0 ? (
                        <div className="agw-rail-empty">
                          {q ? "No chats match." : "No chats yet."}
                        </div>
                      ) : (
                        chats.map((t) => renderChat(t))
                      )}
                    </div>
                  </Collapse>
                </div>
              );
            })
          )}

        </Collapse>

        {/* Archived — a collapsible section that expands/collapses inline,
            exactly like a project. Sits at the bottom of the tree; only appears
            once there's something archived. Each row carries its own restore +
            permanent-delete actions and a purge countdown. */}
        {archivedCount > 0 && (
          <div style={{ marginTop: 8 }}>
            <div className="agw-rail-project" data-open={archivedOpen || undefined}>
              <button
                type="button"
                className="agw-rail-project-main"
                aria-expanded={archivedOpen}
                onClick={() => setArchivedOpen((o) => !o)}
                title={archivedOpen ? "Collapse archived" : "Expand archived"}
              >
                <AgentIcon
                  name="chevron-down"
                  size={13}
                  className="agw-rail-project-caret"
                  style={{ transform: archivedOpen ? "none" : "rotate(-90deg)" }}
                />
                <AgentIcon name="archive" size={14} style={{ flexShrink: 0 }} />
                <span className="agw-rail-project-name">Archived</span>
              </button>
              <span className="agw-rail-archive-count">{archivedCount}</span>
            </div>

            <Collapse open={archivedOpen}>
              <div className="agw-rail-chats">
                {archivedThreads.length === 0 ? (
                  <div className="agw-rail-empty">
                    {q ? "No archived chats match." : "No archived chats."}
                  </div>
                ) : (
                  archivedThreads.map((t) => renderArchivedChat(t))
                )}
              </div>
            </Collapse>
          </div>
        )}
      </div>

      <AnimatePresence>
        {actionNotice && (
          <motion.div
            className="agw-rail-action-notice"
            data-tone={actionNotice.tone}
            role={actionNotice.tone === "error" ? "alert" : "status"}
            aria-live={actionNotice.tone === "error" ? "assertive" : "polite"}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 4 }}
            transition={{ duration: 0.16, ease: [0.16, 1, 0.3, 1] }}
          >
            <AgentIcon
              name={actionNotice.tone === "error" ? "diagnostics" : "check"}
              size={14}
            />
            <span>{actionNotice.message}</span>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Row context menu (chat / archived / project). */}
      {menu && <RailMenu menu={menu} onClose={() => setMenu(null)} />}

      {/* Permanent-delete confirmation — archiving is reversible (silent), but
          deleting a chat is destructive and irreversible. */}
      <AgentConfirm
        open={pendingDelete !== null}
        title="Delete chat permanently?"
        message={`“${pendingDelete?.title || "New Chat"}” will be removed for good. This can't be undone.`}
        confirmLabel="Delete"
        destructive
        onConfirm={() => {
          if (pendingDelete) void deleteThread(pendingDelete.id);
          setPendingDelete(null);
        }}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
};
