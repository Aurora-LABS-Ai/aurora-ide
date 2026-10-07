/**
 * Agent Window — the icon rail [view].
 *
 * The 48px strip on the window's left edge, present on every view. It carries
 * the things that are not chats: Home (the chat list and the conversation),
 * Images, Library and Plugins from `DESTINATIONS`; then, on Aurora Chat, the
 * Memory dock surface the rail used to hold as a row; then Settings and the
 * account at the foot.
 *
 * The chat sidebar beside it is unchanged and is what Home shows. A page
 * destination replaces the shell, sidebar included, so pressing Images folds
 * the chat list away without a second animation.
 *
 * Reads `--agw-*` tokens only (`49-icon-rail.css`). One `RailCell` primitive
 * draws every cell; nothing here is styled twice.
 */

import React from "react";

import { AgentIcon, type AgentIconName } from "@/apps/agent/shared/AgentIcon";
import {
  DESTINATIONS,
  litRailCell,
  openDestination,
  openDockSurface,
  type RailCell as RailCellId,
} from "@/apps/agent/lib/navigation/destinations";
import { useAgentSettingsStore } from "@/apps/agent/store/settings/useAgentSettingsStore";
import { useAgentUiStore } from "@/apps/agent/store/ui/useAgentUiStore";
import { useAgentWorkspaceStore } from "@/apps/agent/store/workspace/useAgentWorkspaceStore";
import type { DockSingletonKind } from "@/apps/agent/types";

const RailCell: React.FC<{
  icon: AgentIconName;
  label: string;
  title?: string;
  active?: boolean;
  /** A toggle (Memory) rather than a place; announced as pressed, not current. */
  pressed?: boolean;
  /** A dot in the corner: something is happening behind this cell. */
  dot?: string | null;
  onClick: () => void;
}> = ({ icon, label, title, active, pressed, dot, onClick }) => (
  <button
    type="button"
    className="agw-iconrail-btn"
    data-active={active || pressed || undefined}
    aria-label={label}
    aria-current={active ? "page" : undefined}
    aria-pressed={pressed === undefined ? undefined : pressed}
    title={title ?? label}
    onClick={onClick}
  >
    <AgentIcon name={icon} size={18} />
    {dot && <span className="agw-iconrail-dot" title={dot} aria-label={dot} />}
  </button>
);

export const IconRail: React.FC = () => {
  const view = useAgentUiStore((s) => s.view);
  const section = useAgentUiStore((s) => s.settingsSection);
  const openSettings = useAgentUiStore((s) => s.openSettings);
  const openView = useAgentUiStore((s) => s.openView);
  const chatSurface = useAgentSettingsStore((s) => s.auroraSurface) === "chat";
  const railOpen = useAgentWorkspaceStore((s) => s.railOpen);
  const activeDockKind = useAgentWorkspaceStore(
    (s) => (s.dockOpen ? s.tabs.find((t) => t.id === s.activeTabId)?.kind : undefined) ?? null,
  );

  const lit: RailCellId = litRailCell(view, section);
  const dockPressed = (kind: DockSingletonKind) => view === "chat" && activeDockKind === kind;

  return (
    <nav className="agw-iconrail" aria-label="Aurora">
      {DESTINATIONS.map((destination) => (
        <RailCell
          key={destination.id}
          icon={destination.icon}
          label={destination.label}
          title={
            destination.id === "home" && view === "chat"
              ? railOpen
                ? "Hide the chat list"
                : "Show the chat list"
              : destination.hint
          }
          active={lit === destination.id}
          onClick={() => openDestination(destination.id, { toggleChatList: true })}
        />
      ))}

      {chatSurface && (
        <>
          <span className="agw-iconrail-divider" role="separator" />
          <RailCell
            icon="database"
            label="Memory"
            title="What Aurora remembers about you"
            pressed={dockPressed("memory")}
            onClick={() => openDockSurface("memory")}
          />
        </>
      )}

      <span className="agw-iconrail-grow" />

      {/* Providers has its own page: it carries its own list on the left, and
          inside Settings that made two sidebars side by side. */}
      <RailCell
        icon="cpu"
        label="Providers"
        title="Model providers and API keys"
        active={lit === "providers"}
        onClick={() => openView("providers")}
      />
      <RailCell
        icon="settings"
        label="Settings"
        active={lit === "settings"}
        // Settings reopens on the last section — unless that section belongs
        // to another cell (Plugins, Account), in which case pressing Settings
        // from there would change nothing and the cell would look dead.
        onClick={() =>
          openSettings(litRailCell("settings", section) === "settings" ? undefined : "preferences")
        }
      />
      <RailCell
        icon="user"
        label="Account"
        title="Your profile and usage"
        active={lit === "account"}
        onClick={() => openSettings("profile")}
      />
    </nav>
  );
};
