/**
 * Agent Window — live filesystem watch (adapter / inbound channel).
 *
 * Keeps the Files tree (and `@`-mention index) in sync with the real disk so a
 * file created/renamed/deleted OUTSIDE the app — e.g. dropped into the folder
 * from Windows Explorer, or written by another tool — shows up here without a
 * manual refresh.
 *
 * How it works:
 *  - We drive the Rust `notify` recursive watcher (`start_fs_watcher`) on the
 *    project root. It's the backend's debounced, ignore-aware watcher (skips
 *    `.git`, `node_modules`, `target`, `dist`, …) — NOT a TypeScript re-walk.
 *  - It emits the app-global `fs-changed` event (`{ paths, kind }`); we debounce
 *    a burst and hand the touched paths to the files store, which re-reads only
 *    the affected loaded directories.
 *
 * This is independent of the IDE explorer's own watcher (a separate handle); the
 * legacy global `start_fs_watcher` slot is unused by the IDE frontend, so the
 * agent window owns it cleanly. Both watchers emit the same `fs-changed` event.
 */

import { useEffect } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import { isAuroraRuntimeAvailable } from "../../lib/runtime";
import { startFsWatcher } from "../../lib/tauri";
import { invalidateFileIndex } from "../adapters/file-index";
import { useAgentChatStore } from "../store/useAgentChatStore";
import { useAgentFilesStore } from "../store/useAgentFilesStore";

interface FsChangedPayload {
  paths?: string[];
  kind?: string;
}

const DEBOUNCE_MS = 140;

/** Mount once (in the always-on shell) to keep the file surfaces disk-fresh. */
export function useAgentFsWatch(): void {
  const projectRoot = useAgentChatStore((s) => s.projectRoot);

  useEffect(() => {
    if (!projectRoot || !isAuroraRuntimeAvailable()) return;

    let cancelled = false;
    let unlisten: UnlistenFn | null = null;
    let pending: string[] = [];
    let timer: ReturnType<typeof setTimeout> | null = null;

    const flush = () => {
      timer = null;
      const batch = pending;
      pending = [];
      if (batch.length === 0) return;
      useAgentFilesStore.getState().applyFsChange(batch);
      // The mention index is a flat cached walk — drop it so new/removed files
      // surface in `@` too (rebuilt lazily on next mention).
      invalidateFileIndex(projectRoot);
    };

    const onChange = (paths: string[]) => {
      pending.push(...paths);
      if (timer) clearTimeout(timer);
      timer = setTimeout(flush, DEBOUNCE_MS);
    };

    const start = async () => {
      // Ensure a recursive watcher is live on our root (idempotent — the backend
      // replaces any existing legacy watcher). Failure is non-fatal: the tree
      // still works, it just won't auto-refresh.
      try {
        await startFsWatcher(projectRoot);
      } catch (err) {
        console.warn("[agent-window] start_fs_watcher failed:", err);
      }
      try {
        const off = await listen<FsChangedPayload>("fs-changed", (event) => {
          if (cancelled) return;
          const payload = event.payload;
          if (!payload || payload.kind === "access") return;
          const paths = payload.paths ?? [];
          if (paths.length > 0) onChange(paths);
        });
        if (cancelled) off();
        else unlisten = off;
      } catch (err) {
        console.warn("[agent-window] fs-changed subscribe failed:", err);
      }
    };

    void start();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      if (unlisten) unlisten();
      // Leave the backend watcher running — cheap, and the next root bind
      // replaces it. Stopping here would race other windows on the shared slot.
    };
  }, [projectRoot]);
}
