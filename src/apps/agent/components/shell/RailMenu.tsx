/**
 * Agent Window — right-click context menu [shared view].
 *
 * The standard surface for row actions anywhere in the window — chat rows and
 * project headers in the left rail, file rows in the Files tab. One component
 * so every right-click in the agent window opens the identical menu: same
 * width, same row height, same separators, same close behavior.
 *
 * An item may carry `children`: it then draws a chevron and opens a second
 * list beside it on hover, focus or ArrowRight (Open in ›, Move to ›, Model ›).
 *
 * ## Every list is its own layer
 *
 * The menu scrolls inside itself when it is taller than the window
 * (`.agw-rail-menu`), so it is an overflow box — and an overflow box clips
 * and scrolls whatever is laid out inside it. The first flyout was rendered
 * as a child of its parent row, inside that box: opening Move to › drew the
 * list past the menu's right edge, the menu grew a horizontal scrollbar to
 * reach it, and the horizontal bar ate the height the rows needed, so a
 * vertical bar appeared too (Alvan, 2026-10-19: "where the hell is it going").
 *
 * So a flyout is never inside the menu. It is portaled beside it as a
 * sibling, `position: fixed`, placed from its parent row's measured rect and
 * clamped to the window the way the menu is placed from the click. The
 * outside-press and keyboard handlers find menu rows by `data-agw-rail-menu`
 * on each list, not by DOM containment, which is what lets a layer that is
 * not a descendant still count as "inside the menu" (same convention as
 * `data-agw-portal-child` for the composer's portaled popovers).
 *
 * Portaled into the window root so the owning panel's scroll/overflow can't
 * clip it; closes on outside press, Escape, scroll, resize, or after any pick.
 */

import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { AgentIcon, type AgentIconName } from "@/apps/agent/shared/AgentIcon";

export interface RailMenuItem {
  icon: AgentIconName;
  label: string;
  danger?: boolean;
  separatorBefore?: boolean;
  /** Drawn with a check at the right: the choice in force (a model, a project). */
  checked?: boolean;
  /** A quiet word after the label: the provider a model comes from. */
  meta?: string;
  /** Greyed and inert, with the row still there so the option is known to exist. */
  disabled?: boolean;
  /** A flyout of further items; `onSelect` is then ignored. */
  children?: RailMenuItem[];
  onSelect?: () => void;
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

/** Marks every list of this menu, top level and flyouts alike. */
const LIST_MARK = "data-agw-rail-menu";

/** The window root every layer is portaled into. */
function portalTarget(): HTMLElement {
  return (document.querySelector(".agw-root") as HTMLElement | null) ?? document.body;
}

/** Is `node` inside any list of the open menu, whichever layer it is in? */
function insideMenu(node: Node | null): boolean {
  return node instanceof Element ? !!node.closest(`[${LIST_MARK}]`) : false;
}

/** One list of rows; a flyout is this same component one layer over. */
const MenuList: React.FC<{
  items: RailMenuItem[];
  onClose: () => void;
  /** The parent row's button, for ArrowLeft to return focus to. A getter:
   *  read in the key handler, never during render. */
  parentRow?: () => HTMLButtonElement | null;
  onCloseFlyout?: () => void;
}> = ({ items, onClose, parentRow, onCloseFlyout }) => {
  const [openSub, setOpenSub] = useState<string | null>(null);
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());

  return (
    <>
      {items.map((item) => {
        const hasChildren = !!item.children && item.children.length > 0;
        const subOpen = hasChildren && openSub === item.label;
        return (
          <React.Fragment key={item.label}>
            {item.separatorBefore && <div className="agw-rail-menu-separator" role="separator" />}
            <button
              ref={(el) => {
                if (el) rowRefs.current.set(item.label, el);
                else rowRefs.current.delete(item.label);
              }}
              type="button"
              role="menuitem"
              className="agw-menu-item agw-rail-menu-item"
              data-danger={item.danger || undefined}
              data-open={subOpen || undefined}
              aria-haspopup={hasChildren ? "menu" : undefined}
              aria-expanded={hasChildren ? subOpen : undefined}
              disabled={item.disabled}
              // Only visible in the case the label had to be truncated, which is
              // exactly when the row can no longer speak for itself.
              title={item.label}
              onMouseEnter={() => setOpenSub(hasChildren ? item.label : null)}
              onClick={() => {
                if (hasChildren) {
                  setOpenSub(subOpen ? null : item.label);
                  return;
                }
                onClose();
                item.onSelect?.();
              }}
              // Focus alone does not open a flyout: arrowing down the list
              // would pop one on every row that has children, and ArrowLeft
              // (close, return focus) would reopen it on landing. Hover,
              // click, Enter and ArrowRight open; nothing else does.
              onKeyDown={(event) => {
                if (hasChildren && event.key === "ArrowRight") {
                  event.preventDefault();
                  event.stopPropagation();
                  setOpenSub(item.label);
                  // The flyout mounts on this state; focus its first row once it has.
                  // Matched on the attribute value in JS rather than in a selector,
                  // so a label with quotes or brackets needs no escaping.
                  window.requestAnimationFrame(() => {
                    const flyout = Array.from(
                      document.querySelectorAll<HTMLElement>(`[${LIST_MARK}="flyout"]`),
                    ).find((el) => el.dataset.parent === item.label);
                    flyout?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
                  });
                } else if (parentRow && event.key === "ArrowLeft") {
                  const parent = parentRow();
                  if (!parent) return;
                  event.preventDefault();
                  event.stopPropagation();
                  onCloseFlyout?.();
                  parent.focus();
                }
              }}
            >
              <AgentIcon name={item.icon} size={14} />
              <span>{item.label}</span>
              {item.meta && <span className="agw-rail-menu-meta">{item.meta}</span>}
              {item.checked && <AgentIcon name="check" size={13} className="agw-rail-menu-check" />}
              {hasChildren && (
                <AgentIcon name="chevron-right" size={13} className="agw-rail-menu-more" />
              )}
            </button>
            {subOpen && item.children && (
              <Flyout parentLabel={item.label} parentRow={() => rowRefs.current.get(item.label) ?? null}>
                <MenuList
                  items={item.children}
                  onClose={onClose}
                  parentRow={() => rowRefs.current.get(item.label) ?? null}
                  onCloseFlyout={() => setOpenSub(null)}
                />
              </Flyout>
            )}
          </React.Fragment>
        );
      })}
    </>
  );
};

/**
 * The child list, as its own fixed layer beside its parent row. Opens to the
 * right of the row; flips to its left when the right edge would leave the
 * window; slides up when the bottom would. Measured after layout, like the
 * menu itself.
 */
const Flyout: React.FC<{
  parentLabel: string;
  parentRow: () => HTMLButtonElement | null;
  children: React.ReactNode;
}> = ({ parentLabel, parentRow, children }) => {
  const ref = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    const row = parentRow();
    if (!el || !row) return;
    const rect = row.getBoundingClientRect();
    // Overlap the parent by the menu's padding so the two read as one surface.
    let left = rect.right + 2;
    let top = rect.top - 6;
    if (left + el.offsetWidth > window.innerWidth - EDGE_GUTTER) {
      left = rect.left - el.offsetWidth - 2;
    }
    const maxTop = window.innerHeight - el.offsetHeight - EDGE_GUTTER;
    top = Math.max(EDGE_GUTTER, Math.min(top, maxTop));
    el.style.left = `${Math.max(EDGE_GUTTER, left)}px`;
    el.style.top = `${top}px`;
  }, [parentRow]);
  return createPortal(
    <div
      ref={ref}
      className="agw-menu agw-rail-menu agw-rail-submenu"
      role="menu"
      {...{ [LIST_MARK]: "flyout" }}
      data-parent={parentLabel}
      style={{ position: "fixed", left: 0, top: 0 }}
    >
      {children}
    </div>,
    portalTarget(),
  );
};

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
      if (insideMenu(document.activeElement) && anchor?.isConnected) anchor.focus();
    };
  }, [anchor]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault(); event.stopPropagation();
        anchor?.focus(); onClose();
      }
      const active = document.activeElement;
      if (!insideMenu(active)) return;
      if (event.key === "Tab") { onClose(); return; }
      if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        event.preventDefault(); event.stopPropagation();
        // Move within the list the focused row belongs to — the flyout when
        // one is open and focused, otherwise the top level.
        const list = (active as Element).closest<HTMLElement>(`[${LIST_MARK}]`) ?? menuRef.current;
        if (!list) return;
        const items = Array.from(list.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')).filter(
          (el) => el.closest(`[${LIST_MARK}]`) === list && !el.disabled,
        );
        const current = items.indexOf(active as HTMLButtonElement);
        const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
        items[next]?.focus();
      }
    };
    const onPointerDown = (event: PointerEvent) => {
      // A press in any layer of this menu is inside it; a flyout is not a
      // DOM descendant of the top level, so containment alone would close
      // the menu the moment you clicked a project under Move to.
      if (insideMenu(event.target as Node)) return;
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
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (insideMenu(target)) return;
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

  return createPortal(
    <div
      ref={menuRef}
      className="agw-menu agw-rail-menu"
      role="menu"
      {...{ [LIST_MARK]: "root" }}
      style={{ position: "fixed", left: menu.x, top: menu.y }}
    >
      <MenuList items={menu.items} onClose={onClose} />
    </div>,
    portalTarget(),
  );
};
