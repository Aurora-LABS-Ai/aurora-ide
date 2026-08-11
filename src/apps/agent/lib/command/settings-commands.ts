/**
 * Agent Window — settings entries for the command center.
 *
 * The command center is the other place people look for a setting, so it must
 * not answer a question the Settings page can answer. It used to: its settings
 * list was hand-written here with its own keywords, and the two drifted until
 * "chapter" found the Chapters switch in Settings and nothing at all in the
 * command center. Both now read `SETTINGS_CATALOG`.
 *
 * Kept as a leaf, apart from the modal component, so the catalog and the
 * ranking can be exercised without mounting the window (and without every store
 * the modal touches waking up to do it).
 */

import { SETTINGS_CATALOG } from "@/apps/agent/settings/settings-catalog";
import { matchedSearchTerm } from "@/apps/agent/settings/settings-search";
import { useAgentUiStore } from "@/apps/agent/store/ui/useAgentUiStore";
import type { AgentIconName } from "@/apps/agent/shared/AgentIcon";

export interface SettingsCommand {
  id: string;
  title: string;
  subtitle: string;
  group: "Settings";
  icon: AgentIconName;
  run: () => void;
}

/**
 * Only the ONE term that matched reaches the entry, as its subtitle. Pouring
 * every indexed term into the searchable text would wreck ranking instead of
 * helping it: the fuzzy fallback matches a query as a subsequence, and against
 * a haystack that long almost any typing matches almost every section.
 *
 * Opening the entry lands on the page with that term already searched, which is
 * the whole point — you asked for a control, so you arrive at the control, not
 * at the page filed under it.
 */
export function settingsCommands(query: string): SettingsCommand[] {
  return SETTINGS_CATALOG.map((section) => {
    const term = matchedSearchTerm(section, query);
    return {
      id: `settings:${section.id}`,
      title: section.title,
      subtitle: term ? `Settings · ${term}` : "Settings",
      group: "Settings" as const,
      icon: section.icon,
      run: () => useAgentUiStore.getState().openSettings(section.id, term ?? ""),
    };
  });
}
