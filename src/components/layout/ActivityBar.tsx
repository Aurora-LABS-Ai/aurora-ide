/**
 * THEME ARCHITECTURE NOTICE:
 *
 * This project uses a centralized theme system. DO NOT use hardcoded colors.
 * Use theme tokens via CSS variables:
 *   - CSS: var(--aurora-{category}-{token})
 *   - Tailwind: bg-[var(--aurora-editor-background)]
 */

import React from 'react';
import { Files, GitBranch, Search, Settings, Palette } from 'lucide-react';
import clsx from 'clsx';

export type SidebarPanel = 'explorer' | 'git' | 'search' | 'theme';

interface ActivityBarProps {
  activePanel: SidebarPanel;
  onPanelChange: (panel: SidebarPanel) => void;
  onSettingsClick: () => void;
  gitBadgeCount?: number;
}

interface ActivityBarItemProps {
  icon: React.ReactNode;
  isActive: boolean;
  onClick: () => void;
  title: string;
  badgeCount?: number;
}

const ActivityBarItem: React.FC<ActivityBarItemProps> = ({
  icon,
  isActive,
  onClick,
  title,
  badgeCount,
}) => {
  return (
    <button
      onClick={onClick}
      title={title}
      className={clsx(
        "relative w-12 h-12 flex items-center justify-center transition-all duration-150",
        "hover:text-text-primary",
        isActive
          ? "text-text-primary"
          : "text-text-disabled"
      )}
      style={{
        borderLeft: isActive ? '2px solid var(--aurora-common-primary)' : '2px solid transparent',
        background: isActive ? 'var(--aurora-sidebar-item-selected)' : 'transparent',
      }}
    >
      {icon}
      {badgeCount !== undefined && badgeCount > 0 && (
        <span
          className="absolute top-2 right-2 min-w-[16px] h-4 px-1 text-[10px] font-medium rounded-full flex items-center justify-center"
          style={{
            background: 'var(--aurora-common-primary)',
            color: 'var(--aurora-common-primary-foreground)',
          }}
        >
          {badgeCount > 99 ? '99+' : badgeCount}
        </span>
      )}
    </button>
  );
};

export const ActivityBar: React.FC<ActivityBarProps> = ({
  activePanel,
  onPanelChange,
  onSettingsClick,
  gitBadgeCount,
}) => {
  return (
    <div
      className="flex flex-col h-full w-12 border-r"
      style={{
        background: 'var(--aurora-title-bar-background)',
        borderColor: 'var(--aurora-common-border)',
      }}
    >
      {/* Top Icons */}
      <div className="flex flex-col">
        <ActivityBarItem
          icon={<Files className="w-5 h-5" />}
          isActive={activePanel === 'explorer'}
          onClick={() => onPanelChange('explorer')}
          title="Explorer (Ctrl+Shift+E)"
        />
        <ActivityBarItem
          icon={<GitBranch className="w-5 h-5" />}
          isActive={activePanel === 'git'}
          onClick={() => onPanelChange('git')}
          title="Source Control (Ctrl+Shift+G)"
          badgeCount={gitBadgeCount}
        />
        <ActivityBarItem
          icon={<Search className="w-5 h-5" />}
          isActive={activePanel === 'search'}
          onClick={() => onPanelChange('search')}
          title="Search (Ctrl+Shift+F)"
        />
        <ActivityBarItem
          icon={<Palette className="w-5 h-5" />}
          isActive={activePanel === 'theme'}
          onClick={() => onPanelChange('theme')}
          title="Themes"
        />
      </div>

      {/* Spacer */}
      <div className="flex-1" />

      {/* Bottom Icons */}
      <div className="flex flex-col mb-2">
        <ActivityBarItem
          icon={<Settings className="w-5 h-5" />}
          isActive={false}
          onClick={onSettingsClick}
          title="Settings (Ctrl+,)"
        />
      </div>
    </div>
  );
};

export default ActivityBar;
