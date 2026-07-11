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
import { LeftRail } from "./LeftRail";
import { ConversationPane } from "./ConversationPane";
import { RightDock } from "./RightDock";
import { TeamScreen } from "./team/TeamScreen";
import { useAgentUiStore } from "../store/useAgentUiStore";
import { useAgentWorkspaceStore } from "../store/useAgentWorkspaceStore";
import { useAgentThemeStore } from "../store/useAgentThemeStore";
import { useAgentFsWatch } from "../hooks/useAgentFsWatch";
import { useAgentBrowserOpen } from "../hooks/useAgentBrowserOpen";

// Percent-of-shell clamps (mirror the old Panel min/max sizes).
const RAIL_MIN = 14;
const RAIL_MAX = 28;
const DOCK_MIN = 22;
const DOCK_MAX = 85;
const EXPANDED_DOCK = 72;

export const AgentShell: React.FC = () => {
  // Keep the Files tree + @-mention index live with on-disk changes.
  useAgentFsWatch();
  // Reveal the right-rail Browser panel when a browser_* tool asks for it.
  useAgentBrowserOpen();

  const centerView = useAgentUiStore((s) => s.centerView);

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

  const effectiveDockWidth = expanded ? EXPANDED_DOCK : dockWidth;
  // Inner (content) pixel widths — constant during an open/close glide, so the
  // content never reflows; they only change when the stored size or window does.
  const railPx = Math.round((railWidth / 100) * shellW);
  const dockPx = Math.round((effectiveDockWidth / 100) * shellW);

  // Mount content on open; keep it mounted through the close animation, then
  // drop it (so a closed dock doesn't retain a code view / native webview).
  const [railMounted, setRailMounted] = useState(railOpen);
  const [dockMounted, setDockMounted] = useState(dockOpen);
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

  const startDrag = useCallback(
    (which: "rail" | "dock") => (e: React.PointerEvent) => {
      if (which === "dock" && expanded) return; // dock size pinned in expand mode
      e.preventDefault();
      const shell = shellRef.current;
      if (!shell) return;
      const shellWidth = shell.getBoundingClientRect().width || 1;
      const startX = e.clientX;
      // Read live from the store so mid-flight state changes don't stale-close.
      const startPct =
        which === "rail"
          ? useAgentWorkspaceStore.getState().railWidth
          : useAgentWorkspaceStore.getState().dockWidth;

      shell.setAttribute("data-agw-dragging", "true");

      const onMove = (ev: PointerEvent) => {
        const dxPct = ((ev.clientX - startX) / shellWidth) * 100;
        if (which === "rail") {
          setRailWidth(Math.min(RAIL_MAX, Math.max(RAIL_MIN, startPct + dxPct)));
        } else {
          // Dock sits on the right; drag its left handle leftward to widen.
          setDockWidth(Math.min(DOCK_MAX, Math.max(DOCK_MIN, startPct - dxPct)));
        }
      };
      const onUp = () => {
        shell.removeAttribute("data-agw-dragging");
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [expanded, setRailWidth, setDockWidth],
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
        style={{ width: railOpen ? `${railWidth}%` : 0 }}
        aria-hidden={!railOpen}
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
          onPointerDown={startDrag("rail")}
        />
      )}

      {/* Center conversation — takes the remaining space. Plain block wrapper
          (NOT display:flex) so the child `.agw-zone` fills its full width; a
          flex-row wrapper would let the zone shrink to its content and pin the
          conversation to the left. */}
      <div style={{ flex: 1, minWidth: 0, minHeight: 0 }}>
        {centerView === "team" ? <TeamScreen /> : <ConversationPane />}
      </div>

      {/* Right dock — mirror of the rail, pinned to the right edge. */}
      {dockOpen && (
        <div
          className="agw-shell-handle"
          role="separator"
          aria-orientation="vertical"
          onPointerDown={startDrag("dock")}
        />
      )}
      <div
        className="agw-shell-side"
        style={{ width: dockOpen ? `${effectiveDockWidth}%` : 0 }}
        aria-hidden={!dockOpen}
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
