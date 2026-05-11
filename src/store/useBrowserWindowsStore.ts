import { create } from 'zustand';

import {
  listBrowserWindows,
  onBrowserWindowClosed,
  onBrowserWindowOpened,
  type BrowserWindowSummary,
} from '../services/browser-service';

/**
 * Live registry of every native browser WebView the BrowserManager
 * knows about — both windows the user opened from the IDE and ones
 * the agent created via `browser_open`. Backed by:
 *
 *  - `list_browser_windows` IPC (initial hydrate + manual refresh)
 *  - `aurora:browser-window-opened` event (delta on create_window)
 *  - `aurora:browser-window-closed` event (delta on destroy)
 *
 * Two consumers as of this round: the TitleBar Browser button popover
 * (so a click can list and adopt an existing window) and the in-tab
 * window selector chip (so a single tab can be re-targeted at a
 * different live window without closing).
 *
 * The store self-subscribes lazily on first call so callers don't
 * need to wire up a top-level effect.
 */

interface BrowserWindowsState {
  windows: BrowserWindowSummary[];
  isHydrated: boolean;
  hydrate: () => Promise<void>;
  refresh: () => Promise<void>;
  getByLabel: (label: string) => BrowserWindowSummary | undefined;
}

let subscriptionStarted = false;

async function ensureSubscriptions() {
  if (subscriptionStarted) return;
  subscriptionStarted = true;

  // Note: we keep the unlisten handles alive for the lifetime of the
  // app. The store has no teardown — there's only ever one of it.
  await onBrowserWindowOpened((event) => {
    useBrowserWindowsStore.setState((state) => {
      const exists = state.windows.some((w) => w.label === event.label);
      if (exists) {
        return {
          windows: state.windows.map((w) =>
            w.label === event.label ? { ...w, ...event } : w,
          ),
        };
      }
      return { windows: [...state.windows, event] };
    });
  });

  await onBrowserWindowClosed((event) => {
    useBrowserWindowsStore.setState((state) => ({
      windows: state.windows.filter((w) => w.label !== event.label),
    }));
  });
}

export const useBrowserWindowsStore = create<BrowserWindowsState>((set, get) => ({
  windows: [],
  isHydrated: false,

  hydrate: async () => {
    if (get().isHydrated) return;
    await ensureSubscriptions();
    try {
      const windows = await listBrowserWindows();
      set({ windows, isHydrated: true });
    } catch (e) {
      console.warn('[useBrowserWindowsStore] hydrate failed', e);
      set({ isHydrated: true });
    }
  },

  refresh: async () => {
    await ensureSubscriptions();
    try {
      const windows = await listBrowserWindows();
      set({ windows, isHydrated: true });
    } catch (e) {
      console.warn('[useBrowserWindowsStore] refresh failed', e);
    }
  },

  getByLabel: (label: string) =>
    get().windows.find((w) => w.label === label),
}));
