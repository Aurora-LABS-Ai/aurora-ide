/**
 * Restore the open chat across an in-window page reload.
 *
 * The agent window reloads without being recreated in two cases: the user
 * hits Ctrl+R, or the native renderer-crash recovery (`webview_recovery.rs`)
 * calls `Reload()` after WebView2's render process dies. React state is gone
 * either way, and `useAgentChatStore.currentThreadId` is deliberately not
 * persisted (a fresh window must open on the project home, and the IDE/agent
 * windows must never fight over a shared "last thread").
 *
 * `sessionStorage` threads that needle: it is scoped to this OS window's
 * browsing session, so it survives reloads of the same window (including
 * crash-recovery reloads) but starts empty for every newly created window.
 *
 * The hook keeps a `{ id, ws }` snapshot of the open chat up to date on every
 * selection change, and on mount (after the store has bound its project) it
 * re-selects the saved chat. `selectThread` already handles re-attaching to a
 * still-running turn, so a crash mid-run recovers into the live transcript.
 */

import { useEffect } from "react";
import { useAgentChatStore } from "@/apps/agent/store/conversation/useAgentChatStore";

const RELOAD_THREAD_KEY = "agw:reload-thread";

interface ReloadThreadSnapshot {
  id: string;
  ws: string | null;
}

function readSnapshot(): ReloadThreadSnapshot | null {
  try {
    const raw = window.sessionStorage.getItem(RELOAD_THREAD_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as ReloadThreadSnapshot).id === "string"
    ) {
      return parsed as ReloadThreadSnapshot;
    }
  } catch {
    // Storage disabled or corrupt marker — treat as a fresh window.
  }
  return null;
}

function writeSnapshot(snapshot: ReloadThreadSnapshot | null): void {
  try {
    if (snapshot) {
      window.sessionStorage.setItem(RELOAD_THREAD_KEY, JSON.stringify(snapshot));
    } else {
      window.sessionStorage.removeItem(RELOAD_THREAD_KEY);
    }
  } catch {
    // Best-effort — a full or disabled storage only costs the restore.
  }
}

/** Restore the previously open chat after a reload of this same window. */
export function restoreThreadAfterReload(): void {
  const saved = readSnapshot();
  if (!saved) return;
  void useAgentChatStore.getState().selectThread(saved.id, saved.ws ?? undefined);
}

/**
 * Subscribe the snapshot to chat-selection changes. Returns the
 * unsubscribe. (Plain function so the sync behavior is unit-testable
 * without a React renderer.)
 */
export function trackThreadForReload(): () => void {
  return useAgentChatStore.subscribe((state, prev) => {
    if (state.currentThreadId === prev.currentThreadId) return;
    writeSnapshot(
      state.currentThreadId
        ? { id: state.currentThreadId, ws: state.projectRoot }
        : null,
    );
  });
}

/** Keep the reload snapshot in sync with the currently open chat. */
export function useReloadRestore(): void {
  useEffect(() => trackThreadForReload(), []);
}
