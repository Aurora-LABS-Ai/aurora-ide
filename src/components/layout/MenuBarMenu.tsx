/**
 * THEME ARCHITECTURE NOTICE:
 * This component uses the centralized theme system via CSS variables.
 * See: src/services/theme-service.ts for theme utilities.
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export interface MenuBarItem {
  divider?: boolean;
  label?: string;
  icon?: React.ReactNode;
  shortcut?: string;
  disabled?: boolean;
  danger?: boolean;
  onClick?: () => void;
  /** Static section header (non-interactive label) shown above a group. */
  header?: string;
}

interface MenuBarMenuProps {
  label: string;
  items: MenuBarItem[];
  /** Optional aria-label / tooltip on the trigger button. */
  title?: string;
  /** Render an icon-only trigger instead of a text label. */
  triggerIcon?: React.ReactNode;
  /** Width of the dropdown panel in pixels. Defaults to 240. */
  menuWidth?: number;
  /** Align dropdown to the start (left) or end (right) of the trigger. Defaults to start. */
  align?: "start" | "end";
  /** Optional className for the trigger button. */
  triggerClassName?: string;
  /** Optional inline style for the trigger button. */
  triggerStyle?: React.CSSProperties;
}

/**
 * VS Code-style menubar dropdown menu.
 *
 * Anchored below a trigger button (not at mouse position). Closes on outside
 * click, Escape, scroll, or item click. Supports section headers, dividers,
 * keyboard shortcuts, and disabled/danger states.
 */
export const MenuBarMenu: React.FC<MenuBarMenuProps> = ({
  label,
  items,
  title,
  triggerIcon,
  menuWidth = 240,
  align = "start",
  triggerClassName,
  triggerStyle,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const closeMenu = useCallback(() => {
    setIsOpen(false);
    setPosition(null);
  }, []);

  const computePosition = useCallback(() => {
    const triggerEl = triggerRef.current;
    if (!triggerEl) return;
    const rect = triggerEl.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    let left = align === "end" ? rect.right - menuWidth : rect.left;
    let top = rect.bottom + 4;

    if (left + menuWidth > viewportWidth - 8) {
      left = viewportWidth - menuWidth - 8;
    }
    if (left < 8) left = 8;

    const estimatedHeight = items.reduce(
      (sum, item) => sum + (item.divider ? 9 : item.header ? 22 : 28),
      12,
    );
    if (top + estimatedHeight > viewportHeight - 8) {
      top = Math.max(8, rect.top - estimatedHeight - 4);
    }

    setPosition({ left, top });
  }, [align, items, menuWidth]);

  const openMenu = useCallback(() => {
    computePosition();
    setIsOpen(true);
  }, [computePosition]);

  const toggleMenu = useCallback(() => {
    if (isOpen) {
      closeMenu();
    } else {
      openMenu();
    }
  }, [isOpen, openMenu, closeMenu]);

  useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      if (menuRef.current?.contains(target)) return;
      if (triggerRef.current?.contains(target)) return;
      closeMenu();
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeMenu();
    };
    const handleScroll = () => closeMenu();
    const handleResize = () => closeMenu();

    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleKey);
    document.addEventListener("scroll", handleScroll, true);
    window.addEventListener("resize", handleResize);

    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleKey);
      document.removeEventListener("scroll", handleScroll, true);
      window.removeEventListener("resize", handleResize);
    };
  }, [isOpen, closeMenu]);

  const handleItemClick = (item: MenuBarItem) => {
    if (item.disabled || !item.onClick) return;
    item.onClick();
    closeMenu();
  };

  const [isHovered, setIsHovered] = useState(false);

  // Visual states for the trigger:
  // - open    → strong primary tint (the dropdown's source is unmistakable)
  // - hover   → subtle primary tint (button-like affordance)
  // - idle    → renders nothing on top of triggerStyle; uses box-shadow (not
  //              border) for chrome so layout never shifts and idle looks
  //              wrapperless when no triggerStyle bg is provided.
  const triggerStateStyle: React.CSSProperties | null = isOpen
    ? {
        backgroundColor:
          "color-mix(in srgb, var(--aurora-common-primary) 18%, transparent)",
        boxShadow:
          "inset 0 0 0 1px color-mix(in srgb, var(--aurora-common-primary) 28%, transparent)",
        color: "var(--aurora-editor-foreground)",
      }
    : isHovered
      ? {
          backgroundColor:
            "color-mix(in srgb, var(--aurora-common-primary) 10%, transparent)",
          boxShadow:
            "inset 0 0 0 1px color-mix(in srgb, var(--aurora-common-primary) 18%, transparent)",
          color: "var(--aurora-editor-foreground)",
        }
      : null;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={toggleMenu}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
        title={title ?? label}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        className={triggerClassName}
        style={{
          // Hard reset any user-agent styles so the button is invisible at idle
          // when no triggerStyle is provided.
          appearance: "none",
          outline: "none",
          border: "none",
          ...triggerStyle,
          ...(triggerStateStyle ?? {}),
        }}
        onFocus={(e) => e.currentTarget.style.outline = "none"}
      >
        {triggerIcon ?? (
          <span className="text-[12px] font-medium tracking-[0.01em] leading-none">
            {label}
          </span>
        )}
      </button>

      {isOpen && position
        ? createPortal(
            <div
              ref={menuRef}
              role="menu"
              className="fixed z-[9999] py-1 backdrop-blur-xl animate-in fade-in zoom-in-95 slide-in-from-top-1 duration-100"
              style={{
                left: position.left,
                top: position.top,
                width: menuWidth,
                backgroundColor: "var(--aurora-sidebar-background)",
                border:
                  "1px solid color-mix(in srgb, var(--aurora-common-border) 70%, transparent)",
                borderRadius: 6,
                boxShadow:
                  "0 6px 24px color-mix(in srgb, var(--aurora-common-shadow) 50%, transparent), 0 2px 6px color-mix(in srgb, var(--aurora-common-shadow) 35%, transparent)",
              }}
            >
              {items.map((item, index) => {
                if (item.divider) {
                  return (
                    <div
                      key={`divider-${index}`}
                      style={{
                        height: 1,
                        margin: "4px 6px",
                        backgroundColor:
                          "color-mix(in srgb, var(--aurora-common-border) 60%, transparent)",
                      }}
                    />
                  );
                }
                if (item.header) {
                  return (
                    <div
                      key={`header-${index}`}
                      className="px-3 pt-1.5 pb-0.5 text-[10px] uppercase tracking-[0.08em] font-semibold"
                      style={{
                        color:
                          "color-mix(in srgb, var(--aurora-editor-foreground) 55%, transparent)",
                      }}
                    >
                      {item.header}
                    </div>
                  );
                }
                return (
                  <button
                    key={`item-${index}`}
                    type="button"
                    role="menuitem"
                    disabled={item.disabled}
                    onClick={() => handleItemClick(item)}
                    className={`group w-full flex items-center gap-3 px-3 text-left text-[12.5px] leading-none ${
                      item.disabled ? "cursor-not-allowed opacity-45" : ""
                    }`}
                    style={{
                      height: 26,
                      color: item.danger
                        ? "var(--aurora-common-error)"
                        : "var(--aurora-editor-foreground)",
                      backgroundColor: "transparent",
                    }}
                    onMouseEnter={(e) => {
                      if (item.disabled) return;
                      e.currentTarget.style.backgroundColor = item.danger
                        ? "var(--aurora-common-error)"
                        : "var(--aurora-common-primary)";
                      e.currentTarget.style.color = item.danger
                        ? "var(--aurora-common-error-foreground)"
                        : "var(--aurora-common-primary-foreground)";
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.backgroundColor = "transparent";
                      e.currentTarget.style.color = item.danger
                        ? "var(--aurora-common-error)"
                        : "var(--aurora-editor-foreground)";
                    }}
                  >
                    <span
                      className="w-3.5 h-3.5 flex items-center justify-center shrink-0"
                      style={{ opacity: item.icon ? 1 : 0 }}
                    >
                      {item.icon}
                    </span>
                    <span className="flex-1 truncate font-normal">{item.label}</span>
                    {item.shortcut ? (
                      <span
                        className="text-[10.5px] tracking-wide font-mono ml-3 shrink-0"
                        style={{ opacity: 0.55 }}
                      >
                        {item.shortcut}
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>,
            document.body,
          )
        : null}
    </>
  );
};
