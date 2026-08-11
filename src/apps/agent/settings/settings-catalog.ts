/**
 * Agent Window — the settings catalog (leaf, no JSX).
 *
 * What settings exist, what each one is called, and which controls live inside
 * it. Two surfaces search this and they must not disagree: the Settings page's
 * own search box, and the command center. When those were separate lists the
 * command center said "no match" for `chapter` while the settings page found
 * the Chapters switch — the same question, two answers, because one list had
 * been kept up to date and the other had not.
 *
 * Deliberately free of JSX and page imports: the command center reads this to
 * rank results, and it must not drag every settings page into its chunk to do
 * it. `SettingsPage` supplies the `render()` half separately.
 *
 * `searchTerms` are the searchable names of controls and concepts on the page,
 * written the way a person would ask for them rather than the way the code
 * spells them. They are also landing queries: matching one opens the page
 * already searched for that term, so the reader arrives at the control instead
 * of at the page that contains it.
 */

import type { AgentIconName } from "@/apps/agent/shared/AgentIcon";
import type { SettingsSection } from "@/apps/agent/store/ui/useAgentUiStore";

export interface SettingsCatalogEntry {
  id: SettingsSection;
  navLabel: string;
  icon: AgentIconName;
  group: string;
  eyebrow: string;
  title: string;
  description: string;
  /** Searchable controls and concepts that are rendered inside this section. */
  searchTerms?: string[];
  /**
   * This page is built from `SettingsSection`/`SettingsRow`, so its controls can
   * filter themselves and be rendered INLINE in search results — the reader
   * flips the switch without leaving the results.
   *
   * Pages without the shared primitives (Providers, Tools, MCP, Profile,
   * Skills) cannot narrow to a single control, and dumping a whole page under a
   * search heading would be a worse answer than a link. They appear as a
   * destination instead. Converting one of those pages to the primitives is all
   * it takes to promote it.
   */
  inlineResults?: boolean;
  /**
   * Full-bleed sections own the whole content area (no padding, no page
   * scroll) so they can run their own sidebar + pane layout edge-to-edge —
   * e.g. Providers' list sidebar. Default sections keep the padded, scrolling
   * content column.
   */
  fullBleed?: boolean;
}

export const SETTINGS_CATALOG: SettingsCatalogEntry[] = [
  {
    id: "profile",
    navLabel: "Profile",
    icon: "users",
    group: "Personal",
    eyebrow: "Personal",
    title: "Profile",
    description: "Your local usage stats — tokens, streaks, longest task, most-used tools.",
    searchTerms: [
      "token activity",
      "daily",
      "weekly",
      "cumulative",
      "requests by provider",
      "most used models",
      "streak",
      "export as image",
    ],
  },
  {
    id: "providers",
    navLabel: "Providers",
    icon: "providers",
    group: "Models",
    eyebrow: "Models",
    title: "Providers & Models",
    description: "Connect providers and configure models with models.dev auto-fill.",
    searchTerms: [
      "api key",
      "base url",
      "model",
      "reasoning",
      "temperature",
      "context window",
      "connection test",
    ],
    fullBleed: true,
  },
  {
    id: "tools",
    navLabel: "Tools",
    icon: "shield",
    group: "Agent",
    eyebrow: "Agent",
    title: "Tools & Approvals",
    description: "What the agent may run on its own, and what needs your sign-off.",
    searchTerms: [
      "approval",
      "auto approve",
      "auto accept",
      "syntax validation",
      "shell",
      "browser",
      "file changes",
      "project file map",
    ],
  },
  {
    id: "execution",
    navLabel: "Agent",
    icon: "sliders",
    group: "Agent",
    eyebrow: "Agent",
    title: "Agent",
    description:
      "Global instructions, execution mode, context compaction, and chat titling — how the agent behaves everywhere.",
    searchTerms: [
      "global instructions",
      "execution mode",
      "plan mode",
      "read outside workspace",
      "context compaction",
      "compact at",
      "summary detail",
      "compaction model",
      "code index",
      "browser control",
      "browser tools",
    ],
    inlineResults: true,
  },
  {
    id: "team",
    navLabel: "Team",
    icon: "users",
    group: "Agent",
    eyebrow: "Agent",
    title: "Agent Team",
    description:
      "A team of agents that plans, splits your project by scope, and builds in parallel — coordinated by a lead you chat with.",
    searchTerms: [
      "enable team",
      "maximum workers",
      "team model",
      "coordinator",
      "recent runs",
      "parallel",
    ],
    inlineResults: true,
  },
  {
    id: "mcp",
    navLabel: "MCP",
    icon: "plug",
    group: "Agent",
    eyebrow: "Agent",
    title: "MCP Servers",
    description: "Connect Model Context Protocol servers for external tools and resources.",
    searchTerms: [
      "model context protocol",
      "server",
      "stdio",
      "streamable http",
      "sse",
      "tools",
      "resources",
      "environment variables",
    ],
  },
  {
    id: "skills",
    navLabel: "Skills",
    icon: "book",
    group: "Agent",
    eyebrow: "Agent",
    title: "Skills",
    description:
      "Reusable coding playbooks the agent loads into context — enable per workspace.",
    searchTerms: [
      "workspace loadout",
      "equip",
      "catalog",
      "built-in",
      "global",
      "project skills",
      "trigger",
    ],
  },
  {
    id: "preferences",
    navLabel: "Preferences",
    icon: "sliders",
    group: "Window",
    eyebrow: "Window",
    title: "Preferences",
    description:
      "Personal window preferences — status cues, notifications, and other how-it-feels-for-me toggles.",
    searchTerms: [
      "startup",
      "open on launch",
      "composer",
      "model selector position",
      "command center",
      "keyboard shortcut",
      "typing assistance",
      "autocorrect",
      "word completion",
      "prompt refine",
      "dictation",
      "quick replies",
      "chat titles",
      "notification",
      "transcript",
      "timeline spine",
      "keep the question on screen",
      "sticky user message",
      "chapters",
    ],
    inlineResults: true,
  },
  {
    id: "appearance",
    navLabel: "Appearance",
    icon: "palette",
    group: "Window",
    eyebrow: "Window",
    title: "Appearance",
    description: "Theme the agent window — colors, fonts, contrast, and per-region controls.",
    searchTerms: [
      "theme",
      "color",
      "accent",
      "contrast",
      "corner radius",
      "motion",
      "font",
      "typography",
      "message text size",
      "code block text size",
      "syntax highlighting",
      "reset appearance",
    ],
    inlineResults: true,
  },
  {
    id: "diagnostics",
    navLabel: "Diagnostics",
    icon: "diagnostics",
    group: "Window",
    eyebrow: "Window",
    title: "Diagnostics",
    description:
      "What has failed, and where the log lives — so a crash is still readable after the window is gone.",
    searchTerms: [
      "log",
      "logs",
      "log file",
      "aurora.log",
      "error",
      "errors",
      "crash",
      "panic",
      "stack trace",
      "recent problems",
      "clear the log",
      "send to agent",
      "troubleshoot",
      "report a bug",
    ],
    inlineResults: true,
  },
];
