/**
 * Agent Window — browser address history (feature state).
 *
 * Remembers recently-visited URLs so the address bar can offer them (plus the
 * common local dev-server ports) as one-click suggestions. Persisted per machine.
 */

import { create } from "zustand";
import { persist } from "zustand/middleware";

const MAX = 8;

interface AgentBrowserHistoryState {
  recent: string[];
  push: (url: string) => void;
}

export const useAgentBrowserHistory = create<AgentBrowserHistoryState>()(
  persist(
    (set) => ({
      recent: [],
      push: (url) =>
        set((s) => {
          const u = url.trim();
          if (!u || u === "about:blank") return {};
          return { recent: [u, ...s.recent.filter((x) => x !== u)].slice(0, MAX) };
        }),
    }),
    { name: "aurora-agent-browser-history" },
  ),
);

/** Common local dev servers, offered for fast click-and-load. */
export const DEV_SERVERS: Array<{ label: string; url: string }> = [
  { label: "Vite", url: "http://localhost:5173" },
  { label: "React / Next", url: "http://localhost:3000" },
  { label: "Next (alt)", url: "http://localhost:3001" },
  { label: "Angular", url: "http://localhost:4200" },
  { label: "Python / Django", url: "http://localhost:8000" },
  { label: "Common", url: "http://localhost:8080" },
];
