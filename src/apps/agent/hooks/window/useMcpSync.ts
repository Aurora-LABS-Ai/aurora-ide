/**
 * Agent Window — keeps the MCP store in step with the Rust MCP manager.
 *
 *  - Subscribes to `mcp_servers_changed`, which Rust sends with the full
 *    server list after every start, stop, crash, reconnect or config edit.
 *  - Tells Rust which project is open, so that project's `.mcp.json`
 *    servers load (and the approved auto-start ones start).
 *
 * Mount once in the always-on shell.
 */

import { useEffect } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import { isAuroraRuntimeAvailable } from "@/kernel/lib/ipc/runtime";
import { useAgentChatStore } from "@/apps/agent/store/conversation/useAgentChatStore";
import {
  MCP_SERVERS_CHANGED_EVENT,
  type McpServerState,
  useMcpStore,
} from "@/apps/agent/store/tools/useMcpStore";

export function useMcpSync(): void {
  const projectRoot = useAgentChatStore((s) => s.projectRoot);

  useEffect(() => {
    if (!isAuroraRuntimeAvailable()) return;
    let cancelled = false;
    let unlisten: UnlistenFn | null = null;
    void listen<McpServerState[]>(MCP_SERVERS_CHANGED_EVENT, (event) => {
      if (!cancelled && Array.isArray(event.payload)) {
        useMcpStore.getState().applyServers(event.payload);
      }
    })
      .then((off) => {
        if (cancelled) off();
        else unlisten = off;
      })
      .catch((err) => console.warn("[MCP] could not subscribe to server changes:", err));
    void useMcpStore.getState().loadServers();
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, []);

  useEffect(() => {
    if (!isAuroraRuntimeAvailable()) return;
    void useMcpStore.getState().setWorkspace(projectRoot ?? null);
  }, [projectRoot]);
}
