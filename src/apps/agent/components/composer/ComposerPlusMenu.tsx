/**
 * Agent Window — the composer's `+` menu [view].
 *
 * `+` used to go straight to the OS file picker, which named ONE of the four
 * things you can add to a message and hid the other three behind characters you
 * had to already know (`@`, `/`) or a dock tab you had to already find. The
 * button now opens the list of ways to add context, and the file picker is the
 * first row of it.
 *
 * Chrome is deliberately the PROJECT SWITCHER's, class for class — same
 * `.agw-projmenu` surface, same rows, same portal-into-`.agw-root` trick, same
 * keyboard contract. Two menus that open from the same screen and behave
 * differently is the kind of seam that makes an app feel assembled. What it
 * does NOT copy is the filter box: that menu lists dozens of projects, this one
 * lists four fixed rows, and a search field over four rows is furniture.
 *
 * Direction is DERIVED, not passed in. On the home screen the composer is
 * centred with the whole lower half free, so the menu drops down from the
 * button like any other menu; in a conversation the composer sits on the floor
 * and the same menu would open off-screen, so it grows upward instead. Asking
 * the caller which one it is would encode "empty state" as geometry in two
 * places and still be wrong the moment someone shortens the window — measuring
 * the room below the trigger produces the same two behaviours and keeps
 * producing them at every size.
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { AgentIcon, type AgentIconName } from "@/apps/agent/shared/AgentIcon";

export interface PlusMenuItem {
  id: string;
  label: string;
  /** One short line under the label — what this row actually does. */
  hint: string;
  icon: AgentIconName;
  run: () => void;
}

/**
 * Menu width in logical px. Fixed for the same reason the project menu's is:
 * sizing to the trigger would let a 28px icon button decide how much room four
 * labels and their hints get.
 */
const MENU_WIDTH = 268;

/**
 * Enough to decide which way to open, without waiting for a measurement.
 *
 * The menu's content is fixed — a group label and N two-line rows — so its
 * height is genuinely predictable, and predicting it is what lets the first
 * paint land in the right place. Measuring after mount would flip the menu on
 * the frame after it appeared, which is the jump this avoids. Both anchors
 * (`top` for down, `bottom` for up) are exact edges, so the estimate only ever
 * decides the DIRECTION — it never positions anything.
 */
const ROW_HEIGHT = 46;
const HEAD_HEIGHT = 25;
const MENU_PADDING = 8;
const GAP = 8;

export const ComposerPlusMenu: React.FC<{ items: PlusMenuItem[] }> = ({ items }) => {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);
  const [pos, setPos] = useState<{
    left: number;
    width: number;
    /** Exactly one is set — `top` opens downward, `bottom` opens upward. */
    top?: number;
    bottom?: number;
    place: "up" | "down";
  } | null>(null);

  // Portal into `.agw-root`, not document.body: the `--agw-*` tokens live
  // there, and a menu mounted outside that subtree renders with no surface
  // colour at all. It also escapes the composer's own stacking context, which
  // deliberately sits BEHIND the `@`/`/` pickers and would bury this too.
  const attachTrigger = useCallback((el: HTMLButtonElement | null) => {
    triggerRef.current = el;
    if (el) setPortalTarget((el.closest(".agw-root") as HTMLElement) ?? document.body);
  }, []);

  const place = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const width = Math.min(MENU_WIDTH, window.innerWidth - 16);
    // Left-aligned to the trigger (it is the leftmost control in the action
    // row, so there is always room), then clamped into the viewport.
    const left = Math.min(Math.max(8, rect.left), window.innerWidth - width - 8);

    const needed = HEAD_HEIGHT + items.length * ROW_HEIGHT + MENU_PADDING;
    const roomBelow = window.innerHeight - rect.bottom - GAP;
    // Down by default — a menu belongs under the thing that opened it. Up only
    // when there is genuinely nowhere to put it, which on this screen means the
    // composer is parked on the floor of a live conversation.
    if (roomBelow >= needed) {
      setPos({ top: rect.bottom + GAP, left, width, place: "down" });
    } else {
      setPos({ bottom: window.innerHeight - rect.top + GAP, left, width, place: "up" });
    }
  }, [items.length]);

  const openMenu = useCallback(() => {
    place();
    setActive(0);
    setOpen(true);
  }, [place]);

  const close = useCallback(() => {
    setOpen(false);
    triggerRef.current?.focus();
  }, []);

  const choose = useCallback(
    (index: number) => {
      const item = items[index];
      if (!item) return;
      // Close FIRST. Every row hands focus somewhere else — the editor's caret,
      // an OS dialog, the dock — and a menu still on screen would either steal
      // that focus back or sit over the thing it just opened.
      setOpen(false);
      item.run();
    },
    [items],
  );

  useEffect(() => {
    if (!open) return;
    const onMove = () => place();
    window.addEventListener("scroll", onMove, true);
    window.addEventListener("resize", onMove);
    return () => {
      window.removeEventListener("scroll", onMove, true);
      window.removeEventListener("resize", onMove);
    };
  }, [open, place]);

  // Pointerdown rather than click so dragging out of the menu closes it, and
  // capture so a row inside cannot swallow the event first.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement;
      if (triggerRef.current?.contains(target)) return;
      if (target.closest?.(".agw-plusmenu")) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [open]);

  const onMenuKeyDown = (event: React.KeyboardEvent) => {
    const count = items.length;
    if (count === 0) return;
    if (event.key === "Escape") {
      event.preventDefault();
      close();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((i) => (i + 1) % count);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((i) => (i - 1 + count) % count);
    } else if (event.key === "Home") {
      event.preventDefault();
      setActive(0);
    } else if (event.key === "End") {
      event.preventDefault();
      setActive(count - 1);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      choose(active);
    }
  };

  return (
    <>
      <button
        ref={attachTrigger}
        type="button"
        className="agw-icon-btn"
        data-open={open || undefined}
        title="Add context"
        aria-label="Add context"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          if (open) setOpen(false);
          else openMenu();
        }}
        onKeyDown={(event) => {
          // Either arrow opens it — which way it grows is the menu's business,
          // not something the user should have to predict before pressing.
          if (event.key === "ArrowUp" || event.key === "ArrowDown") {
            event.preventDefault();
            openMenu();
          }
        }}
      >
        <AgentIcon name="plus" size={17} />
      </button>

      {open &&
        pos &&
        portalTarget &&
        createPortal(
          <div
            className="agw-projmenu agw-plusmenu"
            // Drives which way the entrance slides — a menu that grows upward
            // must arrive from below, or the motion contradicts the placement.
            data-place={pos.place}
            role="menu"
            aria-label="Add context"
            tabIndex={-1}
            // The menu itself takes focus — there is no filter field to hold it
            // the way the project menu does, and a menu nobody focuses cannot
            // be driven by the keyboard at all.
            autoFocus
            ref={(el) => el?.focus()}
            onKeyDown={onMenuKeyDown}
            style={{ top: pos.top, bottom: pos.bottom, left: pos.left, width: pos.width }}
          >
            <div className="agw-plusmenu-head">Add context</div>
            {items.map((item, index) => (
              <button
                key={item.id}
                type="button"
                role="menuitem"
                className="agw-projmenu-row agw-plusmenu-row"
                data-active={index === active || undefined}
                onMouseEnter={() => setActive(index)}
                onClick={() => choose(index)}
              >
                <AgentIcon name={item.icon} size={14} />
                <span className="agw-plusmenu-text">
                  <span className="agw-projmenu-name">{item.label}</span>
                  <span className="agw-plusmenu-hint">{item.hint}</span>
                </span>
              </button>
            ))}
          </div>,
          portalTarget,
        )}
    </>
  );
};
