import React from 'react';
import { getIconName, getIconUrl } from '../../lib/material-icon-theme';

interface IconProps {
  name: string;
  className?: string;
  /** Full path for context-aware icons (e.g., files inside .aurora folder) */
  path?: string;
}

interface FolderIconProps extends IconProps {
  open?: boolean;
}

// Aurora-specific folder names
const AURORA_FOLDER = '.aurora';

/**
 * Check if a file is inside the .aurora folder
 */
const isAuroraFile = (path?: string): boolean => {
  if (!path) return false;
  const normalizedPath = path.replace(/\\/g, '/');
  return normalizedPath.includes(`/${AURORA_FOLDER}/`) || normalizedPath.includes(`\\${AURORA_FOLDER}\\`);
};

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
      src="/app-icon.svg"
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

export const FileIcon: React.FC<IconProps> = ({ name, className, path }) => {
  // Check for Aurora rules files (.md files inside .aurora folder)
  if (isAuroraFile(path) && name.toLowerCase().endsWith('.md')) {
    return <AuroraRulesIcon className={className} />;
  }

  // 1. Determine which icon definition to use (e.g. "react", "typescript")
  const iconName = getIconName(name, false);

  // 2. Get the URL
  const src = getIconUrl(iconName);

  return (
    <img
      src={src}
      alt={name}
      className={className}
      draggable={false}
      // Ensure the icon doesn't look blurry
      style={{ objectFit: 'contain' }}
    />
  );
};

export const FolderIcon: React.FC<FolderIconProps> = ({ name, open, className }) => {
  // Check for .aurora folder
  if (name === AURORA_FOLDER || name === 'aurora') {
    return <AuroraFolderIcon open={open} className={className} />;
  }

  // 1. Determine folder icon (e.g. "folder-src", "folder-open")
  const iconName = getIconName(name || 'folder', true, open);

  // 2. Get the URL
  const src = getIconUrl(iconName);

  return (
    <img
      src={src}
      alt={name}
      className={className}
      draggable={false}
      style={{ objectFit: 'contain' }}
    />
  );
};