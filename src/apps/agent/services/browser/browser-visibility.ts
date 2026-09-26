/**
 * The one owner of the embedded browser's visibility.
 *
 * The browser is a native child webview: it paints above every pixel of DOM,
 * so it must be hidden whenever anything else should be on screen. That used
 * to be decided in eight places (tab switch, `+` menu, address suggestions,
 * image preview, video player, agent "open browser" event, panel mount and
 * unmount), each firing its own show or hide IPC call with nothing ordering
 * them. A hide could land before an earlier show, and the page stayed over
 * Files or the terminal; a show gated on the SAVED active tab resurrected the
 * page over Aurora Chat's Canvas, whose dock filters the Browser tab out.
 *
 * Now there is one rule and one writer:
 *
 *     visible  ⇔  the Browser panel is mounted  ∧  no overlay holds it hidden
 *
 * "Mounted" is the real test of "on screen": the dock renders only the tab it
 * is showing, so the panel is mounted exactly when the user is looking at it —
 * including after the Chat surface filters tabs, and including the slide-out
 * glide (the dock unmounts when the glide ends). Overlays take a hold
 * (`holdBrowserHidden`) and release it; two overlays at once keep the page
 * hidden until both are gone.
 *
 * Every decision is sent with a growing sequence number and Rust drops a stale
 * one (`BrowserManager::set_visible`), so the order calls arrive in no longer
 * matters. Rust also remembers a decision made before the webview exists, so a
 * page that finishes building after the user switched away comes up hidden.
 */
import { auroraInvoke, isAuroraRuntimeAvailable } from "@/kernel/lib/ipc/runtime";

/** The Agent Window's only browser webview. */
export const AGENT_BROWSER_LABEL = "browser-agentwin";

let panelMounted = false;
let holds = 0;
let lastSent: boolean | null = null;
let lastSeq = 0;

/**
 * Strictly increasing, and larger than anything a previous page load sent: a
 * window reload restarts this module, but Rust keeps the last sequence it
 * accepted, so a counter starting from 1 again would have every decision
 * after a reload dropped as stale. Microseconds since the epoch stay well
 * inside `Number.MAX_SAFE_INTEGER`.
 */
function nextSeq(): number {
  const now = Math.floor((performance.timeOrigin + performance.now()) * 1000);
  lastSeq = Math.max(lastSeq + 1, now);
  return lastSeq;
}

function apply(force: boolean): void {
  const visible = panelMounted && holds === 0;
  if (!force && visible === lastSent) return;
  lastSent = visible;
  if (!isAuroraRuntimeAvailable()) return;
  void auroraInvoke<boolean>("browser_set_visible", {
    label: AGENT_BROWSER_LABEL,
    visible,
    seq: nextSeq(),
  }).catch((error) => {
    // Not fatal: the next decision, or the next build, re-applies the rule.
    console.warn("[agent-browser] could not change browser visibility:", error);
  });
}

/** The Browser panel mounted (true) or unmounted (false). */
export function setBrowserPanelMounted(mounted: boolean): void {
  panelMounted = mounted;
  apply(false);
}

/**
 * Keep the page hidden while an overlay (menu, dropdown, modal) is open over
 * the panel. Returns the release; calling it more than once is harmless.
 */
export function holdBrowserHidden(): () => void {
  holds += 1;
  apply(false);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holds = Math.max(0, holds - 1);
    apply(false);
  };
}

/** Re-send the current decision — after the webview was built or rebuilt. */
export function reassertBrowserVisibility(): void {
  apply(true);
}

/** Is the page meant to be on screen right now? */
export function isBrowserMeantVisible(): boolean {
  return panelMounted && holds === 0;
}
