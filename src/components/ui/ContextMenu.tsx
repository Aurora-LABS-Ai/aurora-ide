import React, { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

interface MenuItem {
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
      className="fixed z-[9999] min-w-[180px] bg-input border border-border rounded-lg shadow-xl py-1 animate-in fade-in zoom-in-95 duration-100"
      style={{ left: x, top: y }}
    >
      {items.map((item, index) => {
        if (item.divider) {
          return <div key={index} className="h-[1px] bg-border my-1" />;
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
            className={`w-full px-3 py-1.5 text-left text-[12px] flex items-center gap-2.5 transition-colors ${
              item.disabled
                ? 'text-text-disabled cursor-not-allowed'
                : item.danger
                ? 'text-text-primary hover:bg-danger/20 hover:text-danger'
                : 'text-text-primary hover:bg-primary/20'
            }`}
          >
            {item.icon && <span className="w-4 h-4 flex items-center justify-center">{item.icon}</span>}
            <span className="flex-1">{item.label}</span>
            {item.shortcut && (
              <span className="text-[10px] text-text-disabled ml-4">{item.shortcut}</span>
            )}
          </button>
        );
      })}
    </div>,
    document.body
  );
};

