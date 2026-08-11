/**
 * Agent Window — is the agent driving the Browser panel right now? [store]
 *
 * The panel's page is a native webview that paints ABOVE the React DOM. When
 * the agent clicks something, scrolls, or swaps the URL, the page moves under
 * the user with nothing on screen saying who moved it — it looks identical to
 * the page acting on its own. This store is what the panel reads to say so.
 *
 * Rust owns the truth: `tools::browser::halo` wraps every browser tool and
 * emits `aurora:agent-browser-activity` with `{ tool, active }` around the
 * call, from a drop guard, so an errored or cancelled tool still sends the
 * `false`. `useAgentBrowserDrivingEvents` is the listener half.
 *
 * Deliberately NOT persisted and NOT part of workspace state: it describes the
 * next few hundred milliseconds. Restoring it on launch would greet the user
 * with a claim that something is happening.
 */

import { create } from "zustand";

/**
 * How long the cue stays up once the tool has finished.
 *
 * `browser_status` can return in under 50ms. A cue that appears and vanishes
 * inside one frame budget does not read as "the agent looked at the page" — it
 * reads as a rendering glitch, which is worse than showing nothing. This is the
 * floor that turns a fast call into something a person can actually see.
 */
export const MIN_VISIBLE_MS = 700;

/**
 * Ceiling on how long the cue may claim the agent is driving without hearing
 * from Rust again.
 *
 * The drop guard makes a missing `false` very unlikely, but "very unlikely"
 * failure modes on a status indicator are the ones that matter: a cue stuck on
 * forever teaches the user to stop believing it. Well above any real call —
 * opening the panel alone can take ~6s, and a settle up to 5s on top — so this
 * only ever fires when a signal was genuinely lost.
 */
export const MAX_DRIVING_MS = 60_000;

interface AgentBrowserDrivingState {
  /** The browser tool currently driving the panel, or `null` when idle. */
  driving: string | null;
  /** A browser tool has started. */
  begin: (tool: string) => void;
  /** A browser tool has finished; the cue lingers to [`MIN_VISIBLE_MS`]. */
  end: (tool: string) => void;
  /** Drop the cue immediately (panel torn down, listener detached). */
  reset: () => void;
}

/**
 * Timer state lives outside the store on purpose: it is machinery, not
 * something a component should ever be able to subscribe to and re-render on.
 */
let clearTimer: number | null = null;
let startedAt = 0;

function cancelPending(): void {
  if (clearTimer !== null) {
    window.clearTimeout(clearTimer);
    clearTimer = null;
  }
}

export const useAgentBrowserDriving = create<AgentBrowserDrivingState>((set, get) => ({
  driving: null,

  begin: (tool) => {
    // A new tool during the previous one's linger takes over the cue rather
    // than queueing behind it — the label must name what is happening NOW.
    cancelPending();
    startedAt = Date.now();
    set({ driving: tool });

    clearTimer = window.setTimeout(() => {
      clearTimer = null;
      // Only clear if this same call is still the one on screen.
      if (get().driving === tool) set({ driving: null });
    }, MAX_DRIVING_MS);
  },

  end: (tool) => {
    // A late `false` from a call that has already been superseded must not
    // pull the cue off the tool that replaced it.
    if (get().driving !== tool) return;
    cancelPending();

    const remaining = Math.max(0, MIN_VISIBLE_MS - (Date.now() - startedAt));
    if (remaining === 0) {
      set({ driving: null });
      return;
    }
    clearTimer = window.setTimeout(() => {
      clearTimer = null;
      if (get().driving === tool) set({ driving: null });
    }, remaining);
  },

  reset: () => {
    cancelPending();
    set({ driving: null });
  },
}));

/**
 * What to call each browser tool in front of the user.
 *
 * Plain verbs, not tool names: the person watching the panel wants to know
 * what is being done to their page, and `browser_a11y_tree` is Aurora's
 * vocabulary, not theirs. Present participles because the cue is only ever on
 * screen while it is still true.
 */
const DRIVING_LABELS: Record<string, string> = {
  browser_status: "Checking the page",
  browser_navigate: "Opening a page",
  browser_view: "Reading the page",
  browser_page_outline: "Reading the page",
  browser_screenshot: "Taking a screenshot",
  browser_get_console_logs: "Reading the console",
  browser_inspect_element: "Inspecting an element",
  browser_click: "Clicking",
  browser_fill: "Typing",
  browser_scroll: "Scrolling",
  browser_set_viewport: "Changing the screen size",
  browser_emulate_media: "Changing the page theme",
  browser_press_key: "Pressing a key",
  browser_hover: "Hovering",
  browser_a11y_tree: "Reading the page structure",
};

/**
 * The cue's label for a tool name.
 *
 * An unmapped tool — a new one added to the bucket without a label here —
 * falls back to the honest generic rather than to a raw `browser_*` name.
 */
export function drivingLabel(tool: string): string {
  return DRIVING_LABELS[tool] ?? "Working in the page";
}
