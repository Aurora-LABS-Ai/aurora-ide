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

import React, { useEffect, useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";

import { AgentIcon, type AgentIconName } from "@/apps/agent/shared/AgentIcon";

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
  /**
   * The row the menu was opened from.
   *
   * Used ONLY to decide whether a scroll invalidates the menu's position —
   * see the scroll handler below. Optional: a caller that omits it gets the
   * old close-on-any-scroll behaviour, which is safe but noisy.
   */
  anchor?: HTMLElement | null;
}

/** Breathing room kept between the menu and every window edge. */
const EDGE_GUTTER = 8;

export const RailMenu: React.FC<{ menu: RailMenuState; onClose: () => void }> = ({
  menu,
  onClose,
}) => {
  // Own node, not a class query: two panels can host menus (rail rows and file
  // rows), and a selector would find whichever mounted first.
  const menuRef = useRef<HTMLDivElement | null>(null);
  // Read into a local so the effect closes over a value, not over `menu`.
  // It only changes when a different menu is opened, so it does not add
  // re-subscription churn beyond what `onClose`'s identity already causes.
  const anchor = menu.anchor ?? null;

  useLayoutEffect(() => {
    const element = menuRef.current;
    element?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    return () => {
      if (element?.contains(document.activeElement) && anchor?.isConnected) anchor.focus();
    };
  }, [anchor]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault(); event.stopPropagation();
        anchor?.focus(); onClose();
      }
      if (!menuRef.current?.contains(document.activeElement)) return;
      if (event.key === "Tab") { onClose(); return; }
      if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        event.preventDefault(); event.stopPropagation();
        const items = Array.from(menuRef.current.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'));
        const current = items.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
        items[next]?.focus();
      }
    };
    const onPointerDown = (event: PointerEvent) => {
      const el = menuRef.current;
      if (el && el.contains(event.target as Node)) return;
      onClose();
    };
    /**
     * Close only when the scroll actually MOVES the row this menu points at.
     *
     * This listener is bound in the CAPTURE phase on `window` because `scroll`
     * does not bubble — which means it hears every scroller in the document,
     * not just the one under the menu. That was the bug: `useAgentAutoScroll`'s
     * follow loop assigns `scrollTop` on the transcript once per animation
     * frame while a turn streams, so right-clicking a chat row during a
     * response dismissed the menu ~60 times a second and it never survived
     * long enough to click.
     *
     * Same family as the follow-loop fix itself — a `scroll` event says
     * nothing about who scrolled or what moved. The menu is `position: fixed`
     * at the press point, so the only scroll that can strand it is one in an
     * ancestor scroller of its own anchor.
     */
    const onScroll = (event: Event) => {
      const el = menuRef.current;
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (el && el.contains(target)) return;
      if (anchor && !target.contains(anchor)) return;
      onClose();
    };
    const onResize = () => onClose();
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
    };
  }, [anchor, onClose]);

  /**
   * Keep the menu inside the window, measured rather than estimated.
   *
   * This used to clamp against a hard-coded 228px width and a per-row height
   * recomputed here in JS — two copies of geometry that CSS actually owns, and
   * both wrong the moment a label got longer or the user changed the interface
   * text scale. The menu now sizes itself to its own labels (`.agw-rail-menu`),
   * so its box is only knowable after layout.
   *
   * `useLayoutEffect` runs before paint, so the pre-clamp position at the raw
   * press point is never shown. `offsetWidth`/`offsetHeight` are layout values,
   * deliberately not `getBoundingClientRect()` — the entrance animation applies
   * `scale(0.98)`, which would shrink a rect reading mid-flight and drift the
   * clamp by a few pixels.
   */
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const maxLeft = window.innerWidth - el.offsetWidth - EDGE_GUTTER;
    const maxTop = window.innerHeight - el.offsetHeight - EDGE_GUTTER;
    el.style.left = `${Math.max(EDGE_GUTTER, Math.min(menu.x, maxLeft))}px`;
    el.style.top = `${Math.max(EDGE_GUTTER, Math.min(menu.y, maxTop))}px`;
  }, [menu]);

  const portalTarget =
    (document.querySelector(".agw-root") as HTMLElement | null) ?? document.body;

  return createPortal(
    <div
      ref={menuRef}
      className="agw-menu agw-rail-menu"
      role="menu"
      style={{ position: "fixed", left: menu.x, top: menu.y, zIndex: 1000 }}
    >
      {menu.items.map((item) => (
        <React.Fragment key={item.label}>
          {item.separatorBefore && <div className="agw-rail-menu-separator" role="separator" />}
          <button
            type="button"
            role="menuitem"
            className="agw-menu-item agw-rail-menu-item"
            data-danger={item.danger || undefined}
            // Only visible in the case the label had to be truncated, which is
            // exactly when the row can no longer speak for itself.
            title={item.label}
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
