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

import React, { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

export interface MenuItem {
  label: string;
  icon?: React.ReactNode;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
  divider?: boolean;
  shortcut?: string;
}

interface ContextMenuProps {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
}

export const ContextMenu: React.FC<ContextMenuProps> = ({ x, y, items, onClose }) => {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };

    const handleScroll = () => {
      onClose();
    };

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
    document.addEventListener('scroll', handleScroll, true);

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
      document.removeEventListener('scroll', handleScroll, true);
    };
  }, [onClose]);

  // Adjust position to stay within viewport
  useEffect(() => {
    if (menuRef.current) {
      const rect = menuRef.current.getBoundingClientRect();
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;

      let adjustedX = x;
      let adjustedY = y;

      if (x + rect.width > viewportWidth) {
        adjustedX = viewportWidth - rect.width - 8;
      }

      if (y + rect.height > viewportHeight) {
        adjustedY = viewportHeight - rect.height - 8;
      }

      menuRef.current.style.left = `${adjustedX}px`;
      menuRef.current.style.top = `${adjustedY}px`;
    }
  }, [x, y]);

  return createPortal(
    <div
      ref={menuRef}
      className="fixed z-[9999] min-w-[220px] backdrop-blur-xl rounded-xl p-1.5 animate-in fade-in zoom-in-95 slide-in-from-top-2 duration-150"
      style={{
        left: x,
        top: y,
        backgroundColor: 'var(--aurora-sidebar-background)', // Use sidebar token for solid, reliable background
        borderColor: 'var(--aurora-common-border)',
        boxShadow: 'var(--aurora-common-shadow)',
        borderWidth: '1px',
        borderStyle: 'solid',
      }}
    >
      {items.map((item, index) => {
        if (item.divider) {
          return <div key={index} className="h-px my-1.5 mx-2" style={{ backgroundColor: 'var(--aurora-common-border)' }} />;
        }

        return (
          <button
            key={index}
            onClick={() => {
              if (!item.disabled) {
                item.onClick();
                onClose();
              }
            }}
            disabled={item.disabled}
            className={`group w-full px-3 py-2 text-left text-[13px] flex items-center gap-3 transition-all duration-75 rounded-md ${item.disabled ? 'cursor-not-allowed opacity-50' : ''
              }`}
            style={{
              color: item.danger ? 'var(--aurora-common-error)' : 'var(--aurora-editor-foreground)',
            }}
            onMouseEnter={(e) => {
              if (!item.disabled) {
                e.currentTarget.style.backgroundColor = item.danger ? 'var(--aurora-common-error)' : 'var(--aurora-common-primary)';
                e.currentTarget.style.color = item.danger ? 'var(--aurora-common-errorForeground)' : 'var(--aurora-common-primaryForeground)';
              }
            }}
            onMouseLeave={(e) => {
              if (!item.disabled) {
                e.currentTarget.style.backgroundColor = 'transparent';
                e.currentTarget.style.color = item.danger ? 'var(--aurora-common-error)' : 'var(--aurora-editor-foreground)';
              }
            }}
          >
            {item.icon && (
              <span className="w-4 h-4 flex items-center justify-center transition-colors">
                {item.icon}
              </span>
            )}
            <span className="flex-1 font-medium tracking-wide">{item.label}</span>
            {item.shortcut && (
              <span
                className="text-[10px] uppercase tracking-wider font-medium ml-4"
                style={{ opacity: 0.6 }}
              >
                {item.shortcut}
              </span>
            )}
          </button>
        );
      })}
    </div>,
    document.body
  );
};