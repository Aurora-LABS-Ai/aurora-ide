/**
 * Hand a URL to the user's real browser.
 *
 * The agent window is a webview, and a link that navigates it replaces the
 * product with a web page and offers no way back. Canvas frames make this
 * sharper still: they run on `sandbox="allow-scripts"`, so an `<a
 * target="_blank">` inside one is silently inert — a citation you can click
 * where nothing happens.
 *
 * Only `http:` and `https:` are opened. The href on a canvas comes from model
 * output, and `file:` or a shell-adjacent scheme reaching the OS opener is a
 * way out of the sandbox rather than a link.
 */
export async function openExternalUrl(url: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    console.warn("[open-external] not a URL:", url);
    return;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    console.warn("[open-external] refused a non-web link:", parsed.protocol);
    return;
  }
  try {
    const { open } = await import("@tauri-apps/plugin-shell");
    await open(parsed.toString());
  } catch (error) {
    console.warn("[open-external] failed to open:", error);
  }
}
