/**
 * Agent Window — per-chat composer draft store (feature state).
 *
 * The composer is normally wiped on send and unmounted-clean on chat switch, so
 * a half-written message is lost the moment you glance at another chat. This
 * store keeps the composer's in-progress TEXT keyed by a draft key so switching
 * chats (or reopening the window) restores exactly what you were typing.
 *
 * Draft keys:
 *   - an open chat → its `threadId`,
 *   - the centered "new chat" home → {@link newChatDraftKey} (scoped per project,
 *     so an unsent idea in project A survives while you dip into project B).
 *
 * Only plain text is persisted (pills/attachments belong to a fresh compose);
 * empty drafts are pruned so the map never accumulates blank entries. Persisted
 * to localStorage so a draft also survives an app restart ("recovery").
 */

import { create } from "zustand";
import { persist } from "zustand/middleware";

/** Draft key for the centered new-chat home, scoped to the active project. */
export function newChatDraftKey(projectRoot: string | null): string {
  return `new:${projectRoot ?? ""}`;
}

interface AgentDraftState {
  /** key → in-progress composer text (blank entries are never stored). */
  drafts: Record<string, string>;
  /** Read a draft (empty string when none). */
  getDraft: (key: string) => string;
  /** Save (or, when blank, clear) a draft under `key`. No-op when unchanged. */
  setDraft: (key: string, text: string) => void;
  /** Drop a draft entirely. */
  clearDraft: (key: string) => void;
}

export const useAgentDraftStore = create<AgentDraftState>()(
  persist(
    (set, get) => ({
      drafts: {},

      getDraft: (key) => get().drafts[key] ?? "",

      setDraft: (key, text) =>
        set((s) => {
          if ((s.drafts[key] ?? "") === text) return s;
          const next = { ...s.drafts };
          if (text) next[key] = text;
          else delete next[key];
          return { drafts: next };
        }),

      clearDraft: (key) =>
        set((s) => {
          if (!(key in s.drafts)) return s;
          const next = { ...s.drafts };
          delete next[key];
          return { drafts: next };
        }),
    }),
    { name: "aurora-agent-window-drafts" },
  ),
);
