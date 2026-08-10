/**
 * Agent Window — "Open in IDE" (adapter / outbound channel).
 *
 * The agent window is VIEW-ONLY: it shows files/diffs but never edits. To edit,
 * the file is handed to the main Aurora IDE window. This invokes the backend
 * `agent_open_in_ide` command, which (from Rust, so it isn't blocked by OS
 * foreground rules) brings the IDE window to the front and asks it to open the
 * file in Monaco via the main window's listener.
 *
 * Why a command and not a JS event: a background webview emitting a global event
 * and hoping the main window focuses itself is unreliable — the OS blocks a
 * background window from stealing the foreground, so the IDE stayed buried or the
 * click appeared to do nothing. The backend owns every window, so it can focus
 * the IDE for real and report an error (e.g. the main window is closed) instead
 * of failing silently.
 *
 * Pass an ABSOLUTE path: the agent window may be scoped to a different project
 * than the IDE's current workspace, so a relative path can't be resolved there.
 */

import { auroraInvoke } from "@/kernel/lib/ipc/runtime";
import { isTauri } from "@/kernel/lib/ipc/tauri";

/**
 * Show the IDE window without opening any particular file.
 *
 * `openInIde` needs a path, so it cannot serve as the way back to the editor
 * when the agent window is the only surface a launch opened (`agw`, or the
 * Startup preference) and no file has been touched yet. The backend shows the
 * window when it exists — including when it is merely hidden — and rebuilds it
 * when it does not.
 */
export async function openIdeWindow(): Promise<void> {
  if (!isTauri()) {
    console.warn("[agent-window] openIdeWindow requires the Aurora runtime");
    return;
  }
  try {
    await auroraInvoke("open_ide_window");
  } catch (err) {
    console.error("[agent-window] openIdeWindow failed:", err);
  }
}

export async function openInIde(path: string, line?: number): Promise<void> {
  if (!path) return;
  if (!isTauri()) {
    console.warn("[agent-window] openInIde requires the Aurora runtime");
    return;
  }
  try {
    await auroraInvoke("agent_open_in_ide", { path, line });
  } catch (err) {
    // The command rejects with a human-readable reason (e.g. the main window is
    // closed). Surface it so the click never just silently no-ops.
    console.error("[agent-window] openInIde failed:", err);
  }
}
