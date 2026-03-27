import { useEffect, useRef } from "react";

import { chatSyncBroadcast } from "./useRustChatSync";
import { useChatStore } from "../store/useChatStore";
import { useContextStore } from "../store/useContextStore";
import { useTaskStore } from "../store/useTaskStore";
import { useThreadStore } from "../store/useThreadStore";
import { useWorkspaceStore } from "../store/useWorkspaceStore";

/**
 * Resets the active chat session when the workspace changes.
 *
 * Why this exists:
 * - Workspaces are folder-scoped
 * - Active chat threads are currently global
 * - Reusing the same active thread across different workspaces can make the
 *   agent carry context from the previous folder into the next one
 *
 * This hook treats a real workspace switch as a fresh session boundary:
 * - stop any in-flight generation
 * - clear the active thread selection
 * - reset context usage UI state
 * - clear pending tool approval/loading state
 * - clear task state
 * - broadcast the reset so detached chat windows stay in sync
 *
 * Important:
 * - It does NOT delete old threads
 * - It only resets the active session when switching from one workspace to another
 * - It does not run on initial workspace bootstrap from empty -> workspace
 */
export function useWorkspaceSessionReset() {
  const rootPath = useWorkspaceStore((state) => state.rootPath);
  const clearCurrentThread = useThreadStore((state) => state.clearCurrentThread);
  const stopGeneration = useChatStore((state) => state.stopGeneration);
  const setPendingApproval = useChatStore((state) => state.setPendingApproval);
  const setLoading = useChatStore((state) => state.setLoading);

  const previousRootPathRef = useRef<string>("");

  useEffect(() => {
    const previousRootPath = previousRootPathRef.current;
    const currentRootPath = rootPath || "";

    const hasPreviousWorkspace = previousRootPath.length > 0;
    const hasWorkspaceChanged = previousRootPath !== currentRootPath;

    if (hasPreviousWorkspace && hasWorkspaceChanged) {
      try {
        stopGeneration();
      } catch (error) {
        console.error("[WorkspaceSessionReset] Failed to stop generation:", error);
      }

      setLoading(false);
      setPendingApproval(null);
      useContextStore.getState().reset();
      clearCurrentThread();
      useTaskStore.getState().clearTasks();

      void chatSyncBroadcast.clear().catch((error) => {
        console.error("[WorkspaceSessionReset] Failed to broadcast session reset:", error);
      });

      console.log(
        "[WorkspaceSessionReset] Reset active chat session after workspace change:",
        {
          from: previousRootPath,
          to: currentRootPath,
        },
      );
    }

    previousRootPathRef.current = currentRootPath;
  }, [clearCurrentThread, rootPath, setLoading, setPendingApproval, stopGeneration]);
}
