/**
 * CLI Open Hook
 *
 * Live `cli-open` event listener. The cold-start path is handled by
 * `useWorkspaceBootstrap`, which pulls the pending request synchronously
 * via the `cli_take_pending_open_request` IPC command (race-free).
 *
 * This hook stays in place for live re-opens — e.g. a future
 * single-instance handoff where Aurora is already running and the user
 * invokes `aurora .` or clicks "Open Aurora" from the Explorer context
 * menu again. In that case Rust still emits `cli-open` and this
 * listener applies the request to the running window.
 */

import { useEffect } from 'react';
import { listen } from '@tauri-apps/api/event';
import { useWorkspaceStore } from '../store/useWorkspaceStore';
import { useEditorStore } from '../store/useEditorStore';
import { isTauri, readFileContent } from '../lib/tauri';
import { getLanguageFromExtension } from '../lib/file-utils';

export interface CliOpenRequest {
  /** Workspace root folder to open */
  workspace_path: string | null;
  /** Specific file to open (and focus) */
  file_path: string | null;
  /** Line number to go to (1-indexed) */
  goto_line: number | null;
  /** Whether this should open in a new window */
  new_window: boolean;
  /** Files for diff view */
  diff_files: [string, string] | null;
}

export function useCliOpen() {
  useEffect(() => {
    if (!isTauri()) return;
    // The agent window is scoped to its launch `?ws=` workspace; a live
    // `cli-open` event (a global Tauri event) must not repoint its workspace
    // out from under the pinned project. Only the IDE window handles CLI opens.
    if (
      typeof window !== "undefined" &&
      window.location.pathname === "/agent-window"
    )
      return;

    let unlisten: (() => void) | undefined;

    const setupListener = async () => {
      try {
        unlisten = await listen<CliOpenRequest>('cli-open', async (event) => {
          const request = event.payload;
          console.log('[useCliOpen] Received live CLI open request:', request);

          // Read fresh state from the store rather than closing over a
          // stale `rootPath` (the previous version captured `rootPath`
          // from render, which could be empty during the cold-start
          // race window and cause a no-op or duplicate switch).
          const currentRoot = useWorkspaceStore.getState().rootPath;

          if (request.workspace_path && request.workspace_path !== currentRoot) {
            console.log('[useCliOpen] Switching workspace:', request.workspace_path);
            useWorkspaceStore.getState().setRootPath(request.workspace_path);
          }

          if (request.file_path) {
            try {
              const content = await readFileContent(request.file_path);
              const filename =
                request.file_path.split(/[/\\]/).pop() || request.file_path;
              useEditorStore.getState().openFile(
                request.file_path,
                filename,
                content,
                getLanguageFromExtension(filename),
              );
              if (request.goto_line) {
                // Future: integrate with Monaco to scroll to line.
                console.log('[useCliOpen] goto_line requested:', request.goto_line);
              }
            } catch (error) {
              console.error('[useCliOpen] Failed to open file:', error);
            }
          }

          if (request.diff_files) {
            console.log('[useCliOpen] Diff view requested:', request.diff_files);
            // Future: implement diff view.
          }
        });
      } catch (error) {
        console.error('[useCliOpen] Failed to setup listener:', error);
      }
    };

    void setupListener();

    return () => {
      unlisten?.();
    };
  }, []);
}

