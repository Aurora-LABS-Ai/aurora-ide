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

export async function activateInspector(label: string): Promise<void> {
  await auroraInvoke('browser_activate_inspector', { label });
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

/**
 * Render a single picked element as XML the agent can consume. Used
 * by `formatSelectedElementsBlock` below; rarely called directly.
 */
function formatPickedElement(element: PickedElement, index: number): string {
  const lines: string[] = [];
  lines.push(`  <element index="${index}" source="${element.source}">`);
  lines.push(`    <selector>${escapeXml(element.selector)}</selector>`);
  lines.push(`    <tag>${escapeXml(element.tagName)}</tag>`);
  if (element.id) lines.push(`    <id>${escapeXml(element.id)}</id>`);
  if (element.className) lines.push(`    <class>${escapeXml(element.className)}</class>`);
  if (element.text) {
    lines.push(`    <text>${escapeXml(element.text.replace(/\n/g, ' '))}</text>`);
  }
  if (element.url) lines.push(`    <url>${escapeXml(element.url)}</url>`);
  if (element.boundingRect) {
    const r = element.boundingRect;
    lines.push(
      `    <bounds>x=${Math.round(r.x)} y=${Math.round(r.y)} w=${Math.round(r.width)} h=${Math.round(r.height)}</bounds>`,
    );
  }
  if (element.note) lines.push(`    <note>${escapeXml(element.note)}</note>`);
  if (element.outerHtml) {
    // CDATA escapes everything except the literal `]]>` marker, which
    // we split across two CDATA sections so even pages whose HTML
    // contains that sequence stay parseable.
    const safe = element.outerHtml.replace(/]]>/g, ']]]]><![CDATA[>');
    lines.push('    <outer_html><![CDATA[');
    lines.push(safe);
    lines.push('    ]]></outer_html>');
  }
  lines.push('  </element>');
  return lines.join('\n');
}

/**
 * Wrap a list of picked elements into a single `<selected_elements>`
 * block. Intended to be prepended to the user's typed message at
 * submit time so the agent can refer to them as `selected 1`,
 * `selected 2`, etc.
 *
 * Returns `''` if the list is empty so callers can unconditionally
 * concatenate.
 */
export function formatSelectedElementsBlock(elements: PickedElement[]): string {
  if (elements.length === 0) return '';
  const body = elements.map((el, i) => formatPickedElement(el, i + 1)).join('\n');
  return `<selected_elements count="${elements.length}">\n${body}\n</selected_elements>`;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

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

