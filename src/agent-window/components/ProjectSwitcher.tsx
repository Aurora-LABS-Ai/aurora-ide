/**
 * Agent Window — home screen project switcher [view].
 *
 * The row above the composer naming the workspace this window acts on. It used
 * to be a static label whose spaced-slash path (`… / Users / Alvan / Documents`)
 * read as a breadcrumb — it looked pressable and did nothing. Rather than
 * removing the signifier, this makes the promise true: the row is the control
 * for changing project, which is the thing someone looking at it wants to do.
 *
 * Ghost at rest so the home screen stays quiet; the chip surface and chevron
 * only appear on hover/focus.
 *
 * The list is ordered by `lib/project-order`, the same module the left rail
 * uses, so the two never disagree about which project comes first. Sort mode
 * and pins are read WHEN THE MENU OPENS rather than held in state — they are
 * rail preferences in localStorage that the rail can change at any time, and a
 * menu that renders fresh each time is always current by construction.
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { openFileDialog } from "../../lib/tauri";
import { AgentIcon } from "../shared/AgentIcon";
import { useAgentChatStore } from "../store/useAgentChatStore";
import {
  compactParentPath,
  folderName,
  loadPinnedProjects,
  loadProjectSort,
  orderProjects,
} from "../lib/project-order";

/**
 * Menu width, in logical px. One number for every project rather than a
 * measurement of the current one — wide enough for a typical name plus a
 * couple of path segments, narrow enough to stay a menu rather than a panel.
 */
const MENU_WIDTH = 420;

export const ProjectSwitcher: React.FC = () => {
  const projectRoot = useAgentChatStore((s) => s.projectRoot);
  const knownProjects = useAgentChatStore((s) => s.knownProjects);
  const allThreads = useAgentChatStore((s) => s.allThreads);
  const setProject = useAgentChatStore((s) => s.setProject);

  // The open menu holds its OWN snapshot of the project list. Taking it when
  // the menu opens (rather than deriving it every render) is what lets the rail
  // preferences be read fresh each time, and keeps the list from reordering
  // under the cursor if a background turn touches a thread mid-choice.
  const [menu, setMenu] = useState<{ projects: string[] } | null>(null);
  const [active, setActive] = useState(0);
  const open = menu !== null;
  const projects = menu?.projects ?? [];
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number; width: number } | null>(null);

  // Portal INTO `.agw-root`, not document.body: the `--agw-*` tokens are set
  // there, and a menu outside that subtree renders with no surface colour at
  // all. It also has to escape the home column's `overflow-y: auto`, which
  // would otherwise clip it. Same rule as `TaskIndicator`.
  const attachTrigger = useCallback((el: HTMLButtonElement | null) => {
    triggerRef.current = el;
    if (el) setPortalTarget((el.closest(".agw-root") as HTMLElement) ?? document.body);
  }, []);

  const place = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    // FIXED width, deliberately not derived from the trigger. The trigger is as
    // wide as the current project's name and path, so sizing the menu from it
    // let one arbitrary project decide how much room every other project got:
    // a long name produced a sprawling menu, a short one a cramped menu that
    // scrolled sideways and cut names mid-word. The list is its own object and
    // sizes to its own content budget.
    const width = Math.min(MENU_WIDTH, window.innerWidth - 16);
    // Centred under the trigger, clamped into the viewport.
    const ideal = rect.left + rect.width / 2 - width / 2;
    const left = Math.min(Math.max(8, ideal), window.innerWidth - width - 8);
    setPos({ top: rect.bottom + 6, left, width });
  }, []);

  // One row past the projects is "Add project…", so it is reachable by keyboard
  // like any other row rather than being a mouse-only afterthought.
  const rowCount = projects.length + 1;

  /**
   * Everything that happens on open, in one event handler.
   *
   * Deliberately not an effect: positioning and the initial highlight are both
   * state, and setting state from an effect body triggers a second render pass
   * for something already known at click time.
   */
  const openMenu = useCallback(() => {
    place();
    // Rail preferences are localStorage and the rail can change them at any
    // time, so they are read here rather than held — a menu built fresh on each
    // open is current by construction.
    const ordered = orderProjects({
      knownProjects,
      threads: allThreads,
      projectRoot,
      sortMode: loadProjectSort(),
      pinned: new Set(loadPinnedProjects()),
    });
    // Open ON the current project, so the first arrow press moves from where
    // you already are rather than from the top of a list you did not choose.
    const index = ordered.findIndex((root) => root === projectRoot);
    setActive(index >= 0 ? index : 0);
    setMenu({ projects: ordered });
  }, [place, knownProjects, allThreads, projectRoot]);

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

  const close = useCallback(() => {
    setMenu(null);
    triggerRef.current?.focus();
  }, []);

  const choose = useCallback(
    async (root: string) => {
      setMenu(null);
      if (root !== projectRoot) await setProject(root);
    },
    [projectRoot, setProject],
  );

  const addProject = useCallback(async () => {
    setMenu(null);
    try {
      const picked = await openFileDialog({ directory: true });
      const root = Array.isArray(picked) ? picked[0] : picked;
      if (typeof root === "string" && root.length > 0) await setProject(root);
    } catch (err) {
      console.error("[project-switcher] add project failed:", err);
    }
  }, [setProject]);

  // Pointerdown rather than click so dragging out of the menu still closes it,
  // and capture so a row inside cannot swallow the event first.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement;
      if (triggerRef.current?.contains(target)) return;
      if (target.closest?.(".agw-projmenu")) return;
      setMenu(null);
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
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((i) => (i + 1) % rowCount);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((i) => (i - 1 + rowCount) % rowCount);
      return;
    }
    if (event.key === "Home") {
      event.preventDefault();
      setActive(0);
      return;
    }
    if (event.key === "End") {
      event.preventDefault();
      setActive(rowCount - 1);
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (active === projects.length) void addProject();
      else if (projects[active]) void choose(projects[active]);
    }
  };

  if (!projectRoot) return null;

  const name = folderName(projectRoot);
  const parent = compactParentPath(projectRoot);

  return (
    <>
      <div className="agw-projsw-wrap">
        <button
          ref={attachTrigger}
          type="button"
          className="agw-projsw"
          data-open={open || undefined}
          title={projectRoot}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={`Project: ${name}. Change project`}
          onClick={() => (open ? setMenu(null) : openMenu())}
          onKeyDown={onTriggerKeyDown}
        >
          <AgentIcon name="folder" size={13} />
          <span className="agw-projsw-name">{name}</span>
          {parent && <span className="agw-projsw-path">{parent}</span>}
          <span className="agw-projsw-chev">
            <AgentIcon name="chevron-down" size={13} />
          </span>
        </button>
      </div>

      {open &&
        pos &&
        portalTarget &&
        createPortal(
          <div
            className="agw-projmenu"
            role="menu"
            aria-label="Switch project"
            tabIndex={-1}
            ref={(el) => el?.focus()}
            onKeyDown={onMenuKeyDown}
            style={{ top: pos.top, left: pos.left, width: pos.width }}
          >
            <div className="agw-projmenu-list agw-scroll">
              {projects.map((root, index) => {
                const current = root === projectRoot;
                return (
                  <button
                    key={root}
                    type="button"
                    role="menuitemradio"
                    aria-checked={current}
                    className="agw-projmenu-row"
                    data-active={index === active || undefined}
                    data-current={current || undefined}
                    title={root}
                    onMouseEnter={() => setActive(index)}
                    onClick={() => void choose(root)}
                  >
                    <AgentIcon name="folder" size={13} />
                    <span className="agw-projmenu-name">{folderName(root)}</span>
                    <span className="agw-projmenu-path">{compactParentPath(root)}</span>
                    {current && (
                      <span className="agw-projmenu-check">
                        <AgentIcon name="check" size={13} />
                      </span>
                    )}
                  </button>
                );
              })}
            </div>

            <button
              type="button"
              role="menuitem"
              className="agw-projmenu-row agw-projmenu-add"
              data-active={active === projects.length || undefined}
              onMouseEnter={() => setActive(projects.length)}
              onClick={() => void addProject()}
            >
              <AgentIcon name="plus" size={13} />
              <span className="agw-projmenu-name">Add project…</span>
            </button>
          </div>,
          portalTarget,
        )}
    </>
  );
};
