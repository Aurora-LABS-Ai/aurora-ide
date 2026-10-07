import React, { useEffect, useMemo, useRef, useState } from "react";

import { openFileDialog } from "@/kernel/lib/ipc/tauri";
import { useAgentSettingsStore } from "@/apps/agent/store/settings/useAgentSettingsStore";
import type { ThreadSummary } from "@/apps/agent/services/threads/thread-service";
import { matchesCommandShortcut, formatCommandShortcut } from "@/apps/agent/lib/command/command-shortcut";
import { fuzzyCommandScore } from "@/apps/agent/lib/command/command-search";
import { openIdeWindow } from "@/apps/agent/adapters/open-in-ide";
import { useAgentChatStore } from "@/apps/agent/store/conversation/useAgentChatStore";
import { useAgentThemeStore } from "@/apps/agent/store/ui/useAgentThemeStore";
import { useAgentUiStore } from "@/apps/agent/store/ui/useAgentUiStore";
import { useAgentWorkspaceStore } from "@/apps/agent/store/workspace/useAgentWorkspaceStore";
import { settingsCommands } from "@/apps/agent/lib/command/settings-commands";
import { AgentIcon, type AgentIconName } from "@/apps/agent/shared/AgentIcon";
import { CHAT_DOCK_TABS, type DockSingletonKind } from "@/apps/agent/types";
import {
  DESTINATIONS,
  openDestination,
  openDockSurface,
} from "@/apps/agent/lib/navigation/destinations";

type CommandGroup = "Actions" | "Navigate" | "Settings" | "Quick switches";

interface CommandItem {
  id: string;
  title: string;
  subtitle?: string;
  keywords?: string;
  status?: string;
  group: CommandGroup;
  icon: AgentIconName;
  run: () => void | Promise<void>;
}

/**
 * The glyph each dock surface carries in the dock's own tab strip. The palette
 * is a second door onto the same tabs, so it must not show a different icon for
 * the same thing.
 */
const DOCK_ICONS: Partial<Record<DockSingletonKind, AgentIconName>> = {
  files: "files",
  browser: "browser",
  terminal: "terminal",
  review: "diff",
  canvas: "panel-right",
  memory: "database",
};

/** Build's dock surfaces. Chat's roster is `CHAT_DOCK_TABS` in `types.ts`. */
const BUILD_DOCK_TABS: readonly DockSingletonKind[] = [
  "files",
  "browser",
  "terminal",
  "review",
];

function folderName(path: string | null | undefined): string {
  if (!path) return "No project";
  return path.split(/[\\/]+/).filter(Boolean).at(-1) ?? path;
}

function chatCommand(thread: ThreadSummary): CommandItem {
  const project = folderName(thread.workspaceRoot);
  return {
    id: `chat:${thread.id}`,
    title: thread.title || "New chat",
    subtitle: `${project}${thread.preview ? ` · ${thread.preview}` : ""}`,
    keywords: `conversation thread ${thread.workspaceRoot ?? ""}`,
    group: "Navigate",
    icon: "chat",
    run: async () => {
      useAgentUiStore.getState().closeSettings();
      await useAgentChatStore.getState().selectThread(thread.id, thread.workspaceRoot);
    },
  };
}

export const AgentCommandCenter: React.FC = () => {
  const shortcut = useAgentThemeStore((s) => s.commandCenterShortcut);
  const knownProjects = useAgentChatStore((s) => s.knownProjects);
  const allThreads = useAgentChatStore((s) => s.allThreads);
  const projectRoot = useAgentChatStore((s) => s.projectRoot);
  const railOpen = useAgentWorkspaceStore((s) => s.railOpen);
  const dockOpen = useAgentWorkspaceStore((s) => s.dockOpen);
  const notifyOnTurnComplete = useAgentSettingsStore((s) => s.notifyOnTurnComplete);
  const showActivityInTitle = useAgentSettingsStore((s) => s.showActivityInTitle);
  const executionMode = useAgentSettingsStore((s) => s.agentExecutionMode);
  /** Aurora Chat: no project, so none of the project-shaped commands. */
  const chatSurface = useAgentSettingsStore((s) => s.auroraSurface) === "chat";

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest("[data-agw-shortcut-recorder]")) return;
      if (!matchesCommandShortcut(event, shortcut)) return;
      event.preventDefault();
      if (open) {
        setOpen(false);
      } else {
        setQuery("");
        setSelected(0);
        setOpen(true);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, shortcut]);

  useEffect(() => {
    if (!open) return;
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  const items = useMemo<CommandItem[]>(() => {
    const closeToChat = () => {
      useAgentUiStore.getState().closeSettings();
    };
    const addProject = async () => {
      const picked = await openFileDialog({ directory: true });
      const root = Array.isArray(picked) ? picked[0] : picked;
      if (!root) return;
      closeToChat();
      await useAgentChatStore.getState().setProject(root);
    };

    const actions: CommandItem[] = [
      {
        id: "new-chat",
        title: "New chat",
        subtitle: chatSurface ? undefined : folderName(projectRoot),
        keywords: "compose conversation create",
        group: "Actions",
        icon: "plus",
        run: () => {
          closeToChat();
          useAgentChatStore.getState().newChat();
        },
      },
      ...(!chatSurface
        ? [{
            id: "add-project",
            title: "Open project folder",
            keywords: "add workspace browse directory",
            group: "Actions" as const,
            icon: "folder" as const,
            run: addProject,
          }]
        : []),
      {
        // The only path-free way back to the editor. It matters most when the
        // agent window is the startup surface (Settings → Preferences →
        // Startup) or was launched with `agw`: the IDE is then hidden or absent,
        // and every other route to it — "Open in IDE" — needs a file first.
        id: "open-ide",
        title: "Open the editor",
        subtitle: "Aurora IDE window",
        keywords: "ide main editor monaco switch window back",
        group: "Navigate",
        icon: "external",
        run: () => {
          useAgentUiStore.getState().closeSettings();
          void openIdeWindow();
        },
      },
      // The icon rail's destinations, from the list the rail itself draws, so
      // the palette can never name a place the rail does not have.
      ...DESTINATIONS.map<CommandItem>((destination) => ({
        id: `go:${destination.id}`,
        title: destination.id === "home" ? "Go home" : `Go to ${destination.label}`,
        subtitle: destination.hint,
        keywords: destination.keywords,
        group: "Navigate",
        icon: destination.icon,
        run: () => openDestination(destination.id),
      })),
      // The dock holds different surfaces on each side of the app, and the
      // palette is a way IN to them — offering "Open files" in Aurora Chat
      // opens a tree of a folder the chat cannot read.
      ...(chatSurface ? CHAT_DOCK_TABS : BUILD_DOCK_TABS).map<CommandItem>((kind) => ({
        id: `dock:${kind}`,
        title: `Open ${kind}`,
        keywords: `right dock panel ${kind}`,
        group: "Navigate" as const,
        icon: DOCK_ICONS[kind] ?? "panel-right",
        run: () => openDockSurface(kind),
      })),
      {
        id: "toggle-rail",
        title: chatSurface ? "Toggle chat navigator" : "Toggle project & chat navigator",
        subtitle: "Left rail",
        status: railOpen ? "On" : "Off",
        keywords: chatSurface ? "sidebar chats hide show" : "sidebar projects chats hide show",
        group: "Quick switches",
        icon: "panel-left",
        run: () => {
          useAgentUiStore.getState().closeSettings();
          useAgentWorkspaceStore.getState().toggleRail();
        },
      },
      {
        id: "toggle-dock",
        title: "Toggle right dock",
        status: dockOpen ? "On" : "Off",
        keywords: chatSurface
          ? "canvas memory gallery panel hide show"
          : "files browser terminal panel hide show",
        group: "Quick switches",
        icon: "panel-right",
        run: () => {
          useAgentUiStore.getState().closeSettings();
          useAgentWorkspaceStore.getState().toggleDock();
        },
      },
      {
        id: "toggle-notifications",
        title: "Turn completion notifications",
        status: notifyOnTurnComplete ? "On" : "Off",
        keywords: "enable disable done alert",
        group: "Quick switches",
        icon: "message",
        run: () =>
          useAgentSettingsStore
            .getState()
            .setNotifyOnTurnComplete(!useAgentSettingsStore.getState().notifyOnTurnComplete),
      },
      {
        id: "toggle-live-title",
        title: "Live activity in chat title",
        status: showActivityInTitle ? "On" : "Off",
        keywords: "enable disable status header",
        group: "Quick switches",
        icon: "eye",
        run: () =>
          useAgentSettingsStore
            .getState()
            .setShowActivityInTitle(!useAgentSettingsStore.getState().showActivityInTitle),
      },
      ...(!chatSurface
        ? [{
            id: "toggle-mode",
            title: executionMode === "plan" ? "Switch to Agent mode" : "Switch to Plan mode",
            status: executionMode === "plan" ? "Plan" : "Agent",
            keywords: "execution mode agent plan enable disable",
            group: "Quick switches",
            icon: executionMode === "plan" ? "book" : "facet",
            run: () =>
              useAgentSettingsStore
                .getState()
                .setAgentExecutionMode(executionMode === "plan" ? "agent" : "plan"),
          } satisfies CommandItem]
        : []),
    ];

    // Rebuilt as you type, because a settings result carries the term it
    // matched. Rebuilding plain objects costs nothing next to the ranking pass
    // that already runs on every keystroke.
    const settings = settingsCommands(query);

    const projects = (chatSurface ? [] : knownProjects).map<CommandItem>((root) => ({
      id: `project:${root}`,
      title: folderName(root),
      subtitle: root,
      keywords: "project workspace folder navigate",
      group: "Navigate",
      icon: "folder",
      run: async () => {
        closeToChat();
        await useAgentChatStore.getState().setProject(root);
      },
    }));

    return [...actions, ...settings, ...projects, ...allThreads.map(chatCommand)];
  }, [
    allThreads,
    chatSurface,
    dockOpen,
    executionMode,
    knownProjects,
    notifyOnTurnComplete,
    projectRoot,
    query,
    railOpen,
    showActivityInTitle,
  ]);

  const results = useMemo(() => {
    const ranked = items
      .map((item, index) => ({ item, index, score: fuzzyCommandScore(item, query) }))
      .filter((entry) => entry.score >= 0)
      .sort((a, b) => b.score - a.score || a.index - b.index);
    return ranked.slice(0, query.trim() ? 60 : 18).map((entry) => entry.item);
  }, [items, query]);

  const activeIndex = results.length === 0 ? 0 : Math.min(selected, results.length - 1);

  if (!open) return null;

  const execute = (item: CommandItem) => {
    setOpen(false);
    Promise.resolve(item.run()).catch((error) => {
      console.error(`[agent-command-center] ${item.id} failed:`, error);
    });
  };

  return (
    <div className="agw-command-overlay" role="presentation" onMouseDown={() => setOpen(false)}>
      <section
        className="agw-command-center"
        role="dialog"
        aria-modal="true"
        aria-label="Command center"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="agw-command-search">
          <AgentIcon name="search" size={18} />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setSelected(0);
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                setOpen(false);
              } else if (event.key === "ArrowDown") {
                event.preventDefault();
                if (results.length > 0) {
                  setSelected((value) => Math.min(results.length - 1, value + 1));
                }
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                setSelected((value) => Math.max(0, value - 1));
              } else if (event.key === "Enter" && results[activeIndex]) {
                event.preventDefault();
                execute(results[activeIndex]);
              }
            }}
            placeholder="Search commands, projects, chats, settings…"
            aria-label="Search command center"
            aria-controls="agw-command-results"
            autoComplete="off"
            spellCheck={false}
          />
          <kbd>{formatCommandShortcut(shortcut)}</kbd>
        </div>

        <div id="agw-command-results" className="agw-command-results agw-scroll" role="listbox">
          {results.map((item, index) => {
            const showGroup = index === 0 || results[index - 1].group !== item.group;
            return (
              <React.Fragment key={item.id}>
                {showGroup && <div className="agw-command-group">{item.group}</div>}
                <button
                  type="button"
                  role="option"
                  aria-selected={index === activeIndex}
                  className="agw-command-item"
                  data-selected={index === activeIndex || undefined}
                  onMouseEnter={() => setSelected(index)}
                  onClick={() => execute(item)}
                >
                  <span className="agw-command-icon"><AgentIcon name={item.icon} size={16} /></span>
                  <span className="agw-command-copy">
                    <span className="agw-command-title">{item.title}</span>
                    {item.subtitle && <span className="agw-command-subtitle">{item.subtitle}</span>}
                  </span>
                  {item.status && <span className="agw-command-status">{item.status}</span>}
                  {index === activeIndex && <kbd className="agw-command-enter">Enter</kbd>}
                </button>
              </React.Fragment>
            );
          })}
          {results.length === 0 && (
            <div className="agw-command-empty">
              <AgentIcon name="search" size={20} />
              <span>No commands, projects, chats, or settings match “{query}”.</span>
            </div>
          )}
        </div>
        <footer className="agw-command-footer">
          <span><kbd>↑</kbd><kbd>↓</kbd> Navigate</span>
          <span><kbd>Enter</kbd> Open</span>
          <span><kbd>Esc</kbd> Close</span>
        </footer>
      </section>
    </div>
  );
};
