/**
 * Agent Window — 3-zone shell (view).
 *
 * Left rail (projects + chats) · center conversation · right tabbed dock.
 *
 * Layout is a plain flex row that we fully control (NOT react-resizable-panels,
 * whose mount/unmount snapped the layout and whose controlled collapse fought
 * any transition). The rail and dock are fixed-basis flex items whose OUTER
 * width animates between their stored size and 0 → open/close GLIDES.
 *
 * No-reflow slide: each panel's content lives in an absolutely-positioned INNER
 * wrapper pinned to the panel's outer edge (rail → left, dock → right) at a
 * FIXED pixel width (the panel's open width, measured from the shell). While the
 * outer width animates, the inner stays full width and is simply clipped by
 * `overflow: hidden` — so the content (code view, chat list) slides out instead
 * of rewrapping. Content is unmounted after the close animation so a closed dock
 * never keeps a heavy code view / native browser webview alive.
 *
 * Resize is a lightweight custom pointer-drag on the 1px handles (percent of the
 * shell, clamped), with the width transition disabled mid-drag so it tracks the
 * cursor 1:1.
 */

import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { inertWhen } from "@/kernel/lib/a11y/inert";
import { LeftRail } from "@/apps/agent/components/shell/LeftRail";
import { ConversationPane } from "@/apps/agent/components/conversation/ConversationPane";
import { RightDock } from "@/apps/agent/components/shell/RightDock";
import { useAgentWorkspaceStore } from "@/apps/agent/store/workspace/useAgentWorkspaceStore";
import { useAgentThemeStore } from "@/apps/agent/store/ui/useAgentThemeStore";
import { useAgentFsWatch } from "@/apps/agent/hooks/window/useAgentFsWatch";
import { useAgentBrowserOpen } from "@/apps/agent/hooks/useAgentBrowserOpen";
import { useAgentBrowserDrivingEvents } from "@/apps/agent/hooks/useAgentBrowserDrivingEvents";
import { subscribeToPlanChanges } from "@/apps/agent/store/artifacts/useAgentPlanStore";
import {
  subscribeToTodoChanges,
  useAgentTaskStore,
} from "@/apps/agent/store/tools/useAgentTaskStore";
import { useAgentChatStore } from "@/apps/agent/store/conversation/useAgentChatStore";

// Percent-of-shell clamps (mirror the old Panel min/max sizes).
const RAIL_MIN = 14;
const RAIL_MAX = 28;
const DOCK_MIN = 22;
const DOCK_MAX = 85;
const EXPANDED_DOCK = 72;
const CENTER_MIN_PX = 480;

interface ShellDrag {
  which: "rail" | "dock";
  pointerId: number;
  handle: HTMLDivElement;
  shell: HTMLDivElement;
  shellWidth: number;
  startX: number;
  startPct: number;
  maxPct: number;
}

export const AgentShell: React.FC = () => {
  // Keep the Files tree + @-mention index live with on-disk changes.
  useAgentFsWatch();
  // Reveal the right-rail Browser panel when a browser_* tool asks for it.
  useAgentBrowserOpen();
  // Track when a browser_* tool is driving that panel. Lives here, not in
  // BrowserPanel: the dock tab has to show it while another tab is on screen.
  useAgentBrowserDrivingEvents();


  const railOpen = useAgentWorkspaceStore((s) => s.railOpen);
  const railWidth = useAgentWorkspaceStore((s) => s.railWidth);
  const dockOpen = useAgentWorkspaceStore((s) => s.dockOpen);
  const dockWidth = useAgentWorkspaceStore((s) => s.dockWidth);
  const expanded = useAgentWorkspaceStore((s) => s.expanded);
  const setRailWidth = useAgentWorkspaceStore((s) => s.setRailWidth);
  const setDockWidth = useAgentWorkspaceStore((s) => s.setDockWidth);

  // Glide on/off + speed (Appearance settings). Applied as a CSS var the
  // panel `width` transition reads; 0ms = instant (no glide).
  const railGlide = useAgentThemeStore((s) => s.railGlide);
  const railGlideMs = useAgentThemeStore((s) => s.railGlideMs);

  const shellRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<ShellDrag | null>(null);
  const [shellW, setShellW] = useState(0);

  // Measure the shell so the inner wrappers can be sized in FIXED pixels
  // (= open panel width). Runs before paint and follows every window resize.
  useLayoutEffect(() => {
    const el = shellRef.current;
    if (!el) return;
    const measure = () => setShellW(el.getBoundingClientRect().width);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const currentThreadId = useAgentChatStore((s) => s.currentThreadId);

  const centerMinPct = shellW > 0 ? Math.min(100, (CENTER_MIN_PX / shellW) * 100) : 0;
  const railMaxForLayout =
    dockOpen && shellW > 0
      ? Math.min(RAIL_MAX, Math.max(RAIL_MIN, 100 - centerMinPct - DOCK_MIN))
      : RAIL_MAX;
  const effectiveRailWidth = Math.min(railWidth, railMaxForLayout);
  const dockMaxForLayout =
    shellW > 0
      ? Math.min(
          DOCK_MAX,
          Math.max(
            DOCK_MIN,
            100 - centerMinPct - (railOpen ? effectiveRailWidth : 0),
          ),
        )
      : DOCK_MAX;
  const effectiveDockWidth = Math.min(
    expanded ? EXPANDED_DOCK : dockWidth,
    dockMaxForLayout,
  );
  // Inner (content) pixel widths — constant during an open/close glide, so the
  // content never reflows; they only change when the stored size or window does.
  const railPx = Math.round((effectiveRailWidth / 100) * shellW);
  const dockPx = Math.round((effectiveDockWidth / 100) * shellW);

  // Mount content on open; keep it mounted through the close animation, then
  // drop it (so a closed dock doesn't retain a code view / native webview).
  const [railMounted, setRailMounted] = useState(railOpen);
  const [dockMounted, setDockMounted] = useState(dockOpen);

  // Plan events are subscribed at the SHELL, not in CanvasPanel. The Canvas is
  // a dock tab that only mounts once opened, so subscribing there could never
  // hear the event that is supposed to open it — a plan written while the tab
  // was closed simply never appeared.
  useEffect(() => {
    void subscribeToPlanChanges();
  }, []);
  // Same reasoning for the checklist: the task panel is a dock/popover surface,
  // and a turn running in another chat still has to move its own list.
  useEffect(() => {
    void subscribeToTodoChanges();
  }, []);
  // Cold start — the list lives on disk, so reopening a conversation shows the
  // progress the agent actually made rather than an empty panel.
  useEffect(() => {
    if (currentThreadId) void useAgentTaskStore.getState().hydrate(currentThreadId);
  }, [currentThreadId]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- mount content when the panel opens
    if (railOpen) setRailMounted(true);
  }, [railOpen]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- mount content when the panel opens
    if (dockOpen) setDockMounted(true);
  }, [dockOpen]);

  // With glide OFF (0ms) a width change fires NO `transitionend`, so the
  // `onTransitionEnd` unmount below never runs — the dock content (incl. the
  // native browser webview) would stay mounted/shown off-screen after a close.
  // Derive the mounted flag from the live open state in that case; when glide is
  // on we keep the state-backed flag so content survives the slide-out animation.
  const railContentMounted = railGlide ? railMounted : railOpen;
  const dockContentMounted = railGlide ? dockMounted : dockOpen;

  const finishDrag = useCallback((pointerId?: number) => {
    const drag = dragRef.current;
    if (!drag || (pointerId !== undefined && pointerId !== drag.pointerId)) return;
    dragRef.current = null;
    drag.shell.removeAttribute("data-agw-dragging");
    if (drag.handle.hasPointerCapture(drag.pointerId)) {
      drag.handle.releasePointerCapture(drag.pointerId);
    }
  }, []);

  useEffect(() => {
    const onBlur = () => finishDrag();
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("blur", onBlur);
      finishDrag();
    };
  }, [finishDrag]);

  const startDrag = useCallback(
    (which: "rail" | "dock") => (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0 || (which === "dock" && expanded)) return;
      const shell = shellRef.current;
      if (!shell) return;

      event.preventDefault();
      finishDrag();
      const shellWidth = shell.getBoundingClientRect().width || 1;
      dragRef.current = {
        which,
        pointerId: event.pointerId,
        handle: event.currentTarget,
        shell,
        shellWidth,
        startX: event.clientX,
        startPct: which === "rail" ? effectiveRailWidth : effectiveDockWidth,
        maxPct: which === "rail" ? railMaxForLayout : dockMaxForLayout,
      };
      shell.setAttribute("data-agw-dragging", "true");
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [
      dockMaxForLayout,
      effectiveDockWidth,
      effectiveRailWidth,
      expanded,
      finishDrag,
      railMaxForLayout,
    ],
  );

  const moveDrag = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (!drag || event.pointerId !== drag.pointerId) return;
      if ((event.buttons & 1) === 0) {
        finishDrag(event.pointerId);
        return;
      }

      const dxPct = ((event.clientX - drag.startX) / drag.shellWidth) * 100;
      if (drag.which === "rail") {
        setRailWidth(Math.min(drag.maxPct, Math.max(RAIL_MIN, drag.startPct + dxPct)));
      } else {
        setDockWidth(Math.min(drag.maxPct, Math.max(DOCK_MIN, drag.startPct - dxPct)));
      }
    },
    [finishDrag, setDockWidth, setRailWidth],
  );

  return (
    <div
      ref={shellRef}
      className="agw-shell-flex"
      style={{
        flex: 1,
        minHeight: 0,
        minWidth: 0,
        display: "flex",
        // Consumed by `.agw-shell-side { transition: width var(--agw-rail-anim) }`.
        ["--agw-rail-anim" as string]: railGlide ? `${railGlideMs}ms` : "0ms",
      } as React.CSSProperties}
    >
      {/* Left rail — outer width glides to 0; inner stays fixed-width, clipped. */}
      <div
        className="agw-shell-side"
        style={{ width: railOpen ? `${effectiveRailWidth}%` : 0 }}
        // `inert`, not `aria-hidden`: the rail is width-0 but still mounted, so
        // aria-hidden left every rail button in the tab order, and Chromium
        // refused to apply it outright ("Blocked aria-hidden on an element
        // because its descendant retained focus") whenever the rail was
        // collapsed while focus sat inside it.
        {...inertWhen(!railOpen)}
        onTransitionEnd={(e) => {
          if (e.propertyName === "width" && !railOpen) setRailMounted(false);
        }}
      >
        {railContentMounted && (
          <div
            className="agw-shell-side-inner agw-shell-side-left"
            style={{ width: railPx || undefined }}
          >
            <LeftRail />
          </div>
        )}
      </div>
      {railOpen && (
        <div
          className="agw-shell-handle"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize conversation and navigation"
          onPointerDown={startDrag("rail")}
          onPointerMove={moveDrag}
          onPointerUp={(event) => finishDrag(event.pointerId)}
          onPointerCancel={(event) => finishDrag(event.pointerId)}
          onLostPointerCapture={(event) => finishDrag(event.pointerId)}
        />
      )}

      {/* Center conversation — takes the remaining space. Plain block wrappers
          (NOT display:flex) so the child `.agw-zone` fills its full width; a
          flex-row wrapper would let the zone shrink to its content and pin the
          conversation to the left.
          Two-layer shell: the FRAME (gutter padding, canvas shows through)
          holds the recessed content SHEET (rounded, hairline border). */}
      <div className="agw-center-frame">
        <div className="agw-center-sheet">
          <ConversationPane />
        </div>
      </div>

      {/* Right dock — mirror of the rail, pinned to the right edge. */}
      {dockOpen && (
        <div
          className="agw-shell-handle"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize conversation and right panel"
          onPointerDown={startDrag("dock")}
          onPointerMove={moveDrag}
          onPointerUp={(event) => finishDrag(event.pointerId)}
          onPointerCancel={(event) => finishDrag(event.pointerId)}
          onLostPointerCapture={(event) => finishDrag(event.pointerId)}
        />
      )}
      <div
        className="agw-shell-side"
        style={{ width: dockOpen ? `${effectiveDockWidth}%` : 0 }}
        // Same as the left rail above.
        {...inertWhen(!dockOpen)}
        onTransitionEnd={(e) => {
          if (e.propertyName === "width" && !dockOpen) setDockMounted(false);
        }}
      >
        {dockContentMounted && (
          <div
            className="agw-shell-side-inner agw-shell-side-right"
            style={{ width: dockPx || undefined }}
          >
            <RightDock />
          </div>
        )}
      </div>
    </div>
  );
};
