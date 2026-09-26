/**
 * Agent Window — Browser tab [view].
 *
 * Hosts the AGENT'S real browser inside the dock: `browser_runtime` builds its
 * webview as a child of the agent window (embedded), so the SAME pipeline the
 * agent tools use — navigate, screenshot, DOM, and crucially the element
 * INSPECTOR — works here, in-tab. The toolbar (React DOM) sits above; the page
 * renders natively in the body region.
 *
 * Inspector picks arrive on the global `aurora:element-picked` event; we drop a
 * concise reference into the composer via `agw:compose-insert`. The webview is
 * bounds-synced on layout changes and closed on tab close. Whether it is on
 * screen is decided in one place, `services/browser/browser-visibility.ts`:
 * this panel only reports that it mounted or unmounted, and overlays hold it
 * hidden.
 */

import React, { useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";

import { AgentIcon } from "@/apps/agent/shared/AgentIcon";
import { isAuroraRuntimeAvailable } from "@/kernel/lib/ipc/runtime";
import { useAgentSelectionStore } from "@/apps/agent/store/composer/useAgentSelectionStore";
import {
  AGENT_BROWSER_LABEL,
  holdBrowserHidden,
  reassertBrowserVisibility,
  setBrowserPanelMounted,
} from "@/apps/agent/services/browser/browser-visibility";
import { DEV_SERVERS, useAgentBrowserHistory } from "@/apps/agent/store/workspace/useAgentBrowserHistory";
import { drivingLabel, useAgentBrowserDriving } from "@/apps/agent/store/workspace/useAgentBrowserDriving";
import {
  activateInspector,
  createBrowserWindow,
  deactivateInspector,
  evalBrowser,
  getBrowserUrl,
  listBrowserWindows,
  navigateBrowser,
  onPickedElement,
  refreshBrowser,
  setBrowserBounds,
  type PickedElement,
} from "@/apps/agent/services/browser/browser-service";

const LABEL = AGENT_BROWSER_LABEL;
const HOST = "agent-window";

/**
 * Bounds updates, serialised.
 *
 * A rail drag fires a ResizeObserver callback per frame, and each used to
 * fire its own `browser_set_bounds` IPC call. Those calls are independent
 * async round trips with no ordering guarantee, so under a fast drag an
 * EARLIER (larger) rectangle could land after a LATER (smaller) one and stay
 * — the "I dragged the rail smaller and the browser stayed larger" report,
 * intermittent because it needs two calls to cross. One in-flight call at a
 * time, always followed by the newest rectangle, makes the last measurement
 * the one that wins.
 */
type Bounds = { x: number; y: number; width: number; height: number };
let boundsPending: Bounds | null = null;
let boundsInFlight = false;
let boundsApplied: Bounds | null = null;

function sameBounds(a: Bounds | null, b: Bounds): boolean {
  return (
    !!a &&
    Math.round(a.x) === Math.round(b.x) &&
    Math.round(a.y) === Math.round(b.y) &&
    Math.round(a.width) === Math.round(b.width) &&
    Math.round(a.height) === Math.round(b.height)
  );
}

function syncBounds(next: Bounds): void {
  if (!boundsInFlight && sameBounds(boundsApplied, next)) return;
  boundsPending = next;
  if (boundsInFlight) return;
  boundsInFlight = true;
  void (async () => {
    try {
      while (boundsPending) {
        const b = boundsPending;
        boundsPending = null;
        try {
          await setBrowserBounds(LABEL, b.x, b.y, b.width, b.height);
          boundsApplied = b;
        } catch {
          // The webview is gone or not built yet; the next mount re-syncs.
          boundsApplied = null;
        }
      }
    } finally {
      boundsInFlight = false;
    }
  })();
}

/** Address-bar normalization: scheme as-is, bare host → https, else web search. */
function normalizeAddress(input: string): string {
  const t = input.trim();
  if (!t) return "about:blank";
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t) || t.startsWith("about:")) return t;
  if (/^[^\s]+\.[^\s]{2,}(\/.*)?$/.test(t)) return `https://${t}`;
  return `https://www.google.com/search?q=${encodeURIComponent(t)}`;
}

/** Tear down the embedded browser (called when the Browser tab is closed). */
// eslint-disable-next-line react-refresh/only-export-components -- co-located webview lifecycle helper
export async function closeAgentBrowser(): Promise<void> {
  boundsApplied = null;
  boundsPending = null;
  const { closeBrowserWindow } = await import("@/apps/agent/services/browser/browser-service");
  try {
    await closeBrowserWindow(LABEL);
  } catch {
    /* not open */
  }
}

export const BrowserPanel: React.FC = () => {
  const bodyRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const focusedRef = useRef(false);
  const [address, setAddress] = useState("");
  const [inspecting, setInspecting] = useState(false);
  const [suggestOpen, setSuggestOpen] = useState(false);
  const recent = useAgentBrowserHistory((s) => s.recent);
  const pushRecent = useAgentBrowserHistory((s) => s.push);
  const driving = useAgentBrowserDriving((s) => s.driving);

  /**
   * The emulated device size, when `browser_set_viewport` has asked for one.
   *
   * A ref, not state: `measure()` is called from a ResizeObserver and from
   * `resize`, both outside React's render, and reading a stale closure there
   * would snap the webview back to full width on the next layout change.
   * `frameTick` exists only to re-run the effect that applies a new frame.
   */
  const frameRef = useRef<{ width: number; height: number } | null>(null);
  const [frame, setFrame] = useState<{ width: number; height: number } | null>(null);

  const measure = () => {
    const el = bodyRef.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    // The dock's OUTER container (`.agw-shell-side`) animates its width during
    // the rail glide and clips a right-pinned, fixed-width inner — so the body's
    // own rect never moves, only the visible clip. Anchor the webview's LEFT to
    // the outer's current (animating) left edge and keep its width = the panel's
    // fixed width, so the native webview slides in/out from the right IN SYNC
    // with the rail, WITHOUT reflowing the page. Falls back to the body's own
    // left if the outer can't be found.
    const outer = el.closest(".agw-shell-side") as HTMLElement | null;
    const left = outer ? outer.getBoundingClientRect().left : r.left;

    // Device frame. `Emulation.setDeviceMetricsOverride` alone only changes
    // what the PAGE believes its viewport is — the webview stays panel-sized
    // and the browser paints the leftover area blank, INSIDE the webview where
    // no Aurora styling can reach. The native screenshot photographs that whole
    // surface, so a phone check came back as a narrow layout next to a large
    // white void that reads exactly like a broken page. Sizing the webview to
    // the emulation is the only thing that removes it.
    const frame = frameRef.current;
    if (!frame) return { x: left, y: r.top, width: r.width, height: r.height };

    // Never larger than the panel: a 1440px frame in a 600px panel would push
    // the webview under the rest of the window. Capped, and `browser_status`
    // reports the size the page actually got.
    const width = Math.min(frame.width, r.width);
    const height = Math.min(frame.height, r.height);
    // Centred horizontally so it reads as a device sitting in the panel rather
    // than as a page that failed to fill it. The inset is added to the
    // ANIMATING outer's left, so the frame still slides with the rail.
    const inset = Math.round((r.width - width) / 2);
    return { x: left + inset, y: r.top, width, height };
  };

  useEffect(() => {
    if (!isAuroraRuntimeAvailable()) return;
    const el = bodyRef.current;
    if (!el) return;

    let disposed = false;
    // On screen from here until unmount (overlays aside). Said FIRST, before
    // any build: a build that finishes after this panel is gone must find the
    // "hidden" decision already recorded.
    setBrowserPanelMounted(true);

    // Ensure the embedded webview actually exists in the BACKEND before
    // touching it. A frontend "it was built" flag goes stale (dev backend
    // restart / host window recreated) — trusting one led to `setBounds`/`show`
    // throwing "unknown window 'browser-agentwin'". We check the live registry
    // and rebuild on a miss, so the browser (and its inspector) self-heal.
    const ensureBrowser = async () => {
      const b = measure();
      if (!b || disposed) return;
      let exists = false;
      try {
        exists = (await listBrowserWindows()).some((w) => w.label === LABEL);
      } catch {
        exists = false;
      }
      if (disposed) return;
      if (exists) {
        try {
          await setBrowserBounds(LABEL, b.x, b.y, b.width, b.height);
          boundsApplied = b;
          reassertBrowserVisibility();
          return;
        } catch {
          // Tracked but the webview is gone — fall through to a fresh build
          // (the backend drops the stale entry and rebuilds).
        }
      }
      if (disposed) return;
      try {
        await createBrowserWindow({
          label: LABEL,
          url: "about:blank",
          embed: { hostLabel: HOST, x: b.x, y: b.y, width: b.width, height: b.height },
        });
        boundsApplied = b;
        reassertBrowserVisibility();
        // The layout may have moved during the async build (the rail was
        // mid-glide when the tab opened). Measure once more so the webview
        // sits where the panel is NOW, not where it was when the build began.
        const after = measure();
        if (after && !disposed) syncBounds(after);
      } catch (err) {
        console.warn("[agent-window] embed browser failed:", err);
      }
    };

    const raf = requestAnimationFrame(() => {
      void ensureBrowser();
    });

    const resync = () => {
      const b = measure();
      if (b) syncBounds(b);
    };
    const ro = new ResizeObserver(resync);
    ro.observe(el);
    // Also observe the ANIMATING outer container: during the rail open/close
    // glide it resizes every frame (the body does not), so this is what drives
    // the webview to slide in/out in lockstep with the rail instead of popping.
    const outerEl = el.closest(".agw-shell-side");
    if (outerEl) ro.observe(outerEl);
    window.addEventListener("resize", resync);

    const poll = window.setInterval(async () => {
      if (focusedRef.current) return;
      try {
        const u = await getBrowserUrl(LABEL);
        if (disposed) return;
        if (u && u !== "about:blank") {
          setAddress(u);
          pushRecent(u);
        }
      } catch {
        /* not ready */
      }
    }, 1200);

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener("resize", resync);
      window.clearInterval(poll);
      setBrowserPanelMounted(false);
    };
  }, []);

  // `browser_set_viewport` asks the panel to render at a device size (or to go
  // back to filling the panel). Rust cannot resize the webview itself — the
  // bounds are derived from this component's live layout — so it emits and we
  // re-measure.
  useEffect(() => {
    if (!isAuroraRuntimeAvailable()) return;
    let cancelled = false;
    let unlisten: (() => void) | undefined;

    void listen<{ width?: number | null; height?: number | null }>(
      "aurora:agent-browser-frame",
      (event) => {
        if (cancelled) return;
        const { width, height } = event.payload ?? {};
        const next =
          typeof width === "number" && width > 0
            ? { width, height: typeof height === "number" && height > 0 ? height : Infinity }
            : null;
        frameRef.current = next;
        setFrame(next);
      },
    )
      .then((off) => {
        if (cancelled) off();
        else unlisten = off;
      })
      .catch((err) => {
        console.warn("[agent-window] browser-frame subscribe failed:", err);
      });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // Resize the live webview whenever the frame changes — including back to
  // null, which is what restores the full-panel view after `reset: true`.
  useEffect(() => {
    // `measure` reads refs and live layout rather than render state, so it is
    // deliberately not a dependency.
    const b = measure();
    if (b) syncBounds(b);
  }, [frame]);

  // Inspector picks → add a "Selected N" chip to the composer (IDE parity).
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void onPickedElement((p: PickedElement) => {
      if (p.label !== LABEL) return;
      useAgentSelectionStore.getState().add(p);
    }).then((u) => {
      unlisten = u;
    });
    return () => unlisten?.();
  }, []);

  // The address dropdown drops into the page area, which the native webview
  // paints over — hold the page hidden while it is open.
  const suggestHold = useRef<(() => void) | null>(null);
  const releaseSuggestHold = () => {
    suggestHold.current?.();
    suggestHold.current = null;
  };
  useEffect(() => releaseSuggestHold, []);

  const openSuggest = () => {
    setSuggestOpen(true);
    if (!suggestHold.current) suggestHold.current = holdBrowserHidden();
  };
  const closeSuggest = () => {
    setSuggestOpen(false);
    releaseSuggestHold();
  };

  const navigateTo = (url: string) => {
    setAddress(url);
    void navigateBrowser(LABEL, url);
    pushRecent(url);
    setSuggestOpen(false);
    releaseSuggestHold();
    inputRef.current?.blur();
  };

  const go = () => navigateTo(normalizeAddress(address));

  // Recent (matching) + common dev servers, filtered by what's typed.
  const suggestions = useMemo(() => {
    const q = address.trim().toLowerCase();
    const recents = recent
      .filter((u) => !q || u.toLowerCase().includes(q))
      .slice(0, 5);
    const servers = DEV_SERVERS.filter(
      (s) => !q || s.url.toLowerCase().includes(q) || s.label.toLowerCase().includes(q),
    );
    return { recents, servers };
  }, [address, recent]);

  // Rebuild the embedded webview when the backend has lost track of it (the
  // "unknown window 'browser-agentwin'" desync — e.g. after a dev backend
  // restart / the host window being recreated). Closes any orphan first, then
  // recreates at the current bounds and re-navigates to the live address.
  const recoverBrowser = async (): Promise<boolean> => {
    const b = measure();
    if (!b) return false;
    try {
      await closeAgentBrowser();
    } catch {
      /* nothing to close */
    }
    try {
      await createBrowserWindow({
        label: LABEL,
        url: "about:blank",
        embed: { hostLabel: HOST, x: b.x, y: b.y, width: b.width, height: b.height },
      });
      boundsApplied = b;
      reassertBrowserVisibility();
      const normalized = address.trim() ? normalizeAddress(address) : "";
      if (normalized && normalized !== "about:blank") {
        await navigateBrowser(LABEL, normalized);
      }
      return true;
    } catch (err) {
      console.warn("[agent-window] browser recovery failed:", err);
      return false;
    }
  };

  const toggleInspect = async () => {
    const next = !inspecting;
    try {
      await (next ? activateInspector(LABEL) : deactivateInspector(LABEL));
      setInspecting(next);
    } catch (err) {
      // The webview desynced from the backend. Rebuild it and retry once so the
      // inspector actually turns on and element picks reach the composer.
      if (!next) {
        setInspecting(false);
        return;
      }
      console.warn("[agent-window] inspector activate failed, rebuilding:", err);
      const ok = await recoverBrowser();
      if (ok) {
        try {
          await activateInspector(LABEL);
          setInspecting(true);
          return;
        } catch (retryErr) {
          console.warn("[agent-window] inspector retry failed:", retryErr);
        }
      }
      setInspecting(false);
    }
  };

  return (
    <div className="agw-br-root">
      {/* `data-agw-driving` lights the seam between the toolbar and the page —
          the one edge of the page area Aurora can still draw on, since the
          native webview paints above every pixel of DOM below it. */}
      <div className="agw-br-bar" data-agw-driving={driving ? "true" : undefined}>
        <button type="button" className="agw-br-nav" title="Back" aria-label="Back" onClick={() => void evalBrowser(LABEL, "history.back()")}>
          <span style={{ display: "inline-flex", transform: "rotate(90deg)" }}>
            <AgentIcon name="chevron-down" size={15} />
          </span>
        </button>
        <button type="button" className="agw-br-nav" title="Forward" aria-label="Forward" onClick={() => void evalBrowser(LABEL, "history.forward()")}>
          <span style={{ display: "inline-flex", transform: "rotate(-90deg)" }}>
            <AgentIcon name="chevron-down" size={15} />
          </span>
        </button>
        <button type="button" className="agw-br-nav" title="Reload" aria-label="Reload" onClick={() => void refreshBrowser(LABEL)}>
          <AgentIcon name="retry" size={14} />
        </button>
        <div className="agw-br-address">
          <AgentIcon name="browser" size={13} style={{ color: "var(--agw-text-subtle)" }} />
          <input
            ref={inputRef}
            className="agw-br-input"
            placeholder="Search or enter address"
            value={address}
            spellCheck={false}
            autoCorrect="off"
            autoCapitalize="off"
            onFocus={() => {
              focusedRef.current = true;
              inputRef.current?.select();
              openSuggest();
            }}
            onBlur={() => {
              focusedRef.current = false;
              // Delay so a suggestion click lands before the dropdown closes.
              window.setTimeout(() => closeSuggest(), 130);
            }}
            onChange={(e) => setAddress(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") go();
              else if (e.key === "Escape") {
                closeSuggest();
                inputRef.current?.blur();
              }
            }}
          />
          {/* Inside the address pill, not beside it: everything in this bar is
              fixed-width except the input, so a chip anywhere else would shove
              the Inspect button sideways every time the agent touched the page.
              It also puts "Clicking" next to the URL being clicked. */}
          {driving && (
            <div className="agw-br-driving" role="status" aria-live="polite">
              <span className="agw-br-driving-dot" aria-hidden="true" />
              <span className="agw-br-driving-label">{drivingLabel(driving)}</span>
            </div>
          )}
          {/* An emulated size is otherwise invisible — the page just looks
              narrow — and it survives into later turns. Naming it here is what
              stops "why is my site broken" from being the first read. */}
          {/* A label, not a button: clearing the frame from here would leave the
              PAGE still believing it is 390px wide while the panel went back to
              full width — the exact mismatch this whole change exists to remove.
              The two things that clear both are loading a URL and the agent's
              own reset, so the tooltip points at those. */}
          {frame && (
            <span
              className="agw-br-frame-chip"
              title="Emulated screen size. Load a URL, or ask the agent to reset the viewport, to go back to the full panel."
            >
              {Math.round(frame.width)}
              {Number.isFinite(frame.height) ? `×${Math.round(frame.height)}` : ""}
            </span>
          )}
          {suggestOpen && (suggestions.recents.length > 0 || suggestions.servers.length > 0) && (
            <div className="agw-br-suggest agw-scroll">
              {suggestions.recents.length > 0 && <div className="agw-br-sugg-head">Recent</div>}
              {suggestions.recents.map((u) => (
                <button
                  key={`r-${u}`}
                  type="button"
                  className="agw-br-sugg"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    navigateTo(u);
                  }}
                >
                  <AgentIcon name="retry" size={12} style={{ color: "var(--agw-text-subtle)" }} />
                  <span className="agw-br-sugg-url">{u}</span>
                </button>
              ))}
              <div className="agw-br-sugg-head">Local servers</div>
              {suggestions.servers.map((s) => (
                <button
                  key={`s-${s.url}`}
                  type="button"
                  className="agw-br-sugg"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    navigateTo(s.url);
                  }}
                >
                  <AgentIcon name="terminal" size={12} style={{ color: "var(--agw-text-subtle)" }} />
                  <span className="agw-br-sugg-url">{s.url}</span>
                  <span className="agw-br-sugg-label">{s.label}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        {/* Inspector — pick elements on the page, just like the IDE browser. */}
        <button
          type="button"
          className="agw-br-nav"
          title={inspecting ? "Stop inspecting" : "Inspect element"}
          aria-label="Inspect element"
          aria-pressed={inspecting}
          onClick={() => void toggleInspect()}
          style={inspecting ? { color: "var(--agw-accent)", background: "var(--agw-hover)" } : undefined}
        >
          <AgentIcon name="inspect" size={15} />
        </button>
      </div>
      {/* The native webview floats over this region; keep it empty. Under an
          emulated size it no longer fills the region, so the area around the
          device frame becomes a visible stage — darkened so the device reads as
          a device rather than as a page that failed to fill the panel. */}
      <div ref={bodyRef} className="agw-br-body" data-agw-stage={frame ? "true" : undefined} />
    </div>
  );
};
