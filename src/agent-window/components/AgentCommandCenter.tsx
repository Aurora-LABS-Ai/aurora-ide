import React, { useEffect, useMemo, useRef, useState } from "react";

import { openFileDialog } from "../../lib/tauri";
import { useSettingsStore } from "../../store/useSettingsStore";
import type { ThreadSummary } from "../../services/thread-service";
import { matchesCommandShortcut, formatCommandShortcut } from "../lib/command-shortcut";
import { fuzzyCommandScore } from "../lib/command-search";
import { openIdeWindow } from "../adapters/open-in-ide";
import { useAgentChatStore } from "../store/useAgentChatStore";
import { useAgentThemeStore } from "../store/useAgentThemeStore";
import { useAgentUiStore, type SettingsSection } from "../store/useAgentUiStore";
import { useAgentWorkspaceStore } from "../store/useAgentWorkspaceStore";
import { AgentIcon, type AgentIconName } from "../shared/AgentIcon";

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

const SETTINGS: Array<{
  id: SettingsSection;
  title: string;
  keywords: string;
  icon: AgentIconName;
}> = [
  { id: "profile", title: "Profile", keywords: "usage stats tokens streak", icon: "users" },
  { id: "providers", title: "Providers & models", keywords: "api model llm", icon: "providers" },
  { id: "tools", title: "Tools & approvals", keywords: "permissions allow deny", icon: "shield" },
  { id: "execution", title: "Agent behavior", keywords: "instructions mode context title", icon: "facet" },
  { id: "team", title: "Agent team", keywords: "parallel agents lead", icon: "users" },
  { id: "mcp", title: "MCP servers", keywords: "tools protocol integrations", icon: "plug" },
  { id: "skills", title: "Skills", keywords: "playbooks rules", icon: "book" },
  { id: "preferences", title: "Preferences", keywords: "shortcut notifications typing", icon: "sliders" },
  { id: "appearance", title: "Appearance", keywords: "theme color font contrast", icon: "palette" },
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
  const notifyOnTurnComplete = useSettingsStore((s) => s.notifyOnTurnComplete);
  const showActivityInTitle = useSettingsStore((s) => s.showActivityInTitle);
  const executionMode = useSettingsStore((s) => s.agentExecutionMode);

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
        subtitle: folderName(projectRoot),
        keywords: "compose conversation create",
        group: "Actions",
        icon: "plus",
        run: () => {
          closeToChat();
          useAgentChatStore.getState().newChat();
        },
      },
      {
        id: "add-project",
        title: "Open project folder",
        keywords: "add workspace browse directory",
        group: "Actions",
        icon: "folder",
        run: addProject,
      },
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
      {
        id: "open-team",
        title: "Open agent team",
        keywords: "parallel lead agents",
        group: "Navigate",
        icon: "users",
        run: () => {
          useAgentUiStore.getState().closeSettings();
          useAgentWorkspaceStore.getState().openTab("team");
        },
      },
      ...(["files", "browser", "terminal", "review"] as const).map<CommandItem>((kind) => ({
        id: `dock:${kind}`,
        title: `Open ${kind}`,
        keywords: `right dock panel ${kind}`,
        group: "Navigate" as const,
        icon: kind === "review" ? "diff" : kind,
        run: () => {
          useAgentUiStore.getState().closeSettings();
          useAgentWorkspaceStore.getState().openTab(kind);
        },
      })),
      {
        id: "toggle-rail",
        title: "Toggle project & chat navigator",
        subtitle: "Left rail",
        status: railOpen ? "On" : "Off",
        keywords: "sidebar projects chats hide show",
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
        keywords: "files browser terminal panel hide show",
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
          useSettingsStore
            .getState()
            .setNotifyOnTurnComplete(!useSettingsStore.getState().notifyOnTurnComplete),
      },
      {
        id: "toggle-live-title",
        title: "Live activity in chat title",
        status: showActivityInTitle ? "On" : "Off",
        keywords: "enable disable status header",
        group: "Quick switches",
        icon: "eye",
        run: () =>
          useSettingsStore
            .getState()
            .setShowActivityInTitle(!useSettingsStore.getState().showActivityInTitle),
      },
      {
        id: "toggle-mode",
        title: executionMode === "plan" ? "Switch to Agent mode" : "Switch to Plan mode",
        status: executionMode === "plan" ? "Plan" : "Agent",
        keywords: "execution mode agent plan enable disable",
        group: "Quick switches",
        icon: executionMode === "plan" ? "book" : "facet",
        run: () =>
          useSettingsStore
            .getState()
            .setAgentExecutionMode(executionMode === "plan" ? "agent" : "plan"),
      },
    ];

    const settings = SETTINGS.map<CommandItem>((section) => ({
      id: `settings:${section.id}`,
      title: section.title,
      subtitle: "Settings",
      keywords: section.keywords,
      group: "Settings",
      icon: section.icon,
      run: () => useAgentUiStore.getState().openSettings(section.id),
    }));

    const projects = knownProjects.map<CommandItem>((root) => ({
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
    dockOpen,
    executionMode,
    knownProjects,
    notifyOnTurnComplete,
    projectRoot,
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
