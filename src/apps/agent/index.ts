/**
 * Agent Window — public entry (barrel).
 *
 * The ONLY surface outsiders import: `import { AgentWindow } from ".../agent-window"`.
 * Internal files import each other by relative path and never import this barrel.
 */

export { AgentWindow } from "@/apps/agent/components/shell/AgentWindow";
export { AgentThemeProvider } from "@/apps/agent/components/theme/AgentThemeProvider";

export { AgentIcon } from "./shared/AgentIcon";
export type { AgentIconName } from "./shared/AgentIcon";

export {
  openAgentWindow,
  focusAgentWindow,
  closeAgentWindow,
  AGENT_WINDOW_LABEL,
} from "./adapters/window";

export {
  useAgentThemeStore,
  selectActiveAgentTheme,
} from "@/apps/agent/store/ui/useAgentThemeStore";
export { useAgentWorkspaceStore } from "@/apps/agent/store/workspace/useAgentWorkspaceStore";
export { useAgentChatStore } from "@/apps/agent/store/conversation/useAgentChatStore";

export {
  AGENT_THEMES,
  DEFAULT_AGENT_THEME_ID,
  agentDark,
  agentLight,
} from "./theme/themes";
export { tokensToCssVars } from "./theme/tokens";

export { DOCK_TAB_LABELS } from "./types";
export type {
  AgentTheme,
  AgentThemeTokens,
  AgentAppearance,
  DockTabKind,
  DockSingletonKind,
  DockTabInstance,
} from "./types";
