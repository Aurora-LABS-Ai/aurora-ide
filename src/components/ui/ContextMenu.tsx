/**
 * THEME ARCHITECTURE NOTICE:
 *
 * This project uses a centralized theme system. DO NOT use hardcoded colors.
 *
 * Use theme tokens via CSS variables:
 *   - CSS: var(--aurora-{category}-{token})
 *
 * Available categories: editor, sidebar, chat, terminal, statusBar, titleBar, common
 * See: DOCS/theme-dev.md for full token reference
 */

import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export interface MenuItem {
  /** Visible label for an interactive item. */
  label?: string;
  icon?: React.ReactNode;
  onClick?: () => void;
  /** Render in error/destructive color. */
  danger?: boolean;
  /** Disabled (non-interactive, dimmed). */
  disabled?: boolean;
  /** Render a 1px divider instead of a row. */
  divider?: boolean;
  /** Right-aligned keyboard hint. */
  shortcut?: string;
  /** Static section header (non-interactive label) shown above a group. */
  header?: string;
}

interface ContextMenuProps {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
  /** Optional minimum width for the menu panel. Defaults to 220. */
  minWidth?: number;
}

/**
 * Right-click context menu.
 *
 * Visual language matches the enterprise menu surfaces (MenuBarMenu, IdeSelect):
 *   - 6px panel radius, 1px theme-aware border, dual soft drop shadows.
 *   - 26px tall items, 4px highlight radius, 12.5px label.
 *   - Hover: subtle 12% primary tint; danger items use 14% error tint.
 *   - Section headers + dividers for IDE-style grouping.
 */
export const ContextMenu: React.FC<ContextMenuProps> = ({
  x,
  y,
  items,
  onClose,
  minWidth = 220,
}) => {
  const menuRef = useRef<HTMLDivElement>(null);
  // The menu starts invisible until it is measured + clamped to the
  // viewport. This avoids a single-frame flash at (x, y) before the
  // edge-clamp moves the menu inward.
  const [position, setPosition] = useState<{
    left: number;
    top: number;
    placed: boolean;
  }>({ left: x, top: y, placed: false });

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };

    const handleScroll = () => onClose();
    const handleResize = () => onClose();

    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleEscape);
    document.addEventListener("scroll", handleScroll, true);
    window.addEventListener("resize", handleResize);

    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleEscape);
      document.removeEventListener("scroll", handleScroll, true);
      window.removeEventListener("resize", handleResize);
    };
  }, [onClose]);

  // Place the menu BEFORE the browser paints (useLayoutEffect runs after
  // DOM mutations but before paint). This is critical: the CSS animation
  // `animate-in fade-in zoom-in-95` starts the moment the element is
  // committed to the DOM, so we must finalise position before paint.
  //
  // Behaviour: ALWAYS animate from "top left" (downward growth), regardless
  // of where the user clicked — the user explicitly wants identical
  // appearance everywhere in the explorer (centre and bottom). When the
  // click is near a viewport edge we just CLAMP the position so the menu
  // fits, but we never flip the animation origin. This avoids the
  // "fading up from below" effect that occurred when the menu had its
  // bottom edge anchored to a near-bottom click.
  useLayoutEffect(() => {
    if (!menuRef.current) return;
    const rect = menuRef.current.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const margin = 8;

    let left = x;
    let top = y;

    // Clamp horizontally so the menu fits.
    if (left + rect.width > viewportWidth - margin) {
      left = viewportWidth - rect.width - margin;
    }
    if (left < margin) left = margin;

    // Clamp vertically so the menu fits. Note: we DON'T flip the origin —
    // the menu may end up positioned slightly above the click when there
    // isn't enough room below, but it still animates downward (same
    // animation as a centre click), which is what the user wants.
    if (top + rect.height > viewportHeight - margin) {
      top = viewportHeight - rect.height - margin;
    }
    if (top < margin) top = margin;

    setPosition({ left, top, placed: true });
  }, [x, y, items]);

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      className="fixed z-[9999] py-1 animate-in fade-in zoom-in-95 duration-100"
      style={{
        left: position.left,
        top: position.top,
        minWidth,
        backgroundColor: "var(--aurora-sidebar-background)",
        border:
          "1px solid color-mix(in srgb, var(--aurora-common-border) 70%, transparent)",
        borderRadius: 6,
        boxShadow:
          "0 6px 24px color-mix(in srgb, var(--aurora-common-shadow) 50%, transparent), 0 2px 6px color-mix(in srgb, var(--aurora-common-shadow) 35%, transparent)",
        // Always grow downward from the click point — consistent animation
        // regardless of whether the click was in the middle or near a
        // viewport edge.
        transformOrigin: "top left",
        // Hide for the very first frame so the placement effect can clamp
        // the menu before the user sees it. Once placed, fade/zoom in.
        visibility: position.placed ? "visible" : "hidden",
        opacity: position.placed ? undefined : 0,
      }}
    >
      {items.map((item, index) => {
        if (item.divider) {
          return (
            <div
              key={`divider-${index}`}
              aria-hidden
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
              className="px-2.5 pt-1.5 pb-0.5 text-[10px] uppercase tracking-[0.08em] font-semibold"
              style={{
                color:
                  "color-mix(in srgb, var(--aurora-editor-foreground) 55%, transparent)",
              }}
            >
              {item.header}
            </div>
          );
        }

        const baseColor = item.danger
          ? "var(--aurora-common-error)"
          : "var(--aurora-editor-foreground)";

        return (
          <button
            key={`item-${index}`}
            type="button"
            role="menuitem"
            disabled={item.disabled}
            onClick={() => {
              if (item.disabled || !item.onClick) return;
              item.onClick();
              onClose();
            }}
            className={`group w-full flex items-center gap-2.5 text-left text-[12.5px] leading-none ${
              item.disabled ? "cursor-not-allowed opacity-45" : ""
            }`}
            style={{
              height: 26,
              padding: "0 10px",
              margin: "1px 4px",
              width: "calc(100% - 8px)",
              borderRadius: 4,
              color: baseColor,
              backgroundColor: "transparent",
              transition: "background-color 80ms ease",
              outline: "none",
              border: "none",
              appearance: "none",
            }}
            onMouseEnter={(e) => {
              if (item.disabled) return;
              e.currentTarget.style.backgroundColor = item.danger
                ? "color-mix(in srgb, var(--aurora-common-error) 14%, transparent)"
                : "color-mix(in srgb, var(--aurora-common-primary) 12%, transparent)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.backgroundColor = "transparent";
            }}
          >
            <span
              className="w-3.5 h-3.5 flex items-center justify-center shrink-0"
              style={{
                opacity: item.icon ? 0.85 : 0,
                color: baseColor,
              }}
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
  );
};
