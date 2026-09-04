/**
 * Agent Window — where each side of the product switcher was left (leaf, non-component).
 *
 * Aurora Chat and Aurora Build hold their own conversations in their own
 * stores. Flipping between them should land you where you were, the way
 * switching apps does — but only if "where you were" is still what you came
 * back for.
 */

import type { AuroraSurface } from "@/apps/agent/services/runtime/agent-execution-mode";

/** Per window, so `localStorage` rather than the settings row. */
export const SURFACE_THREAD_KEY = "aurora.surface.lastThread";

/**
 * How stale a conversation may be and still be resumed on switching back.
 *
 * Alvan's rule, and the reasoning holds: coming back an hour later you are
 * continuing something; coming back tomorrow you are starting something.
 * Dropping into yesterday's conversation is more disorienting than an empty
 * composer, because the composer is obviously ready to type in and an old
 * transcript looks like state you have to read first.
 */
export const SURFACE_RESUME_WINDOW_MS = 2 * 60 * 60 * 1000;

/** What `recentSurfaceThread` needs from a thread. Structural, so tests pass literals. */
export interface ResumableThread {
  id: string;
  updatedAt?: string | null;
}

type Remembered = Partial<Record<AuroraSurface, string>>;

function read(): Remembered {
  try {
    const raw = localStorage.getItem(SURFACE_THREAD_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    // A hand-edited or half-written value must not throw on every switch.
    return parsed && typeof parsed === "object" ? (parsed as Remembered) : {};
  } catch {
    return {};
  }
}

export function rememberSurfaceThread(surface: AuroraSurface, threadId: string): void {
  try {
    const map = read();
    map[surface] = threadId;
    localStorage.setItem(SURFACE_THREAD_KEY, JSON.stringify(map));
  } catch {
    // A window that cannot remember still works; it just always opens fresh.
  }
}

export function forgetSurfaceThread(surface: AuroraSurface): void {
  try {
    const map = read();
    delete map[surface];
    localStorage.setItem(SURFACE_THREAD_KEY, JSON.stringify(map));
  } catch {
    // Best-effort, same as above.
  }
}

/**
 * The conversation to reopen on `surface`, or `null` for the empty state.
 *
 * Recency comes from the thread's OWN `updatedAt`, not from a timestamp written
 * when we left it. The thread is the thing that has to be recent, and a turn
 * that finished in the background after the switch counts as activity — which a
 * stored departure time would miss.
 *
 * `threads` is that surface's current list, so an id that has been deleted, or
 * that belongs to the other store, resolves to `null` rather than to a
 * conversation that cannot be opened.
 */
export function recentSurfaceThread(
  surface: AuroraSurface,
  threads: readonly ResumableThread[],
  now: number = Date.now(),
): string | null {
  const remembered = read()[surface];
  if (!remembered) return null;

  const thread = threads.find((t) => t.id === remembered);
  if (!thread?.updatedAt) return null;

  const updated = Date.parse(thread.updatedAt);
  if (!Number.isFinite(updated)) return null;

  const age = now - updated;
  // A future timestamp (clock skew, a bad sidecar) is not stale. It is the most
  // recently touched thing there is, so it resumes.
  if (age > SURFACE_RESUME_WINDOW_MS) return null;
  return thread.id;
}
