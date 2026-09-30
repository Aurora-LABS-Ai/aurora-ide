/**
 * Agent Window — Browser tab [view].
 *
 * Hosts one real browser page inside the dock: `browser_runtime` builds its
 * webview as a child of the agent window (embedded), so the SAME pipeline the
 * agent tools use — navigate, screenshot, DOM, and crucially the element
 * INSPECTOR — works here, in-tab. The toolbar (React DOM) sits above; the page
 * renders natively in the body region.
 *
 * The dock can hold several browser tabs, one native page each (`label`). The
 * agent's tools drive exactly one of them, `AGENT_BROWSER_LABEL`; only that
 * tab shows the "agent is driving" cue and follows the agent's device frame.
 *
 * Inspector picks arrive on the global `aurora:element-picked` event; we drop a
 * concise reference into the composer via `agw:compose-insert`. The webview is
 * bounds-synced on layout changes and closed on tab close. Whether it is on
 * screen is decided in one place, `services/browser/browser-visibility.ts`:
 * this panel only reports that it mounted or unmounted, and overlays hold it
 * hidden.
 */

import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";

import { AgentIcon } from "@/apps/agent/shared/AgentIcon";
import { auroraInvoke, isAuroraRuntimeAvailable } from "@/kernel/lib/ipc/runtime";
import { useAgentSelectionStore } from "@/apps/agent/store/composer/useAgentSelectionStore";
import {
  AGENT_BROWSER_LABEL,
  forgetBrowser,
  holdBrowserHidden,
  reassertBrowserVisibility,
  setBrowserPanelMounted,
} from "@/apps/agent/services/browser/browser-visibility";
import { useAgentBrowserHistory } from "@/apps/agent/store/workspace/useAgentBrowserHistory";
import { drivingLabel, useAgentBrowserDriving } from "@/apps/agent/store/workspace/useAgentBrowserDriving";
import { useAgentWorkspaceStore } from "@/apps/agent/store/workspace/useAgentWorkspaceStore";
import { addressTitle, normalizeAddress } from "@/apps/agent/lib/browser/browser-tabs";
import {
  DEVICE_PRESETS,
  deviceSpec,
  layoutDevice,
  stepZoom,
  type DeviceId,
  type DeviceLayout,
} from "@/apps/agent/lib/browser/devices";
import { DeviceFrame } from "@/apps/agent/components/browser/DeviceFrame";
import { STATUS_BAR_COLOR_SCRIPT, normalizeCssColor } from "@/apps/agent/lib/browser/status-bar";
import { BrowserToolsRow } from "@/apps/agent/components/browser/BrowserToolsRow";
import { BrowserFindBar } from "@/apps/agent/components/browser/BrowserFindBar";
import { composerKey, useAgentAttachmentStore } from "@/apps/agent/store/composer/useAgentAttachmentStore";
import { useAgentChatStore } from "@/apps/agent/store/conversation/useAgentChatStore";
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

const HOST = "agent-window";

/**
 * Bounds updates, serialised — per page.
 *
 * A rail drag fires a ResizeObserver callback per frame, and each used to
 * fire its own `browser_set_bounds` IPC call. Those calls are independent
 * async round trips with no ordering guarantee, so under a fast drag an
 * EARLIER (larger) rectangle could land after a LATER (smaller) one and stay
 * — the "I dragged the rail smaller and the browser stayed larger" report,
 * intermittent because it needs two calls to cross. One in-flight call at a
 * time, always followed by the newest rectangle, makes the last measurement
 * the one that wins. Each page keeps its own queue: two tabs never share one.
 */
type Bounds = { x: number; y: number; width: number; height: number };
interface BoundsQueue {
  pending: Bounds | null;
  inFlight: boolean;
  applied: Bounds | null;
}
const boundsQueues = new Map<string, BoundsQueue>();

function queueFor(label: string): BoundsQueue {
  let queue = boundsQueues.get(label);
  if (!queue) {
    queue = { pending: null, inFlight: false, applied: null };
    boundsQueues.set(label, queue);
  }
  return queue;
}

function sameBounds(a: Bounds | null, b: Bounds): boolean {
  return (
    !!a &&
    Math.round(a.x) === Math.round(b.x) &&
    Math.round(a.y) === Math.round(b.y) &&
    Math.round(a.width) === Math.round(b.width) &&
    Math.round(a.height) === Math.round(b.height)
  );
}

function syncBounds(label: string, next: Bounds): void {
  const queue = queueFor(label);
  if (!queue.inFlight && sameBounds(queue.applied, next)) return;
  queue.pending = next;
  if (queue.inFlight) return;
  queue.inFlight = true;
  void (async () => {
    try {
      while (queue.pending) {
        const b = queue.pending;
        queue.pending = null;
        try {
          await setBrowserBounds(label, b.x, b.y, b.width, b.height);
          queue.applied = b;
        } catch {
          // The webview is gone or not built yet; the next mount re-syncs.
          queue.applied = null;
        }
      }
    } finally {
      queue.inFlight = false;
    }
  })();
}

/** Tear down a tab's embedded page (called when its tab is closed). */
// eslint-disable-next-line react-refresh/only-export-components -- co-located webview lifecycle helper
export async function closeBrowserPage(label: string): Promise<void> {
  boundsQueues.delete(label);
  forgetBrowser(label);
  const { closeBrowserWindow } = await import("@/apps/agent/services/browser/browser-service");
  try {
    await closeBrowserWindow(label);
  } catch {
    /* not open */
  }
}

export interface BrowserPanelProps {
  /** The dock tab this panel belongs to — its address and title are written back to it. */
  tabId: string;
  /** The native page to host. */
  label: string;
  /** Where to load the page when it has to be built (a reopened tab). */
  initialUrl?: string;
  /** An address still to load, handed over by a New tab page. */
  pendingUrl?: string;
  /** The device the page is shown as (saved on the tab). */
  device?: DeviceId;
  /** The page's zoom (saved on the tab); 1 when absent. */
  zoom?: number;
  /** Whether the tools row is open (saved on the tab). */
  toolsOpen?: boolean;
}

/** How long a tools-row notice ("Screenshot added…") stays. */
const NOTICE_MS = 2600;
/** Re-emulate at most this often while the panel is being resized. */
const EMULATION_SETTLE_MS = 120;

export const BrowserPanel: React.FC<BrowserPanelProps> = ({
  tabId,
  label,
  initialUrl,
  pendingUrl,
  device,
  zoom = 1,
  toolsOpen = false,
}) => {
  const isAgentPage = label === AGENT_BROWSER_LABEL;
  const preset = device ? DEVICE_PRESETS[device] : null;
  // Read by `measure()`, which runs outside render (ResizeObserver).
  const presetRef = useRef(preset);
  useLayoutEffect(() => {
    presetRef.current = preset;
  }, [preset]);
  /**
   * The device this panel has actually applied to the page, if any. Leaving a
   * device clears the emulation ONLY when this panel set it: the agent's page
   * may carry the agent's own viewport, which opening the tab must not wipe.
   */
  const appliedDeviceRef = useRef<DeviceId | null>(null);
  const [layout, setLayout] = useState<DeviceLayout | null>(null);
  // The page window exists in the backend — device and zoom can be applied.
  const [ready, setReady] = useState(false);
  const [findOpen, setFindOpen] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [notice, setNotice] = useState<{ text: string; tone: "ok" | "error" } | null>(null);
  /** The device status bar's colour, read from the page (`lib/browser/status-bar.ts`). */
  const [statusColor, setStatusColor] = useState("rgb(255, 255, 255)");
  /** How far the open/close glide has moved the page window right; the frame follows. */
  const [slideX, setSlideX] = useState(0);
  const bodyRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const focusedRef = useRef(false);
  const [address, setAddress] = useState(pendingUrl ?? initialUrl ?? "");
  const [inspecting, setInspecting] = useState(false);
  const [suggestOpen, setSuggestOpen] = useState(false);
  const recent = useAgentBrowserHistory((s) => s.recent);
  const pushRecent = useAgentBrowserHistory((s) => s.push);
  const agentDriving = useAgentBrowserDriving((s) => s.driving);
  const driving = isAgentPage ? agentDriving : null;
  const updateBrowserTab = useAgentWorkspaceStore((s) => s.updateBrowserTab);

  // Read once by the build effect. A ref, so a later change to the tab record
  // (the panel clearing `pendingUrl` itself) never re-runs the build.
  const loadRef = useRef({ pendingUrl, initialUrl });

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

    // A device the user picked: the page goes exactly over the drawn frame's
    // screen, below its status bar (`layoutDevice`). This wins over the
    // agent's plain frame below — the agent's own viewport tool clears the
    // device before it sets its size.
    const devicePreset = presetRef.current;
    if (devicePreset) {
      const l = layoutDevice(devicePreset, r.width, r.height);
      return { x: left + l.page.x, y: r.top + l.page.y, width: l.page.width, height: l.page.height };
    }

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
    const readStatusColor = async () => {
      try {
        const raw = await auroraInvoke<string>("browser_eval_value", { label, script: STATUS_BAR_COLOR_SCRIPT });
        if (!disposed && typeof raw === "string") setStatusColor(normalizeCssColor(raw));
      } catch {
        // Mid-navigation; the next tick reads it again.
      }
    };
    // On screen from here until unmount (overlays aside). Said FIRST, before
    // any build: a build that finishes after this panel is gone must find the
    // "hidden" decision already recorded.
    setBrowserPanelMounted(true, label);

    // The New tab page handed this tab an address. Loaded once, then cleared
    // on the tab so a reload or a tab switch does not load it again.
    const consumePending = async () => {
      const pending = loadRef.current.pendingUrl;
      if (!pending) return;
      loadRef.current.pendingUrl = undefined;
      updateBrowserTab(tabId, { pendingUrl: undefined });
      pushRecent(pending);
      try {
        await navigateBrowser(label, pending);
      } catch (err) {
        console.warn(`[agent-window] could not open ${pending}:`, err);
      }
    };

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
        exists = (await listBrowserWindows()).some((w) => w.label === label);
      } catch {
        exists = false;
      }
      if (disposed) return;
      if (exists) {
        try {
          await setBrowserBounds(label, b.x, b.y, b.width, b.height);
          queueFor(label).applied = b;
          reassertBrowserVisibility(label);
          if (!disposed) setReady(true);
          await consumePending();
          return;
        } catch {
          // Tracked but the webview is gone — fall through to a fresh build
          // (the backend drops the stale entry and rebuilds).
        }
      }
      if (disposed) return;
      // A fresh page opens where the tab says it was, so a restored tab comes
      // back on its site instead of blank.
      const startUrl = loadRef.current.pendingUrl ?? loadRef.current.initialUrl ?? "about:blank";
      try {
        await createBrowserWindow({
          label,
          url: startUrl,
          embed: { hostLabel: HOST, x: b.x, y: b.y, width: b.width, height: b.height },
        });
        queueFor(label).applied = b;
        reassertBrowserVisibility(label);
        if (!disposed) setReady(true);
        if (loadRef.current.pendingUrl) {
          loadRef.current.pendingUrl = undefined;
          updateBrowserTab(tabId, { pendingUrl: undefined });
          pushRecent(startUrl);
        }
        // The layout may have moved during the async build (the rail was
        // mid-glide when the tab opened). Measure once more so the webview
        // sits where the panel is NOW, not where it was when the build began.
        const after = measure();
        if (after && !disposed) syncBounds(label, after);
      } catch (err) {
        console.warn("[agent-window] embed browser failed:", err);
      }
    };

    const raf = requestAnimationFrame(() => {
      void ensureBrowser();
    });

    const resync = () => {
      const b = measure();
      if (b) syncBounds(label, b);
      // The drawn frame follows the same measurement as the page.
      const p = presetRef.current;
      setLayout(p ? layoutDevice(p, el.clientWidth, el.clientHeight) : null);
      // During the panel's glide the page window is moved right by how far the
      // panel's left edge has travelled (`measure`); the frame moves with it.
      const glideOuter = el.closest(".agw-shell-side");
      const slide = glideOuter
        ? Math.max(0, glideOuter.getBoundingClientRect().left - el.getBoundingClientRect().left)
        : 0;
      setSlideX(Math.round(slide * 10) / 10);
    };
    const ro = new ResizeObserver(resync);
    ro.observe(el);
    // Also observe the ANIMATING outer container: during the rail open/close
    // glide it resizes every frame (the body does not), so this is what drives
    // the webview to slide in/out in lockstep with the rail instead of popping.
    const outerEl = el.closest(".agw-shell-side");
    if (outerEl) ro.observe(outerEl);
    window.addEventListener("resize", resync);

    // Follow the page: the address bar tracks clicks inside it, and the tab
    // takes the page's own title once it has one.
    const poll = window.setInterval(async () => {
      if (focusedRef.current) return;
      try {
        const u = await getBrowserUrl(label);
        if (disposed || !u || u === "about:blank") return;
        setAddress(u);
        pushRecent(u);
        let title: string | null = null;
        try {
          title = await auroraInvoke<string | null>("browser_page_title", { label });
        } catch {
          // Mid-navigation; the next tick asks again.
        }
        if (disposed) return;
        updateBrowserTab(tabId, title ? { url: u, title } : { url: u });
        // A device's status bar follows the page, as a phone's does.
        if (presetRef.current) void readStatusColor();
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
      setBrowserPanelMounted(false, label);
    };
  }, [label, tabId, pushRecent, updateBrowserTab]);

  // `browser_set_viewport` asks the panel to render at a device size (or to go
  // back to filling the panel). Rust cannot resize the webview itself — the
  // bounds are derived from this component's live layout — so it emits and we
  // re-measure. Only the agent's page is ever emulated.
  useEffect(() => {
    if (!isAuroraRuntimeAvailable() || !isAgentPage) return;
    let cancelled = false;
    let unlisten: (() => void) | undefined;

    void listen<{ width?: number | null; height?: number | null }>(
      "aurora:agent-browser-frame",
      (event) => {
        if (cancelled) return;
        // The agent set or reset its own viewport, which replaces a device the
        // user picked here (Rust has already forgotten it). Drop the choice
        // without clearing the emulation the agent just set.
        if (appliedDeviceRef.current || presetRef.current) {
          appliedDeviceRef.current = null;
          updateBrowserTab(tabId, { device: undefined });
        }
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
  }, [isAgentPage, tabId, updateBrowserTab]);

  // Resize the live webview whenever the frame changes — including back to
  // null, which is what restores the full-panel view after `reset: true`.
  useEffect(() => {
    // `measure` reads refs and live layout rather than render state, so it is
    // deliberately not a dependency.
    const b = measure();
    if (b) syncBounds(label, b);
  }, [frame, label]);

  // ── Device ────────────────────────────────────────────────────────────
  // Picking a device re-lays the frame and moves the page onto its screen at
  // once; the emulation that makes the page the device's width follows.
  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    setLayout(preset ? layoutDevice(preset, el.clientWidth, el.clientHeight) : null);
    const b = measure();
    if (b) syncBounds(label, b);
    // `measure` reads refs; the device is the only input that changed.
  }, [preset, label]);

  const layoutRef = useRef(layout);
  useLayoutEffect(() => {
    layoutRef.current = layout;
  }, [layout]);
  const emuScale = layout ? Math.round(layout.emulation.scale * 1000) / 1000 : 0;
  const emuRadius = layout ? Math.round(layout.bottomRadius * 10) / 10 : 0;
  useEffect(() => {
    if (!ready || !isAuroraRuntimeAvailable()) return;
    const layout = layoutRef.current;
    if (!preset || !layout) {
      if (!appliedDeviceRef.current) return;
      appliedDeviceRef.current = null;
      void (async () => {
        try {
          await auroraInvoke("browser_set_device", { label, device: null });
          await auroraInvoke("browser_set_corner_radius", { label, radius: 0 });
        } catch (err) {
          console.warn("[agent-window] could not return the page to its natural size:", err);
        }
      })();
      return;
    }
    // Settle while the panel is being dragged; the frame and page move live,
    // the page's scale catches up when the drag pauses.
    const timer = window.setTimeout(() => {
      appliedDeviceRef.current = preset.id;
      void (async () => {
        try {
          await auroraInvoke("browser_set_device", { label, device: deviceSpec(preset, layout) });
          await auroraInvoke("browser_set_corner_radius", { label, radius: layout.bottomRadius });
        } catch (err) {
          console.warn(`[agent-window] could not show the page as ${preset.label}:`, err);
          setNotice({ text: `Couldn't show the page as ${preset.label}`, tone: "error" });
        }
      })();
    }, EMULATION_SETTLE_MS);
    return () => window.clearTimeout(timer);
    // The layout is read from its ref and summarised by `emuScale`/`emuRadius`:
    // re-emulate when the page's painted scale or corners change, not on
    // every pixel the frame moves.
  }, [ready, preset, emuScale, emuRadius, label]);

  // The status bar takes the page's colour the moment a device is shown, not
  // on the next page check a second later.
  const presetId = preset?.id;
  useEffect(() => {
    if (!ready || !presetId || !isAuroraRuntimeAvailable()) return;
    let cancelled = false;
    void auroraInvoke<string>("browser_eval_value", { label, script: STATUS_BAR_COLOR_SCRIPT })
      .then((raw) => {
        if (!cancelled && typeof raw === "string") setStatusColor(normalizeCssColor(raw));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [ready, presetId, label]);

  // ── Zoom ──────────────────────────────────────────────────────────────
  // A device fixes the page's size, so zoom rests at 100% while one is shown
  // and comes back when it is not.
  const appliedZoomRef = useRef(1);
  const effectiveZoom = preset ? 1 : zoom;
  useEffect(() => {
    if (!ready || !isAuroraRuntimeAvailable()) return;
    if (appliedZoomRef.current === effectiveZoom) return;
    const target = effectiveZoom;
    void auroraInvoke<number>("browser_set_zoom", { label, zoom: target })
      .then((applied) => {
        appliedZoomRef.current = applied;
      })
      .catch((err) => {
        console.warn("[agent-window] could not zoom the page:", err);
        setNotice({ text: "Couldn't zoom this page", tone: "error" });
      });
  }, [ready, effectiveZoom, label]);

  // Notices clear themselves.
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const setDevice = (next: DeviceId | undefined) => updateBrowserTab(tabId, { device: next });
  const setZoom = (next: number) => updateBrowserTab(tabId, { zoom: next === 1 ? undefined : next });
  const toggleTools = () => updateBrowserTab(tabId, { toolsOpen: toolsOpen ? undefined : true });

  /** Screenshot straight into the message being written. */
  const takeScreenshot = async () => {
    if (capturing) return;
    setCapturing(true);
    try {
      const base64 = await auroraInvoke<string>("browser_capture_screenshot", { label });
      const host = addressTitle(address || initialUrl || "page").replace(/[^A-Za-z0-9.-]+/g, "-");
      const key = composerKey(useAgentChatStore.getState().currentThreadId);
      useAgentAttachmentStore.getState().add(key, {
        id: `shot-${Date.now().toString(36)}`,
        name: `${host}${preset ? `-${preset.id}` : ""}.png`,
        mediaType: "image/png",
        base64,
      });
      setNotice({ text: "Screenshot added to your message", tone: "ok" });
    } catch (err) {
      console.warn("[agent-window] screenshot failed:", err);
      setNotice({ text: "Screenshot failed", tone: "error" });
    } finally {
      setCapturing(false);
    }
  };

  // Inspector picks → add a "Selected N" chip to the composer (IDE parity).
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void onPickedElement((p: PickedElement) => {
      if (p.label !== label) return;
      useAgentSelectionStore.getState().add(p);
    }).then((u) => {
      unlisten = u;
    });
    return () => unlisten?.();
  }, [label]);

  // Closing the panel or switching tabs unmounts this view but keeps the page
  // alive, so the page must not be left in pick mode with no button showing
  // it: the next mount starts with Inspect off, and so does the page.
  const inspectingRef = useRef(false);
  useEffect(() => {
    inspectingRef.current = inspecting;
  }, [inspecting]);
  useEffect(
    () => () => {
      if (inspectingRef.current) void deactivateInspector(label).catch(() => undefined);
    },
    [label],
  );

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
    void navigateBrowser(label, url);
    pushRecent(url);
    setSuggestOpen(false);
    releaseSuggestHold();
    inputRef.current?.blur();
  };

  const go = () => navigateTo(normalizeAddress(address));

  // Recent sites matching what's typed. Running local servers live on the New
  // tab page, where they are read from real processes rather than guessed.
  const suggestions = useMemo(() => {
    const q = address.trim().toLowerCase();
    return recent.filter((u) => !q || u.toLowerCase().includes(q)).slice(0, 6);
  }, [address, recent]);

  // Rebuild the embedded webview when the backend has lost track of it (the
  // "unknown window 'browser-agentwin'" desync — e.g. after a dev backend
  // restart / the host window being recreated). Closes any orphan first, then
  // recreates at the current bounds and re-navigates to the live address.
  const recoverBrowser = async (): Promise<boolean> => {
    const b = measure();
    if (!b) return false;
    try {
      await closeBrowserPage(label);
    } catch {
      /* nothing to close */
    }
    try {
      await createBrowserWindow({
        label,
        url: "about:blank",
        embed: { hostLabel: HOST, x: b.x, y: b.y, width: b.width, height: b.height },
      });
      queueFor(label).applied = b;
      // `closeBrowserPage` forgot this page; the panel is still mounted, so
      // say so again before re-asserting.
      setBrowserPanelMounted(true, label);
      reassertBrowserVisibility(label);
      const normalized = address.trim() ? normalizeAddress(address) : "";
      if (normalized && normalized !== "about:blank") {
        await navigateBrowser(label, normalized);
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
      await (next ? activateInspector(label) : deactivateInspector(label));
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
          await activateInspector(label);
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
    <div
      className="agw-br-root"
      onKeyDown={(e) => {
        // Ctrl+F anywhere in the panel's own controls (a key pressed inside
        // the page goes to the page, which has its own keyboard).
        if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "f") {
          e.preventDefault();
          setFindOpen(true);
        }
      }}
    >
      {/* `data-agw-driving` lights the seam between the toolbar and the page —
          the one edge of the page area Aurora can still draw on, since the
          native webview paints above every pixel of DOM below it. */}
      <div className="agw-br-bar" data-agw-driving={driving ? "true" : undefined}>
        <button type="button" className="agw-br-nav" title="Back" aria-label="Back" onClick={() => void evalBrowser(label, "history.back()")}>
          <span style={{ display: "inline-flex", transform: "rotate(90deg)" }}>
            <AgentIcon name="chevron-down" size={15} />
          </span>
        </button>
        <button type="button" className="agw-br-nav" title="Forward" aria-label="Forward" onClick={() => void evalBrowser(label, "history.forward()")}>
          <span style={{ display: "inline-flex", transform: "rotate(-90deg)" }}>
            <AgentIcon name="chevron-down" size={15} />
          </span>
        </button>
        <button type="button" className="agw-br-nav" title="Reload" aria-label="Reload" onClick={() => void refreshBrowser(label)}>
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
          {suggestOpen && suggestions.length > 0 && (
            <div className="agw-br-suggest agw-scroll">
              <div className="agw-br-sugg-head">Recent</div>
              {suggestions.map((u) => (
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
        {/* Browser tools. Lit while a device or zoom is in force even with the
            row closed, so a phone-width or zoomed page never looks like a
            broken site with nothing on screen explaining it. */}
        <button
          type="button"
          className="agw-br-nav"
          title="Browser tools: device, zoom, find, screenshot"
          aria-label="Browser tools"
          aria-expanded={toolsOpen}
          data-on={toolsOpen || undefined}
          data-lit={!toolsOpen && (!!preset || zoom !== 1) ? "true" : undefined}
          onClick={toggleTools}
        >
          <AgentIcon name="sliders" size={15} />
        </button>
      </div>
      {toolsOpen && (
        <BrowserToolsRow
          device={device}
          onDevice={setDevice}
          zoom={zoom}
          onZoomStep={(direction) => setZoom(stepZoom(zoom, direction))}
          onZoomReset={() => setZoom(1)}
          findOpen={findOpen}
          onToggleFind={() => setFindOpen((open) => !open)}
          onScreenshot={() => void takeScreenshot()}
          capturing={capturing}
          notice={notice}
        />
      )}
      {findOpen && <BrowserFindBar label={label} onClose={() => setFindOpen(false)} />}
      {/* The native webview floats over this region; keep it empty. Under an
          emulated size it no longer fills the region, so the area around the
          device frame becomes a visible stage — darkened so the device reads as
          a device rather than as a page that failed to fill the panel. A
          device the user picked draws its real frame here, under the page. */}
      <div ref={bodyRef} className="agw-br-body" data-agw-stage={frame && !preset ? "true" : undefined}>
        {preset && layout && <DeviceFrame preset={preset} layout={layout} statusColor={statusColor} slideX={slideX} />}
      </div>
    </div>
  );
};
