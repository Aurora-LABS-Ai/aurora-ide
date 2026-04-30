/**
 * THEME ARCHITECTURE NOTICE:
 *
 * This project uses a centralized theme system. DO NOT use hardcoded colors.
 * Use theme tokens via CSS variables:
 *   - CSS: var(--aurora-{category}-{token})
 *   - Tailwind: bg-[var(--aurora-editor-background)]
 */

import React from 'react';
import { FolderTree, GitBranch, ScanSearch, SlidersHorizontal, SwatchBook } from 'lucide-react';
import clsx from 'clsx';
import { AppIcon } from '../ui/AppIcon';

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
  const [isHovered, setIsHovered] = React.useState(false);

  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      title={title}
      className={clsx(
        "relative mx-auto my-0.5 flex h-10 w-10 items-center justify-center rounded-[8px] transition-all duration-150",
        isActive
          ? "text-text-primary"
          : "text-text-disabled hover:text-text-primary",
      )}
      style={{
        background: isActive
          ? 'color-mix(in srgb, var(--aurora-common-primary) 14%, transparent)'
          : isHovered
            ? 'color-mix(in srgb, var(--aurora-common-primary) 8%, transparent)'
            : 'transparent',
        border: isActive
          ? '1px solid color-mix(in srgb, var(--aurora-common-primary) 22%, transparent)'
          : '1px solid transparent',
      }}
    >
      {isActive && (
        <span
          className="absolute left-[-7px] top-1/2 h-5 w-[2px] -translate-y-1/2 rounded-full"
          style={{ background: 'var(--aurora-common-primary)' }}
        />
      )}
      {icon}
      {badgeCount !== undefined && badgeCount > 0 && (
        <span
          className="absolute right-0.5 top-0.5 flex h-4 min-w-[16px] items-center justify-center rounded-full px-1 text-[10px] font-medium"
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
      className="flex h-full w-[54px] flex-col border-r px-1 py-2"
      style={{
        background: 'color-mix(in srgb, var(--aurora-title-bar-background) 78%, var(--aurora-sidebar-background) 22%)',
        borderColor: 'var(--aurora-common-border)',
      }}
    >
      {/* Top Icons */}
      <div className="flex flex-col">
        <ActivityBarItem
          icon={<AppIcon icon={FolderTree} size={18} />}
          isActive={activePanel === 'explorer'}
          onClick={() => onPanelChange('explorer')}
          title="Explorer (Ctrl+Shift+E)"
        />
        <ActivityBarItem
          icon={<AppIcon icon={GitBranch} size={18} />}
          isActive={activePanel === 'git'}
          onClick={() => onPanelChange('git')}
          title="Source Control (Ctrl+Shift+G)"
          badgeCount={gitBadgeCount}
        />
        <ActivityBarItem
          icon={<AppIcon icon={ScanSearch} size={18} />}
          isActive={activePanel === 'search'}
          onClick={() => onPanelChange('search')}
          title="Search (Ctrl+Shift+F)"
        />
        <ActivityBarItem
          icon={<AppIcon icon={SwatchBook} size={18} />}
          isActive={activePanel === 'theme'}
          onClick={() => onPanelChange('theme')}
          title="Themes"
        />
      </div>

      {/* Spacer */}
      <div className="flex-1" />

      {/* Bottom Icons */}
      <div className="mb-1 flex flex-col">
        <ActivityBarItem
          icon={<AppIcon icon={SlidersHorizontal} size={18} />}
          isActive={false}
          onClick={onSettingsClick}
          title="Settings (Ctrl+,)"
        />
      </div>
    </div>
  );
};

export default ActivityBar;
