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
 * See: src/kernel/types/theme.ts for TypeScript interfaces
 * See: src/apps/ide/services/theme-service.ts for theme utilities
 */

import React from 'react';
import { resolveExplorerIcon } from '@/kernel/lib/icons/icon-registry';
import { useSettingsStore } from '@/kernel/store/useSettingsStore';

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

/**
 * Every icon source this session has already painted at least once.
 *
 * These marks are `<img>` elements pointing at a per-extension SVG, so the very
 * first `.tsx` in a session costs a real fetch and the box sits empty until it
 * lands. In a settled explorer nobody notices; in a streaming tool row, where
 * four marks appear inside 200ms, the empty box and then the picture read as
 * two separate events and the row looks like it is glitching.
 *
 * The set is what keeps the cure from being worse than the disease: a source
 * that has been seen before is decoded already, so it renders at full opacity
 * on its first frame and never fades. Only the genuine fetch fades in, once.
 */
const PAINTED_ICON_SOURCES = new Set<string>();

const AssetIcon: React.FC<{ src: string; alt: string; className?: string }> = ({ src, alt, className }) => {
  const [painted, setPainted] = React.useState(() => PAINTED_ICON_SOURCES.has(src));
  // The node is reused when only the source changes (an icon-pack switch, or a
  // chip whose file changed underneath it), so the answer is re-derived during
  // render rather than in an effect — an effect would run a frame late and put
  // a blank frame in front of an icon that was already cached.
  const [renderedSrc, setRenderedSrc] = React.useState(src);
  if (src !== renderedSrc) {
    setRenderedSrc(src);
    setPainted(PAINTED_ICON_SOURCES.has(src));
  }

  const settle = () => {
    PAINTED_ICON_SOURCES.add(src);
    setPainted(true);
  };

  return (
    <img
      src={src}
      alt={alt}
      className={className}
      draggable={false}
      // `onError` settles too: a missing icon should fall back to whatever the
      // browser draws for a broken image, exactly as before, never to nothing.
      onLoad={settle}
      onError={settle}
      style={{
        objectFit: 'contain',
        opacity: painted ? 1 : 0,
        transition: 'opacity 120ms cubic-bezier(0, 0, 0.2, 1)',
      }}
    />
  );
};

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
