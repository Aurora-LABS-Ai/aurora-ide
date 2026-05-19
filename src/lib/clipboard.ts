/**
 * Robust clipboard write that works inside the Tauri webview.
 *
 * The plain `navigator.clipboard.writeText` call frequently *resolves*
 * inside a Tauri/WebView2 context without actually updating the OS
 * clipboard — the runtime treats the webview origin as insecure for
 * the async Clipboard API, so writes either reject or silently no-op.
 * Production-grade fix is to prefer Tauri's native clipboard plugin
 * (which has explicit permission wired in
 * `src-tauri/capabilities/default.json`) and only fall back to the web
 * APIs for non-Tauri environments (tests, dev preview server, etc.).
 *
 * Order:
 *   1. Tauri `@tauri-apps/plugin-clipboard-manager` — always works in app.
 *   2. `navigator.clipboard.writeText` — modern web browsers.
 *   3. Hidden textarea + `document.execCommand('copy')` — last-resort
 *      legacy path for environments where neither of the above are
 *      usable.
 *
 * Returns true on success; never throws (frees callers from try/catch).
 *
 * Centralised here because every place that exposes a "copy code"
 * button used to inline its own `navigator.clipboard.writeText` call
 * which broke quietly inside the Tauri shell. Having one helper means
 * one place to keep current as Tauri's plugin APIs evolve.
 */
import { isTauri } from './tauri';

export async function writeClipboardText(text: string): Promise<boolean> {
  if (isTauri()) {
    try {
      const { writeText } = await import('@tauri-apps/plugin-clipboard-manager');
      await writeText(text);
      return true;
    } catch (err) {
      console.warn('[clipboard] Tauri plugin failed, falling back:', err);
    }
  }

  try {
    if (
      typeof navigator !== 'undefined' &&
      navigator.clipboard &&
      typeof navigator.clipboard.writeText === 'function'
    ) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (err) {
    console.warn('[clipboard] navigator.clipboard failed, falling back:', err);
  }

  try {
    if (typeof document === 'undefined') return false;
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.top = '0';
    textarea.style.left = '0';
    textarea.style.opacity = '0';
    textarea.style.pointerEvents = 'none';
    document.body.appendChild(textarea);
    textarea.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(textarea);
    return ok;
  } catch (err) {
    console.error('[clipboard] All clipboard write strategies failed:', err);
    return false;
  }
}
