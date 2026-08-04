/**
 * Agent Window — right-click context menu [shared view].
 *
 * The standard surface for row actions anywhere in the window — chat rows and
 * project headers in the left rail, file rows in the Files tab. One component
 * so every right-click in the agent window opens the identical menu: same
 * width, same row height, same separators, same close behavior.
 *
 * Portaled into the window root so the owning panel's scroll/overflow can't
 * clip it; closes on outside press, Escape, scroll, resize, or after any pick.
 */

import React, { useEffect, useRef } from "react";
import { createPortal } from "react-dom";

import { AgentIcon, type AgentIconName } from "../shared/AgentIcon";

export interface RailMenuItem {
  icon: AgentIconName;
  label: string;
  danger?: boolean;
  separatorBefore?: boolean;
  onSelect: () => void;
}

export interface RailMenuState {
  x: number;
  y: number;
  items: RailMenuItem[];
}

const RAIL_MENU_WIDTH = 228;
const RAIL_MENU_ROW = 34;

export const RailMenu: React.FC<{ menu: RailMenuState; onClose: () => void }> = ({
  menu,
  onClose,
}) => {
  // Own node, not a class query: two panels can host menus (rail rows and file
  // rows), and a selector would find whichever mounted first.
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    const onPointerDown = (event: PointerEvent) => {
      const el = menuRef.current;
      if (el && el.contains(event.target as Node)) return;
      onClose();
    };
    const onScroll = (event: Event) => {
      const el = menuRef.current;
      if (el && el.contains(event.target as Node)) return;
      onClose();
    };
    const onResize = () => onClose();
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
    };
  }, [onClose]);

  const separatorCount = menu.items.reduce(
    (count, item) => count + (item.separatorBefore ? 1 : 0),
    0,
  );
  const height = menu.items.length * RAIL_MENU_ROW + separatorCount * 7 + 12;
  const left = Math.max(8, Math.min(menu.x, window.innerWidth - RAIL_MENU_WIDTH - 8));
  const top = Math.max(8, Math.min(menu.y, window.innerHeight - height - 8));
  const portalTarget =
    (document.querySelector(".agw-root") as HTMLElement | null) ?? document.body;

  return createPortal(
    <div
      ref={menuRef}
      className="agw-menu agw-rail-menu"
      role="menu"
      style={{ position: "fixed", left, top, width: RAIL_MENU_WIDTH, zIndex: 1000 }}
    >
      {menu.items.map((item) => (
        <React.Fragment key={item.label}>
          {item.separatorBefore && <div className="agw-rail-menu-separator" role="separator" />}
          <button
            type="button"
            role="menuitem"
            className="agw-menu-item agw-rail-menu-item"
            data-danger={item.danger || undefined}
            onClick={() => {
              onClose();
              item.onSelect();
            }}
          >
            <AgentIcon name={item.icon} size={14} />
            <span>{item.label}</span>
          </button>
        </React.Fragment>
      ))}
    </div>,
    portalTarget,
  );
};
