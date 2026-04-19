/**
 * THEME ARCHITECTURE NOTICE:
 * 
 * This project uses a centralized theme system. DO NOT use hardcoded colors.
 * 
 * Instead of:
 *   - Hardcoded hex values: #ff0000, #1a1a1a
 *   - Hardcoded RGB values: rgb(255, 0, 0)
 *   - Tailwind arbitrary colors: bg-[#1a1a1a], text-[#ff0000]
 * 
 * Use theme tokens via CSS variables:
 *   - CSS: var(--aurora-{category}-{token})
 *   - Tailwind: bg-[var(--aurora-editor-background)]
 *   - Component styles: style={{ background: 'var(--aurora-sidebar-background)' }}
 * 
 * Available categories: editor, sidebar, chat, terminal, statusBar, titleBar, common
 * 
 * See: DOCS/theme-dev.md for full token reference
 * See: src/types/theme.ts for TypeScript interfaces
 * See: src/services/theme-service.ts for theme utilities
 */

import React from 'react';
import { resolveExplorerIcon } from '../../lib/icon-registry';
import { useSettingsStore } from '../../store/useSettingsStore';

interface IconProps {
  name: string;
  className?: string;
  /** Full path for context-aware icons (e.g., files inside .aurora folder) */
  path?: string;
}

interface FolderIconProps extends IconProps {
  open?: boolean;
}

/**
 * Aurora Rules Icon - for .md files inside .aurora folder
 */
const AuroraRulesIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg
    viewBox="0 0 24 24"
    className={className}
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
  >
    {/* Document base */}
    <path
      d="M6 2C4.9 2 4 2.9 4 4V20C4 21.1 4.9 22 6 22H18C19.1 22 20 21.1 20 20V8L14 2H6Z"
      fill="#1e1e2e"
      stroke="#7c3aed"
      strokeWidth="1.5"
    />
    {/* Folded corner */}
    <path
      d="M14 2V8H20"
      stroke="#7c3aed"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    {/* Star/sparkle - representing rules/magic */}
    <path
      d="M12 11L12.9 13.8L16 14L13.5 16L14.2 19L12 17.5L9.8 19L10.5 16L8 14L11.1 13.8L12 11Z"
      fill="#7c3aed"
    />
  </svg>
);

/**
 * Aurora Folder Icon - uses the app icon with folder styling
 */
const AuroraFolderIcon: React.FC<{ open?: boolean; className?: string }> = ({ open, className }) => (
  <div className={`relative ${className}`} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
    <img
      src="/aurora.png"
      alt=".aurora"
      className={className}
      draggable={false}
      style={{
        objectFit: 'contain',
        opacity: open ? 1 : 0.85,
        filter: open ? 'none' : 'saturate(0.8)'
      }}
    />
  </div>
);

const AssetIcon: React.FC<{ src: string; alt: string; className?: string }> = ({ src, alt, className }) => (
  <img
    src={src}
    alt={alt}
    className={className}
    draggable={false}
    style={{ objectFit: 'contain' }}
  />
);

export const FileIcon: React.FC<IconProps> = ({ name, className, path }) => {
  const explorerIconPack = useSettingsStore((state) => state.explorerIconPack);
  const icon = resolveExplorerIcon({ name, path, isFolder: false }, explorerIconPack);

  if (icon.kind === 'aurora-rules') {
    return <AuroraRulesIcon className={className} />;
  }

  return <AssetIcon src={icon.src || '/material-icons/file.svg'} alt={icon.alt} className={className} />;
};

export const FolderIcon: React.FC<FolderIconProps> = ({ name, open, className }) => {
  const explorerIconPack = useSettingsStore((state) => state.explorerIconPack);
  const icon = resolveExplorerIcon(
    { name: name || 'folder', isFolder: true, isOpen: open },
    explorerIconPack,
  );

  if (icon.kind === 'aurora-folder') {
    return <AuroraFolderIcon open={open} className={className} />;
  }

  return <AssetIcon src={icon.src || '/material-icons/folder.svg'} alt={icon.alt} className={className} />;
};
