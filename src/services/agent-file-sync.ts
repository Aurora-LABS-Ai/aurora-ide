/**
 * Agent → IDE file-change sync.
 *
 * Bridges the Rust runtime's `agent_file_changed` Tauri event into the
 * frontend's three stale-state worry points:
 *
 *   1. Monaco's live buffer for any tab open on the changed path.
 *      Routed through `commitStreamedMonacoFileContent` /
 *      `replaceMonacoFileContent` so the AI write lands as one
 *      undoable entry on Monaco's native stack — Ctrl+Z reverts the
 *      AI edit just like a user paste, exactly how VS Code / Cursor
 *      / JetBrains behave.
 *
 *   2. The Zustand tab state (`useEditorStore`). After the Monaco
 *      model is updated we call `reloadTabContent` so the React-level
 *      `tab.content` matches and the dirty flag is cleared. For
 *      deletes we set `isDeleted: true` so the tab shows the "file
 *      no longer exists" banner instead of silently going stale.
 *
 *   3. The explorer tree. Created / Deleted / Renamed events arrive
 *      via the same channel so the file tree refreshes without a
 *      manual reload.
 *
 * The event is emitted by every mutating Rust tool (`file_write`,
 * `file_create`, `file_patch`, `search_replace`,
 * `multi_search_replace`, `file_delete`, `folder_create`,
 * `folder_delete`) AFTER the disk write succeeds. The payload's
 * `toolCallId` is used to find the in-flight live-preview session so
 * the final commit can pick up the original (pre-AI) content snapshot
 * for proper undo semantics.
 *
 * This module wires up exactly ONE listener for the app's lifetime —
 * it's idempotent. Call `startAgentFileSync()` once during app
 * bootstrap (e.g. in `main.tsx`); subsequent calls no-op.
 */

import { auroraListen } from "../lib/runtime";
import {
  commitStreamedMonacoFileContent,
  getMonacoEditorForPath,
  replaceMonacoFileContent,
} from "../lib/monaco-editor-ref";
import { useEditorStore } from "../store/useEditorStore";
import { liveFilePreviewService } from "./live-file-preview";

export type FileChangeKind = "created" | "modified" | "deleted" | "renamed";

export interface AgentFileChangedPayload {
  path: string;
  kind: FileChangeKind;
  content?: string;
  isDirectory: boolean;
  oldPath?: string;
  sourceTool?: string;
  toolCallId?: string;
}

const normalizePath = (path: string): string => path.replace(/\\/g, "/");

const findTabForPath = (path: string) => {
  const normalized = normalizePath(path);
  const { tabs } = useEditorStore.getState();
  return (
    tabs.find((t) => t.path === path) ??
    tabs.find((t) => normalizePath(t.path) === normalized)
  );
};

let pendingExplorerRefresh = false;
const refreshExplorerSoon = async () => {
  // Coalesce multiple file_changed events that arrive in the same
  // tool batch into a single explorer refresh. Without this, an
  // agent that runs 5 `file_write`s in a row would trigger 5
  // back-to-back `explorer_refresh` IPC calls — each reading the
  // workspace tree from disk.
  if (pendingExplorerRefresh) return;
  pendingExplorerRefresh = true;

  // Use a microtask + queueMicrotask-style yield so we coalesce
  // events from the same tick, but don't introduce visible lag.
  queueMicrotask(async () => {
    try {
      const { useWorkspaceStore } = await import("../store/useWorkspaceStore");
      const refresh = useWorkspaceStore.getState().refreshDirectory;
      if (typeof refresh === "function") {
        await refresh();
      }
    } catch (err) {
      console.warn("[agent-file-sync] explorer refresh failed:", err);
    } finally {
      pendingExplorerRefresh = false;
    }
  });
};

/**
 * Apply a Modified/Created event to the open tab (if any) and the
 * explorer tree.
 *
 * Streaming-aware: if the live-preview service has been driving
 * partial content for this `toolCallId`, we honour it by snapping the
 * model from the original (pre-AI) snapshot to the final committed
 * content in a single undoable push. Otherwise (no preview session,
 * e.g. the file wasn't open when the tool started), we do a direct
 * `replaceMonacoFileContent` — also one undo entry.
 */
const applyFileWritten = (payload: AgentFileChangedPayload) => {
  if (payload.isDirectory || payload.content === undefined) {
    // Folder creates and createless modified events skip the Monaco
    // path entirely — there's no buffer to refresh.
    void refreshExplorerSoon();
    return;
  }

  const tab = findTabForPath(payload.path);
  const editor = getMonacoEditorForPath(payload.path);
  const finalContent = payload.content;

  if (editor) {
    // Prefer the streaming-commit path so the AI edit is one undoable
    // entry built on top of whatever the preview already painted in.
    const previewState = payload.toolCallId
      ? liveFilePreviewService.getSessionSnapshot(payload.toolCallId)
      : null;
    const originalContent =
      previewState?.originalTabContent ??
      previewState?.originalContent ??
      tab?.content ??
      "";

    if (previewState) {
      commitStreamedMonacoFileContent(
        payload.path,
        originalContent,
        finalContent,
      );
    } else {
      replaceMonacoFileContent(payload.path, finalContent);
    }
  }

  if (tab) {
    useEditorStore.getState().reloadTabContent(tab.id, finalContent);
  }

  if (payload.toolCallId) {
    // The live preview session has done its job — close it so the
    // session map doesn't grow forever and a future tool with the
    // same id starts fresh.
    liveFilePreviewService.complete(payload.toolCallId);
  }

  if (payload.kind === "created") {
    void refreshExplorerSoon();
  }
};

const applyFileDeleted = (payload: AgentFileChangedPayload) => {
  if (!payload.isDirectory) {
    const tab = findTabForPath(payload.path);
    if (tab) {
      useEditorStore.getState().markTabAsDeleted(tab.id);
    }
  }

  if (payload.toolCallId) {
    liveFilePreviewService.complete(payload.toolCallId);
  }

  void refreshExplorerSoon();
};

const applyFileRenamed = (payload: AgentFileChangedPayload) => {
  // No tool currently emits Renamed (folder_move isn't an agent tool
  // yet), but the channel reserves the slot — when it lands we update
  // the open tab's path/id so the next save writes to the new
  // location, and refresh the explorer.
  if (payload.oldPath) {
    const tab = findTabForPath(payload.oldPath);
    if (tab) {
      useEditorStore.setState((state) => ({
        tabs: state.tabs.map((t) =>
          t.id === tab.id
            ? { ...t, id: payload.path, path: payload.path }
            : t,
        ),
        activeTabId:
          state.activeTabId === tab.id ? payload.path : state.activeTabId,
      }));
    }
  }
  void refreshExplorerSoon();
};

let started = false;
let unlisten: (() => void) | null = null;

/**
 * Subscribe to `agent_file_changed`. Idempotent — calling more than
 * once returns the same teardown handle (the second subscription is
 * skipped). The returned function unsubscribes both listeners.
 */
export async function startAgentFileSync(): Promise<() => void> {
  if (started) {
    return () => {
      // No-op: the original caller still owns the lifetime.
    };
  }
  started = true;

  unlisten = await auroraListen<AgentFileChangedPayload>(
    "agent_file_changed",
    (event) => {
      const payload = event.payload;
      if (!payload || typeof payload.path !== "string") return;

      try {
        switch (payload.kind) {
          case "created":
          case "modified":
            applyFileWritten(payload);
            break;
          case "deleted":
            applyFileDeleted(payload);
            break;
          case "renamed":
            applyFileRenamed(payload);
            break;
        }
      } catch (err) {
        console.warn(
          "[agent-file-sync] handler threw for",
          payload.path,
          err,
        );
      }
    },
  );

  return () => {
    if (unlisten) {
      unlisten();
      unlisten = null;
    }
    started = false;
  };
}
