import { useEffect, useRef } from "react";

import { auroraInvoke as invoke } from "@/kernel/lib/ipc/runtime";
import { isTauri, readFileContent } from "@/kernel/lib/ipc/tauri";
import { databaseService } from "@/kernel/services/database";
import { useEditorStore } from "@/kernel/store/useEditorStore";
import { useWorkspaceStore } from "@/kernel/store/useWorkspaceStore";
import { getLanguageFromExtension } from "@/kernel/lib/fs/file-utils";

/**
 * CLI open request returned by the `cli_take_pending_open_request`
 * Tauri command. Mirrors `cli::CliOpenRequest` on the Rust side.
 */
interface CliOpenRequest {
  workspace_path: string | null;
  file_path: string | null;
  goto_line: number | null;
  new_window: boolean;
  diff_files: [string, string] | null;
}

/**
 * Initializes the workspace store on app mount.
 *
 * Order of precedence (highest wins):
 *
 *   1. **CLI-supplied path** — if Aurora was launched via `aurora .`,
 *      `aurora /path` or the Windows Explorer "Open with Aurora"
 *      context menu, the Rust side stashed the request in app state.
 *      We pull it via IPC synchronously here so it always wins over
 *      restore-last-workspace. Pull-based (not event-based) so the
 *      bootstrap is immune to the cold-start race where the JS bundle
 *      finishes loading after a one-shot `cli-open` event was already
 *      emitted.
 *
 *   2. **Last opened workspace** — if no CLI request, restore the
 *      workspace the user had open when they last closed Aurora.
 *
 *   3. **Empty** — first-time launch with nothing to restore. The user
 *      picks a folder from the file menu.
 */
export const useWorkspaceBootstrap = (): void => {
  const { rootPath, setRootPath } = useWorkspaceStore();
  const openFile = useEditorStore((state) => state.openFile);
  const hasInitialized = useRef(false);

  useEffect(() => {
    if (!isTauri()) return;
    // The agent window is a separate WebviewWindow SCOPED to its launch `?ws=`
    // path (mirrored into `useWorkspaceStore.rootPath` by `bindRuntimeWorkspace`).
    // It must NOT run the IDE's "restore last-opened workspace" bootstrap — that
    // async DB restore lands after the scoped bind and silently repoints
    // `rootPath` to the IDE's last folder, so tools/context read the wrong
    // project while the UI (driven by `projectRoot`) still shows the scoped one.
    if (
      typeof window !== "undefined" &&
      window.location.pathname === "/agent-window"
    )
      return;
    if (hasInitialized.current) return;
    if (rootPath) return;

    hasInitialized.current = true;

    const bootstrap = async () => {
      try {
        // (1) CLI / context-menu path wins. Take-once: the Rust slot
        // is cleared by this call so React Strict Mode's double-invoke
        // can't apply the request twice.
        let cliRequest: CliOpenRequest | null = null;
        try {
          cliRequest = await invoke<CliOpenRequest | null>(
            "cli_take_pending_open_request",
          );
        } catch (err) {
          console.warn(
            "[WorkspaceBootstrap] cli_take_pending_open_request failed:",
            err,
          );
        }

        if (cliRequest?.workspace_path) {
          console.log(
            "[WorkspaceBootstrap] Opening CLI-supplied workspace:",
            cliRequest.workspace_path,
          );
          setRootPath(cliRequest.workspace_path);

          if (cliRequest.file_path) {
            try {
              const content = await readFileContent(cliRequest.file_path);
              const filename =
                cliRequest.file_path.split(/[/\\]/).pop() ||
                cliRequest.file_path;
              openFile(
                cliRequest.file_path,
                filename,
                content,
                getLanguageFromExtension(filename),
              );
            } catch (err) {
              console.error(
                "[WorkspaceBootstrap] Failed to open CLI file:",
                err,
              );
            }
          }
          return;
        }

        // (2) Fallback: restore last opened workspace from the DB.
        const savedState = await databaseService.getWorkspaceState();
        if (savedState?.workspace_path) {
          console.log(
            "[WorkspaceBootstrap] Restoring last workspace:",
            savedState.workspace_path,
          );
          setRootPath(savedState.workspace_path);
        } else {
          console.log("[WorkspaceBootstrap] No workspace to restore");
        }
      } catch (error) {
        console.error("[WorkspaceBootstrap] Bootstrap failed:", error);
      }
    };

    void bootstrap();
  }, [rootPath, setRootPath, openFile]);
};
