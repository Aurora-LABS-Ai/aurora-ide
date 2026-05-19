/**
 * MCP Store
 * Manages MCP (Model Context Protocol) server state
 */
import { create } from "zustand";

import { auroraInvoke as invoke } from "../lib/runtime";
import { populateMcpToolDisplayNameCache } from "../services/mcp-tools";

// ============================================
// STORE STATE
// ============================================
interface McpStoreState {
  addServer: (config: Omit<McpServerConfig, 'id'>) => Promise<McpServerState | null>;
  callTool: (request: McpToolCallRequest) => Promise<McpToolCallResult | null>;

  // Config file path
  configPath: string | null;
  connectServer: (id: string) => Promise<McpServerState | null>;
  disconnectServer: (id: string) => Promise<boolean>;

  // Error message
  error: string | null;
  getAllTools: () => Promise<Array<{ serverId: string; tool: McpToolInfo }>>;
  getConfigPath: () => Promise<string | null>;
  getServer: (id: string) => McpServerState | undefined;

  // Whether servers have been loaded at least once
  initialized: boolean;

  // Loading state
  isLoading: boolean;

  // Actions
  loadServers: (force?: boolean) => Promise<void>;
  refreshServers: () => Promise<void>;
  removeServer: (id: string) => Promise<boolean>;

  // Server states
  servers: McpServerState[];
  toggleServer: (id: string, enabled: boolean) => Promise<McpServerState | null>;
  updateServer: (config: McpServerConfig) => Promise<McpServerState | null>;
}

export interface McpResourceInfo {
  description?: string;
  mimeType?: string;
  name: string;
  uri: string;
}

export interface McpServerConfig {
  args: string[];
  autoApprove: boolean;
  autoStart: boolean;
  command?: string;
  enabled: boolean;
  env: Record<string, string>;
  id: string;
  name: string;
  transport: McpTransportType;
  url?: string;
  headers: Record<string, string>;
}

export interface McpServerInfo {
  name: string;
  version?: string;
}

export interface McpServerState {
  config: McpServerConfig;
  error?: string;
  resources: McpResourceInfo[];
  serverInfo?: McpServerInfo;
  status: McpServerStatus;
  tools: McpToolInfo[];
}

export interface McpToolCallRequest {
  arguments?: Record<string, unknown>;
  serverId: string;
  toolName: string;
}

export interface McpToolCallResult {
  content?: McpToolContent[];
  error?: string;
  isError?: boolean;
  success: boolean;
}

export interface McpToolContent {
  data?: string;
  mimeType?: string;
  text?: string;
  type: string;
}

export interface McpToolInfo {
  description?: string;
  inputSchema?: Record<string, unknown>;
  name: string;
}

export type McpServerStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

// ============================================
// TYPES
// ============================================
export type McpTransportType = 'stdio' | 'sse';

// ============================================
// AUTO-START HELPER
// ============================================
//
// Called after every mutation that could turn a server into an
// "Auto + Enabled + Disconnected" tuple. We can't put this logic
// inside `connectServer` itself because connect is also the user's
// manual play-button path, and we don't want to gate that behind a
// config check. Centralising it here keeps the rule "saving an
// `autoStart` server connects it" in one place across addServer,
// updateServer, and toggleServer.
//
// The function:
//   * is a no-op unless `enabled && autoStart && status === 'disconnected'`;
//   * catches connection errors and lets `connectServer` write them
//     into the server's `status === 'error'` so the UI surfaces the
//     reason instead of pretending the connect never happened;
//   * returns the latest state from the store so the caller can
//     surface the up-to-date status without re-fetching.
async function attemptAutoStart(
  get: () => McpStoreState,
  saved: McpServerState
): Promise<McpServerState> {
  const { config, status } = saved;
  if (!config.enabled || !config.autoStart || status !== 'disconnected') {
    return saved;
  }
  try {
    const connected = await get().connectServer(config.id);
    return connected ?? saved;
  } catch (err) {
    // connectServer already writes the error into the store; we only
    // log here so the failure shows up in dev tools alongside the
    // server name (without it, the only visible signal is a red
    // status pill).
    console.error(`[MCP] auto-start after save failed for ${config.name}:`, err);
    return get().getServer(config.id) ?? saved;
  }
}

// ============================================
// STORE IMPLEMENTATION
// ============================================
export const useMcpStore = create<McpStoreState>((set, get) => ({
  servers: [],
  isLoading: false,
  configPath: null,
  error: null,
  initialized: false,

  // Load servers - only loads if not initialized or force=true
  // Also auto-connects servers that have autoStart enabled
  loadServers: async (force = false) => {
    const { initialized, isLoading, connectServer } = get();
    
    // Skip if already initialized and not forced, or if currently loading
    if ((initialized && !force) || isLoading) {
      return;
    }

    set({ isLoading: true, error: null });
    try {
      // Get current server states (preserves connection status)
      let servers = await invoke<McpServerState[]>('mcp_get_servers');
      
      // If no servers loaded yet, load from config
      if (servers.length === 0 && !initialized) {
        servers = await invoke<McpServerState[]>('mcp_load_servers');
      }
      
      set({ servers, isLoading: false, initialized: true });
      
      // Populate display name cache for all server tools (for saved thread display)
      for (const server of servers) {
        if (server.tools.length > 0) {
          populateMcpToolDisplayNameCache(server.config.id, server.config.name, server.tools);
        }
      }
      
      // Auto-connect servers that have autoStart enabled and are not already connected
      const serversToAutoStart = servers.filter(
        s => s.config.enabled && s.config.autoStart && s.status === 'disconnected'
      );
      
      if (serversToAutoStart.length > 0) {
        console.log(`[MCP] Auto-starting ${serversToAutoStart.length} server(s)...`);
        // Connect servers in parallel
        await Promise.all(
          serversToAutoStart.map(async (server) => {
            try {
              console.log(`[MCP] Auto-connecting: ${server.config.name}`);
              await connectServer(server.config.id);
            } catch (err) {
              console.error(`[MCP] Failed to auto-connect ${server.config.name}:`, err);
            }
          })
        );
      }
    } catch (error) {
      console.error('[MCP] Failed to load servers:', error);
      set({ error: String(error), isLoading: false, initialized: true });
    }
  },

  // Force refresh from backend (preserves connection state)
  refreshServers: async () => {
    set({ isLoading: true, error: null });
    try {
      const servers = await invoke<McpServerState[]>('mcp_get_servers');
      set({ servers, isLoading: false });
    } catch (error) {
      console.error('[MCP] Failed to refresh servers:', error);
      set({ error: String(error), isLoading: false });
    }
  },

  getConfigPath: async () => {
    try {
      const path = await invoke<string>('mcp_get_config_path');
      set({ configPath: path });
      return path;
    } catch (error) {
      console.error('[MCP] Failed to get config path:', error);
      return null;
    }
  },

  addServer: async (config) => {
    try {
      // Generate unique ID
      const id = `mcp-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      const fullConfig: McpServerConfig = { ...config, id };

      const state = await invoke<McpServerState>('mcp_add_server', { config: fullConfig });
      set((s) => ({ servers: [...s.servers, state] }));
      // If the new server is flagged `autoStart` (and enabled), honour
      // that immediately — otherwise the toggle is decorative until the
      // user restarts the IDE, which is the exact bug we ran into where
      // freshly-added servers sat in `disconnected` despite "Auto" being
      // on. `attemptAutoStart` swallows connection failures into the
      // server's `error` state so a bad command can't reject this
      // promise.
      return attemptAutoStart(get, state);
    } catch (error) {
      console.error('[MCP] Failed to add server:', error);
      set({ error: String(error) });
      return null;
    }
  },

  updateServer: async (config) => {
    try {
      const state = await invoke<McpServerState>('mcp_update_server', { config });
      set((s) => ({
        servers: s.servers.map((srv) => (srv.config.id === config.id ? state : srv)),
      }));
      // Same as addServer: if the user just turned on Auto or edited a
      // server that was already flagged Auto, kick the connect now. The
      // Rust `update_server` resets status to `disconnected` whenever
      // transport-affecting fields change, so checking the returned
      // status is the cheapest way to avoid reconnecting a connection
      // that survived the edit.
      return attemptAutoStart(get, state);
    } catch (error) {
      console.error('[MCP] Failed to update server:', error);
      set({ error: String(error) });
      return null;
    }
  },

  removeServer: async (id) => {
    try {
      await invoke('mcp_remove_server', { id });
      set((s) => ({ servers: s.servers.filter((srv) => srv.config.id !== id) }));
      return true;
    } catch (error) {
      console.error('[MCP] Failed to remove server:', error);
      set({ error: String(error) });
      return false;
    }
  },

  toggleServer: async (id, enabled) => {
    try {
      const state = await invoke<McpServerState>('mcp_toggle_server', { id, enabled });
      set((s) => ({
        servers: s.servers.map((srv) => (srv.config.id === id ? state : srv)),
      }));
      // Re-enabling a server that's flagged Auto should auto-connect it
      // — the user expects "Enabled + Auto" to behave like "Enabled +
      // Auto on every cold boot". Disabling is a pure tear-down so the
      // Rust side already disconnected.
      if (enabled) {
        return attemptAutoStart(get, state);
      }
      return state;
    } catch (error) {
      console.error('[MCP] Failed to toggle server:', error);
      set({ error: String(error) });
      return null;
    }
  },

  connectServer: async (id) => {
    // Update status to connecting
    set((s) => ({
      servers: s.servers.map((srv) =>
        srv.config.id === id ? { ...srv, status: 'connecting' as McpServerStatus } : srv
      ),
    }));

    try {
      const state = await invoke<McpServerState>('mcp_connect_server', { id });
      
      // Populate display name cache for tools from this server
      if (state.tools.length > 0) {
        populateMcpToolDisplayNameCache(state.config.id, state.config.name, state.tools);
      }
      
      set((s) => ({
        servers: s.servers.map((srv) => (srv.config.id === id ? state : srv)),
      }));
      return state;
    } catch (error) {
      console.error('[MCP] Failed to connect server:', error);
      set((s) => ({
        servers: s.servers.map((srv) =>
          srv.config.id === id
            ? { ...srv, status: 'error' as McpServerStatus, error: String(error) }
            : srv
        ),
        error: String(error),
      }));
      return null;
    }
  },

  disconnectServer: async (id) => {
    try {
      await invoke('mcp_disconnect_server', { id });
      set((s) => ({
        servers: s.servers.map((srv) =>
          srv.config.id === id
            ? { ...srv, status: 'disconnected' as McpServerStatus, tools: [], resources: [] }
            : srv
        ),
      }));
      return true;
    } catch (error) {
      console.error('[MCP] Failed to disconnect server:', error);
      set({ error: String(error) });
      return false;
    }
  },

  callTool: async (request) => {
    try {
      const result = await invoke<McpToolCallResult>('mcp_call_tool', { request });
      return result;
    } catch (error) {
      console.error('[MCP] Failed to call tool:', error);
      return {
        success: false,
        error: String(error),
      };
    }
  },

  getAllTools: async () => {
    try {
      const tools = await invoke<Array<[string, McpToolInfo]>>('mcp_get_all_tools');
      return tools.map(([serverId, tool]) => ({ serverId, tool }));
    } catch (error) {
      console.error('[MCP] Failed to get all tools:', error);
      return [];
    }
  },

  getServer: (id) => {
    return get().servers.find((srv) => srv.config.id === id);
  },
}));
