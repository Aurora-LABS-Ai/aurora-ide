/**
 * Pure rules for the dock's browser tabs: what an address bar entry means,
 * what a tab is called, and how a new page is named.
 */

/**
 * What the address bar should load for `input`: a scheme as-is, a bare host
 * (`kick.com`, `localhost:5173`) over http(s), anything else a web search.
 */
export function normalizeAddress(input: string): string {
  const t = input.trim();
  if (!t) return "about:blank";
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t) || t.startsWith("about:")) return t;
  // Local servers speak plain http; `https://localhost:5173` would fail the
  // TLS handshake against every dev server that has no certificate.
  if (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/.*)?$/i.test(t)) return `http://${t}`;
  if (/^[^\s]+\.[^\s]{2,}(\/.*)?$/.test(t)) return `https://${t}`;
  return `https://www.google.com/search?q=${encodeURIComponent(t)}`;
}

/**
 * A tab's name while the page has not said its own: the host, with the port
 * for local servers (`localhost:5173` is the whole point of that tab).
 */
export function addressTitle(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "about:") return "New tab";
    return parsed.host || url;
  } catch {
    return url;
  }
}

/**
 * A fresh page label for a browser tab the user opened. Rust requires the
 * `browser-` prefix and nothing but letters, digits, `-` and `_`
 * (`sanitize_label` in `services/browser_runtime.rs`).
 */
export function userBrowserLabel(): string {
  const random = Math.random().toString(36).slice(2, 10);
  return `browser-tab-${Date.now().toString(36)}${random}`;
}
