/**
 * Browser Service
 *
 * Typed wrappers for the native WebView browser commands exposed by
 * `src-tauri/src/commands/browser.rs`. The runtime opens a real Tauri
 * `WebviewWindow` per browser tab on demand, which lets us inject the
 * inspector and Stagewise scripts that the iframe path can't reach
 * because of the same-origin policy.
 *
 * Element picks bubble up via the `aurora:element-picked` Tauri event;
 * subscribe with `onPickedElement(callback)`.
 */
import { listen } from '@tauri-apps/api/event';

import { auroraInvoke } from '@/kernel/lib/ipc/runtime';

export interface PickedElementBoundingRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PickedElementAttribute {
  name: string;
  value: string;
}

export type PickSource = 'inspector' | 'stagewise';

export interface PickedElement {
  label: string;
  selector: string;
  tagName: string;
  id: string | null;
  className: string | null;
  text: string | null;
  outerHtml: string | null;
  url: string | null;
  boundingRect: PickedElementBoundingRect | null;
  attributes: PickedElementAttribute[] | null;
  /** Ancestor chain, one class each: `main.flex-1 > section.hero`. For reading. */
  path?: string | null;
  /** A short fixed list of computed styles. */
  styles?: PickedElementAttribute[] | null;
  /** The parent as a one-line stub. */
  parent?: string | null;
  /** The pick's row in its parent, stubs only, the pick marked `<!-- SELECTED -->`. */
  siblings?: string[] | null;
  /** `react` / `vue` when a framework handle was found on the node. */
  framework?: string | null;
  /** The owning component's name, possibly minified. */
  component?: string | null;
  /** That component's props, values shortened. */
  props?: PickedElementAttribute[] | null;
  source: PickSource;
  note: string | null;
}

/**
 * Mirror of `BrowserWindowSummary` on the Rust side. Used by the
 * live-windows store, the TitleBar adopt-popover, and the in-tab
 * window selector.
 */
export interface BrowserWindowSummary {
  label: string;
  url: string;
  inspectorActive: boolean;
  stagewiseActive: boolean;
}

export async function listBrowserWindows(): Promise<BrowserWindowSummary[]> {
  return auroraInvoke<BrowserWindowSummary[]>('list_browser_windows');
}

/** Bounds + host for an embedded (in-tab) browser webview. */
export interface BrowserEmbedConfig {
  hostLabel: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CreateBrowserWindowOptions {
  label: string;
  url: string;
  title?: string;
  width?: number;
  height?: number;
  x?: number;
  y?: number;
  alwaysOnTop?: boolean;
  /** When set, render as a child webview embedded in `hostLabel` (in-tab). */
  embed?: BrowserEmbedConfig;
}

export async function createBrowserWindow(opts: CreateBrowserWindowOptions): Promise<void> {
  await auroraInvoke('create_browser_webview', { options: opts });
}

export async function closeBrowserWindow(label: string): Promise<void> {
  await auroraInvoke('close_browser_webview', { label });
}

/** Reposition/resize an embedded browser to track its panel rect. */
export async function setBrowserBounds(
  label: string,
  x: number,
  y: number,
  width: number,
  height: number,
): Promise<void> {
  await auroraInvoke('browser_set_bounds', {
    label,
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(width),
    height: Math.round(height),
  });
}

// Showing and hiding the page is `services/browser/browser-visibility.ts`,
// the one place that decides it.

export async function navigateBrowser(label: string, url: string): Promise<void> {
  await auroraInvoke('browser_navigate', { label, url });
}

export async function refreshBrowser(label: string): Promise<void> {
  await auroraInvoke('browser_refresh', { label });
}

export async function evalBrowser(label: string, script: string): Promise<void> {
  await auroraInvoke('browser_eval', { label, script });
}

export async function getBrowserUrl(label: string): Promise<string> {
  return auroraInvoke<string>('browser_get_url', { label });
}

/**
 * Turn the page's pick overlay on. It is painted in the window's live
 * accent (and the ink that sits on it), read from `.agw-root` here because
 * the page has no access to Aurora's CSS; Rust validates the strings before
 * they land in the script.
 */
export async function activateInspector(label: string): Promise<void> {
  const root = typeof document === 'undefined' ? null : document.querySelector('.agw-root');
  const style = root ? getComputedStyle(root) : null;
  const read = (name: string) => style?.getPropertyValue(name).trim() || undefined;
  await auroraInvoke('browser_activate_inspector', {
    label,
    accent: read('--agw-accent'),
    accentFg: read('--agw-on-accent'),
  });
}

export async function deactivateInspector(label: string): Promise<void> {
  await auroraInvoke('browser_deactivate_inspector', { label });
}

/**
 * Subscribe to picked-element events. The returned unsubscribe
 * function removes the listener; call it from the consumer's cleanup
 * (e.g. React useEffect return).
 */
export async function onPickedElement(
  callback: (element: PickedElement) => void,
): Promise<() => void> {
  const unlisten = await listen<PickedElement>('aurora:element-picked', (event) => {
    callback(event.payload);
  });
  return unlisten;
}

// The block the model reads for a pick is built in ONE place,
// `buildSelectionContext` in `store/composer/useAgentSelectionStore.ts`. A
// second formatter used to live here with bounds and the full HTML, wired
// through `context-builder.ts`, and nothing ever called it — so the richer
// record was written and the poorer one sent.

/**
 * Theme tokens forwarded to the Stagewise toolbar so the floating UI
 * inside the previewed page matches the IDE's look. All values are
 * resolved CSS color strings (hex/rgb), not CSS variables — the
 * previewed page does not have access to Aurora's CSS.
 */
export interface BrowserThemeTokens {
  background: string;
  foreground: string;
  border: string;
  primary: string;
  primaryForeground: string;
  muted: string;
  shadow: string;
}

