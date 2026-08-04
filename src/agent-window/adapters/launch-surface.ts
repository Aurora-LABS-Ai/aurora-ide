/**
 * Agent Window — startup surface preference (adapter / outbound channel).
 *
 * Which window Aurora opens when it is launched from its app icon with no
 * arguments. Backed by `<AuroraIDE>/launch.json`, NOT the settings database:
 * Rust has to read this before `tauri::Builder` is constructed, which is long
 * before SQLite is initialised (see `src-tauri/src/launch_prefs.rs`). That is
 * also why this goes through its own commands instead of `databaseService`.
 *
 * Reads never throw — an unreadable or missing preference resolves to the IDE,
 * matching what the backend will actually do on the next launch, so the control
 * can't display a state the boot path disagrees with.
 */

import { auroraInvoke } from "../../lib/runtime";
import { isTauri } from "../../lib/tauri";

/** The window a bare launch opens. Mirrors Rust's `LaunchSurface`. */
export type LaunchSurface = "ide" | "agent";

export const DEFAULT_LAUNCH_SURFACE: LaunchSurface = "ide";

function isLaunchSurface(value: unknown): value is LaunchSurface {
  return value === "ide" || value === "agent";
}

/** Read the saved startup surface. Falls back to the IDE, never rejects. */
export async function getLaunchSurface(): Promise<LaunchSurface> {
  if (!isTauri()) return DEFAULT_LAUNCH_SURFACE;
  try {
    const surface = await auroraInvoke<unknown>("get_launch_surface");
    return isLaunchSurface(surface) ? surface : DEFAULT_LAUNCH_SURFACE;
  } catch (err) {
    console.warn("[agent-window] could not read the startup surface:", err);
    return DEFAULT_LAUNCH_SURFACE;
  }
}

/**
 * Persist the startup surface.
 *
 * Rejects on failure rather than swallowing it — the caller shows the saved
 * state, and a control that reports success while the file never changed would
 * lie about what the next launch does.
 */
export async function setLaunchSurface(surface: LaunchSurface): Promise<void> {
  if (!isTauri()) return;
  await auroraInvoke("set_launch_surface", { surface });
}
