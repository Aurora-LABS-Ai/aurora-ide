/**
 * Route "open this file" into the Agent Window's right rail.
 *
 * The Agent Window has no Monaco editor. Sending a file open to the IDE's
 * editor meant the user's attention jumped to a different OS window in the
 * middle of a turn — and if the IDE was closed, nothing visible happened at
 * all. The rail already renders files read-only through `openFileTab`, which
 * keeps the file beside the conversation that referenced it.
 *
 * The `agent_editor_open` channel is kept alive for exactly this: the IDE
 * still handles it with Monaco, this window handles it with the rail.
 */

import { useEffect } from "react";

import { auroraListen } from "@/kernel/lib/ipc/runtime";
import { useAgentWorkspaceStore } from "@/apps/agent/store/workspace/useAgentWorkspaceStore";

interface EditorOpenPayload {
  path?: string;
}

export function useAgentEditorOpen(): void {
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;

    void auroraListen<EditorOpenPayload>("agent_editor_open", ({ payload }) => {
      const path = payload?.path;
      if (!path) return;
      useAgentWorkspaceStore.getState().openFileTab(path);
    })
      .then((dispose) => {
        if (disposed) dispose();
        else unlisten = dispose;
      })
      .catch(() => {
        // Nothing to open into is not worth interrupting a turn over.
      });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);
}
