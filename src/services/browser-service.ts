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

import { auroraInvoke } from '../lib/runtime';

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

export interface BrowserWindowClosedEvent {
  label: string;
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
}

/**
 * Build the conventional native-window label for a browser tab.
 * Must start with `browser-` to match the capability allowlist in
 * `src-tauri/capabilities/browser.json`.
 */
export function browserWindowLabelFor(tabId: string): string {
  const safe = tabId.replace(/[^A-Za-z0-9_-]/g, '');
  return `browser-${safe || 'default'}`;
}

export async function createBrowserWindow(opts: CreateBrowserWindowOptions): Promise<void> {
  await auroraInvoke('create_browser_webview', { options: opts });
}

export async function closeBrowserWindow(label: string): Promise<void> {
  await auroraInvoke('close_browser_webview', { label });
}

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

export async function clearInspectorSelection(label: string): Promise<void> {
  await auroraInvoke('browser_clear_selection', { label });
}

export async function activateStagewise(
  label: string,
  theme: BrowserThemeTokens,
): Promise<void> {
  await auroraInvoke('browser_activate_stagewise', { label, theme });
}

export async function deactivateStagewise(label: string): Promise<void> {
  await auroraInvoke('browser_deactivate_stagewise', { label });
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
 * Subscribe to the close-event a native browser window emits when the
 * user closes it via the OS chrome.
 */
export async function onBrowserWindowClosed(
  callback: (event: BrowserWindowClosedEvent) => void,
): Promise<() => void> {
  const unlisten = await listen<BrowserWindowClosedEvent>(
    'aurora:browser-window-closed',
    (event) => callback(event.payload),
  );
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

/**
 * Read the live theme tokens off Aurora's `<html>` element so we can
 * forward them into the previewed page (which is on a different
 * origin and therefore cannot see Aurora's CSS variables).
 */
export function readBrowserThemeTokens(): BrowserThemeTokens {
  const root = document.documentElement;
  const cs = window.getComputedStyle(root);
  const get = (name: string, fallback: string) => {
    const value = cs.getPropertyValue(name).trim();
    return value || fallback;
  };
  return {
    background: get('--aurora-sidebar-background', '#0f1115'),
    foreground: get('--aurora-editor-foreground', '#e4e4e7'),
    border: get('--aurora-common-border', '#27272a'),
    primary: get('--aurora-common-primary', '#6366f1'),
    primaryForeground: get('--aurora-common-primary-foreground', '#ffffff'),
    muted: get('--aurora-sidebar-foreground', '#a1a1aa'),
    shadow: get('--aurora-common-shadow', 'rgba(0,0,0,0.45)'),
  };
}
