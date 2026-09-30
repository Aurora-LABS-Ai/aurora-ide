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
 * Now there is one rule and one writer, per page:
 *
 *     visible(page)  ⇔  that page's panel is mounted  ∧  no overlay holds pages hidden
 *
 * "Mounted" is the real test of "on screen": the dock renders only the tab it
 * is showing, so a page's panel is mounted exactly when the user is looking at
 * it — including after the Chat surface filters tabs, and including the
 * slide-out glide (the dock unmounts when the glide ends). The dock holds
 * several browser tabs, one native page each; switching tabs unmounts one
 * panel and mounts the other, so exactly one page is on screen. Overlays take a
 * hold (`holdBrowserHidden`) and release it; a hold hides EVERY page, and two
 * overlays at once keep them hidden until both are gone.
 *
 * Every decision is sent with a growing sequence number and Rust drops a stale
 * one (`BrowserManager::set_visible`), so the order calls arrive in no longer
 * matters. Rust also remembers a decision made before the webview exists, so a
 * page that finishes building after the user switched away comes up hidden.
 */
import { auroraInvoke, isAuroraRuntimeAvailable } from "@/kernel/lib/ipc/runtime";

/**
 * The page the agent's browser tools drive. Its tab is the dock's `browser`
 * tab; every other browser tab the user opens gets its own label
 * (`userBrowserLabel` in `lib/browser/browser-tabs.ts`) and is never touched
 * by the agent.
 */
export const AGENT_BROWSER_LABEL = "browser-agentwin";

const mounted = new Set<string>();
let holds = 0;
const lastSent = new Map<string, boolean>();
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

function apply(label: string, force: boolean): void {
  const visible = mounted.has(label) && holds === 0;
  if (!force && visible === lastSent.get(label)) return;
  lastSent.set(label, visible);
  if (!isAuroraRuntimeAvailable()) return;
  void auroraInvoke<boolean>("browser_set_visible", {
    label,
    visible,
    seq: nextSeq(),
  }).catch((error) => {
    // Not fatal: the next decision, or the next build, re-applies the rule.
    console.warn(`[agent-browser] could not change visibility of ${label}:`, error);
  });
}

/** Every page this module has ever decided about — a hold affects them all. */
function applyAll(): void {
  for (const label of new Set([...mounted, ...lastSent.keys()])) apply(label, false);
}

/** A browser panel mounted (true) or unmounted (false) for page `label`. */
export function setBrowserPanelMounted(isMounted: boolean, label = AGENT_BROWSER_LABEL): void {
  if (isMounted) mounted.add(label);
  else mounted.delete(label);
  apply(label, false);
}

/**
 * Keep every page hidden while an overlay (menu, dropdown, modal) is open over
 * the panel. Returns the release; calling it more than once is harmless.
 */
export function holdBrowserHidden(): () => void {
  holds += 1;
  applyAll();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holds = Math.max(0, holds - 1);
    applyAll();
  };
}

/** Re-send the current decision for `label` — after its webview was built or rebuilt. */
export function reassertBrowserVisibility(label = AGENT_BROWSER_LABEL): void {
  apply(label, true);
}

/** Is page `label` meant to be on screen right now? */
export function isBrowserMeantVisible(label = AGENT_BROWSER_LABEL): boolean {
  return mounted.has(label) && holds === 0;
}

/** The tab closed and its page is gone: stop tracking it. */
export function forgetBrowser(label: string): void {
  mounted.delete(label);
  lastSent.delete(label);
}
