/**
 * Browser History Store
 *
 * Persistent log of URLs the user has visited from the in-IDE browser
 * tab. Used to populate the URL bar's recent-suggestions dropdown so a
 * fresh tab still feels like it remembers what you were doing.
 *
 * Persistence: serialized as JSON into the `browser.recent_urls`
 * key of the `app_settings` SQLite table via `databaseService`.
 * Hydration runs once at app startup; writes are debounced.
 */
import { create } from "zustand";

import { databaseService } from "../services/database";

const SETTINGS_KEY = "browser.recent_urls";
const MAX_ENTRIES = 50;
const PERSIST_DEBOUNCE_MS = 400;

export interface RecentUrl {
  url: string;
  lastVisited: number;
  visitCount: number;
}

interface BrowserHistoryState {
  recent: RecentUrl[];
  hydrated: boolean;
  hydrate: () => Promise<void>;
  recordVisit: (url: string) => void;
  clear: () => void;
}

let persistTimer: ReturnType<typeof setTimeout> | null = null;

const schedulePersist = (recent: RecentUrl[]) => {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    databaseService
      .setSetting(SETTINGS_KEY, JSON.stringify(recent))
      .catch((err) => console.warn("[browserHistory] persist failed:", err));
  }, PERSIST_DEBOUNCE_MS);
};

const normalizeUrlKey = (url: string): string => {
  // The dropdown should treat `http://localhost:3000/` and
  // `http://localhost:3000` as the same entry.
  return url.replace(/\/+$/, "").trim();
};

export const useBrowserHistoryStore = create<BrowserHistoryState>((set, get) => ({
  recent: [],
  hydrated: false,

  hydrate: async () => {
    if (get().hydrated) return;
    try {
      const raw = await databaseService.getSetting(SETTINGS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as RecentUrl[];
        if (Array.isArray(parsed)) {
          set({ recent: parsed.slice(0, MAX_ENTRIES), hydrated: true });
          return;
        }
      }
    } catch (err) {
      console.warn("[browserHistory] hydrate failed:", err);
    }
    set({ hydrated: true });
  },

  recordVisit: (url) => {
    const key = normalizeUrlKey(url);
    if (!key || key === "about:blank") return;
    set((state) => {
      const existing = state.recent.find((entry) => normalizeUrlKey(entry.url) === key);
      const others = state.recent.filter(
        (entry) => normalizeUrlKey(entry.url) !== key,
      );
      const updated: RecentUrl = {
        url: key,
        lastVisited: Date.now(),
        visitCount: (existing?.visitCount ?? 0) + 1,
      };
      const next = [updated, ...others].slice(0, MAX_ENTRIES);
      schedulePersist(next);
      return { recent: next };
    });
  },

  clear: () => {
    set({ recent: [] });
    schedulePersist([]);
  },
}));

/**
 * Common dev-server ports shown in the URL bar dropdown's
 * "Quick start" section. Order matches typical user expectations
 * (Next/CRA first, Vite/Astro/Nuxt next, then less common).
 */
export const COMMON_DEV_PORTS = [
  3000, // Next.js / CRA / Express
  5173, // Vite / Astro
  8080, // Generic / webpack-dev-server
  4173, // Vite preview
  4000, // Phoenix / generic
  8000, // Django / Python http.server
  8888, // Jupyter / generic
] as const;

export const buildLocalhostUrl = (port: number): string =>
  `http://localhost:${port}`;
