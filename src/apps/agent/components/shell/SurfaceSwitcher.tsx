/**
 * Agent Window — the product switcher [view].
 *
 * The control at the top of the left rail that says which of Aurora's two
 * products the window is showing, and swaps between them:
 *
 *   Aurora Chat   — ask, research, and think
 *   Aurora Build  — build end-to-end full stack applications
 *
 * A switcher rather than a mode chip in the composer, because these are not two
 * settings of one thing. They have different tool rosters, different system
 * prompts, and different conversation stores on disk. Flipping it is walking
 * into another room, and it should read like one.
 *
 * Chrome is the PROJECT SWITCHER's, class for class — same `.agw-projmenu`
 * surface, same rows, same portal-into-`.agw-root` trick, same keyboard
 * contract. Two menus that open from the same rail and behave differently is
 * the seam that makes an app feel assembled. What it does NOT copy is the
 * filter field: that menu lists dozens of projects, this one has two rows, and
 * a search box over two rows is furniture. (Same reasoning `ComposerPlusMenu`
 * records for its own four.)
 *
 * Switching does not convert the conversation on screen — a conversation's
 * product is its address on disk. `useAgentChatStore` restores whichever
 * conversation that side was left on, or its empty state.
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { AgentIcon, type AgentIconName } from "@/apps/agent/shared/AgentIcon";
import { useAgentChatStore } from "@/apps/agent/store/conversation/useAgentChatStore";
import { useAgentSettingsStore } from "@/apps/agent/store/settings/useAgentSettingsStore";
import {
  AURORA_SURFACES,
  type AuroraSurface,
} from "@/apps/agent/services/runtime/agent-execution-mode";

/**
 * Menu width, in logical px. Fixed rather than measured from the trigger: the
 * trigger is as wide as the current product's name, so sizing from it would let
 * "Aurora Chat" and "Aurora Build" produce two different menus for the same two
 * rows. Same rule, same reason, as `ProjectSwitcher`.
 */
const MENU_WIDTH = 300;

/** Both names exist in `AgentIcon`'s union — there is no fallback glyph. */
const SURFACE_ICON: Record<AuroraSurface, AgentIconName> = {
  chat: "chat",
  // `layers` rather than `terminal` or `files`: Build is the whole stack, not
  // the shell or the file tree, and those two glyphs are already spoken for by
  // the dock's Terminal and Files tabs.
  build: "layers",
};

export const SurfaceSwitcher: React.FC = () => {
  const surface = useAgentSettingsStore((s) => s.auroraSurface);
  // `enterSurface` rather than `setAuroraSurface`: flipping the setting alone
  // would leave the rail listing the other store's conversations and the open
  // transcript belonging to a product the window is no longer showing.
  const enterSurface = useAgentChatStore((s) => s.enterSurface);

  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number; width: number } | null>(null);

  // Portal INTO `.agw-root`, not document.body: the `--agw-*` tokens are set
  // there, and a menu outside that subtree renders with no surface colour at
  // all. It also escapes the rail's own `overflow`, which would clip it.
  const attachTrigger = useCallback((el: HTMLButtonElement | null) => {
    triggerRef.current = el;
    if (el) setPortalTarget((el.closest(".agw-root") as HTMLElement) ?? document.body);
  }, []);

  const place = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const width = Math.min(MENU_WIDTH, window.innerWidth - 16);
    // Left-aligned to the trigger rather than centred: the trigger sits at the
    // rail's left edge, so a centred menu would hang off the window.
    const left = Math.min(Math.max(8, rect.left), window.innerWidth - width - 8);
    setPos({ top: rect.bottom + 6, left, width });
  }, []);

  const openMenu = useCallback(() => {
    place();
    // Open ON the current product, so the first arrow press moves from where
    // you already are rather than from the top of a list you did not choose.
    const index = AURORA_SURFACES.findIndex((entry) => entry.id === surface);
    setActive(index >= 0 ? index : 0);
    setOpen(true);
  }, [place, surface]);

  const close = useCallback(() => {
    setOpen(false);
    triggerRef.current?.focus();
  }, []);

  const choose = useCallback(
    (next: AuroraSurface) => {
      setOpen(false);
      if (next !== surface) void enterSurface(next);
    },
    [surface, enterSurface],
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

  // Pointerdown rather than click so dragging out of the menu still closes it,
  // and capture so a row inside cannot swallow the event first.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement;
      if (triggerRef.current?.contains(target)) return;
      if (target.closest?.(".agw-surfacemenu")) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [open]);

  const onTriggerKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      openMenu();
    }
  };

  const onMenuKeyDown = (event: React.KeyboardEvent) => {
    const count = AURORA_SURFACES.length;
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((i) => (i + 1) % count);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((i) => (i - 1 + count) % count);
      return;
    }
    if (event.key === "Home") {
      event.preventDefault();
      setActive(0);
      return;
    }
    if (event.key === "End") {
      event.preventDefault();
      setActive(count - 1);
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      const picked = AURORA_SURFACES[active];
      if (picked) choose(picked.id);
    }
  };

  const current =
    AURORA_SURFACES.find((entry) => entry.id === surface) ?? AURORA_SURFACES[1];

  return (
    <>
      <div className="agw-surfacesw-wrap">
        <button
          ref={attachTrigger}
          type="button"
          className="agw-surfacesw"
          data-open={open || undefined}
          data-surface={surface}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={`${current.name}. Switch product`}
          title={current.tagline}
          onClick={() => (open ? setOpen(false) : openMenu())}
          onKeyDown={onTriggerKeyDown}
        >
          <AgentIcon name={SURFACE_ICON[current.id]} size={14} />
          <span className="agw-surfacesw-name">{current.name}</span>
          <span className="agw-surfacesw-chev">
            <AgentIcon name="chevron-down" size={13} />
          </span>
        </button>
      </div>

      {open &&
        pos &&
        portalTarget &&
        createPortal(
          <div
            className="agw-projmenu agw-surfacemenu"
            role="menu"
            aria-label="Switch product"
            tabIndex={-1}
            autoFocus
            onKeyDown={onMenuKeyDown}
            style={{ top: pos.top, left: pos.left, width: pos.width }}
          >
            <div className="agw-projmenu-list">
              {AURORA_SURFACES.map((entry, index) => {
                const isCurrent = entry.id === surface;
                return (
                  <button
                    key={entry.id}
                    type="button"
                    role="menuitemradio"
                    aria-checked={isCurrent}
                    className="agw-projmenu-row agw-surfacemenu-row"
                    data-active={index === active || undefined}
                    data-current={isCurrent || undefined}
                    onMouseEnter={() => setActive(index)}
                    onClick={() => choose(entry.id)}
                  >
                    <AgentIcon name={SURFACE_ICON[entry.id]} size={14} />
                    <span className="agw-surfacemenu-text">
                      <span className="agw-projmenu-name">{entry.name}</span>
                      <span className="agw-surfacemenu-tagline">{entry.tagline}</span>
                    </span>
                    {isCurrent && (
                      <span className="agw-projmenu-check">
                        <AgentIcon name="check" size={13} />
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>,
          portalTarget,
        )}
    </>
  );
};

export default SurfaceSwitcher;
