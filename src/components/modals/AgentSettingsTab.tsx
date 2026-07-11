import React from 'react';
import clsx from 'clsx';
import { Shield, Plug } from 'lucide-react';
import { ToolSettingsTab } from './ToolSettingsTab';
import { McpSettingsTab } from './McpSettingsTab';
import { settingsControlButtonStyle } from './settings-shared';

/**
 * Settings → Agent.
 *
 * A single home for what the agent can do inside the IDE: its Tools and the
 * external MCP servers it can reach. The Agent Team lives in the Agent Window
 * (Agent Window → Settings → Team); it is not configured from here.
 */

export type AgentSubTabKey = 'tools' | 'mcp';

interface SubTab {
  id: AgentSubTabKey;
  label: string;
  icon: React.ComponentType<React.SVGProps<SVGSVGElement>>;
}

const SUB_TABS: SubTab[] = [
  { id: 'tools', label: 'Tools', icon: Shield },
  { id: 'mcp', label: 'MCP Servers', icon: Plug },
];

interface AgentSettingsTabProps {
  subTab: AgentSubTabKey;
  onSubTabChange: (tab: AgentSubTabKey) => void;
}

export const AgentSettingsTab: React.FC<AgentSettingsTabProps> = ({
  subTab,
  onSubTabChange,
}) => {
  return (
    <div className="space-y-5">
      {/* Sub-navigation */}
      <div
        role="tablist"
        aria-label="Agent settings sections"
        className="inline-flex items-center gap-1 p-1"
        style={settingsControlButtonStyle}
      >
        {SUB_TABS.map(({ id, label, icon: Icon }) => {
          const isActive = subTab === id;
          return (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={isActive}
              onClick={() => onSubTabChange(id)}
              className={clsx(
                'inline-flex h-7 items-center gap-1.5 px-3 text-[12px] font-medium transition-colors',
                isActive
                  ? 'font-semibold'
                  : 'text-text-secondary hover:text-text-primary',
              )}
              style={{
                borderRadius: 4,
                color: isActive ? 'var(--aurora-common-primary)' : undefined,
                backgroundColor: isActive
                  ? 'color-mix(in srgb, var(--aurora-common-primary) 16%, transparent)'
                  : 'transparent',
              }}
            >
              <Icon className="h-3.5 w-3.5" />
              {label}
            </button>
          );
        })}
      </div>

      {/* Active section */}
      {subTab === 'tools' && <ToolSettingsTab />}
      {subTab === 'mcp' && <McpSettingsTab />}
    </div>
  );
};
