/**
 * MCP Store
 * Manages MCP (Model Context Protocol) server state
 */
import { invoke } from "@tauri-apps/api/core";

import { create } from "zustand";

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
      return state;
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
      return state;
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
