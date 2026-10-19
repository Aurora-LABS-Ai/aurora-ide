/**
 * MCP Store — a view of the Rust MCP manager.
 *
 * Rust owns every server's life: it reads `~/.aurora/mcp.json` and the open
 * project's `.mcp.json`, starts auto-start servers once per app, notices
 * crashes, and pushes the full list as `mcp_servers_changed` after every
 * change. This store only renders that list and forwards user actions.
 *
 * It used to run its own auto-start, in every window. Two windows booting
 * together each connected the same servers, and a connect always killed the
 * running process first, so they killed and respawned each other's servers.
 */
import { create } from "zustand";

import { auroraInvoke as invoke } from "@/kernel/lib/ipc/runtime";
import { populateMcpToolDisplayNameCache } from "@/apps/agent/services/tools/mcp-tools";

// ============================================
// STORE STATE
// ============================================
interface McpStoreState {
  addServer: (config: Omit<McpServerConfig, 'id'>) => Promise<McpServerState | null>;
  /** Replace the list with Rust's (from the `mcp_servers_changed` event). */
  applyServers: (servers: McpServerState[]) => void;
  callTool: (request: McpToolCallRequest) => Promise<McpToolCallResult | null>;
  /** Does this command exist, and which file would run. */
  checkCommand: (command: string) => Promise<McpCommandCheck | null>;

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
  /** Stop and start again, even if it is running. */
  restartServer: (id: string) => Promise<McpServerState | null>;

  // Server states
  servers: McpServerState[];
  /** The agent window's project; Rust loads its `.mcp.json`. */
  setWorkspace: (root: string | null) => Promise<void>;
  toggleServer: (id: string, enabled: boolean) => Promise<McpServerState | null>;
  updateServer: (config: McpServerConfig) => Promise<McpServerState | null>;
}

export interface McpResourceInfo {
  description?: string;
  mimeType?: string;
  name: string;
  uri: string;
}

/**
 * `global` lives in `~/.aurora/mcp.json`; `project` in the workspace's
 * `.mcp.json` (Claude Code's file). A project server is off until turned on
 * here; that switch is kept per project outside the repo.
 */
export type McpScope = 'global' | 'project';

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
  scope?: McpScope;
  /** The file this server was read from. */
  source?: string | null;
  /** Longest one tool call may run, in seconds (Rust clamps to 5–110). */
  toolTimeoutSecs?: number | null;
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
  /** The server's last lines of output, newest last. */
  recentOutput?: string[];
  /** What the server says about using its tools (from `initialize`). */
  instructions?: string | null;
}

export interface McpCommandCheck {
  found: boolean;
  problem?: string | null;
  resolved?: string | null;
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
// 'sse' is the legacy HTTP+SSE transport (MCP 2024-11-05); 'http' is
// Streamable HTTP (2025-03-26+), which config files spell as `httpUrl`.
// They are not interchangeable — a Streamable HTTP server answers the SSE
// handshake with 405 Method Not Allowed.
export type McpTransportType = 'stdio' | 'sse' | 'http';

// ============================================
// PASTED-CONFIG PARSING
// ============================================
//
// Both settings surfaces (agent window + main window) accept a pasted
// Claude/Cursor `mcpServers` block, so the mapping from that shape to our
// config lives here rather than being reimplemented per UI. Mirrors
// `McpServerEntry::resolve_transport` in `src-tauri/src/mcp/config.rs`.

/**
 * Decide which transport a pasted server entry describes.
 *
 * An explicit `type`/`transport` wins. Otherwise infer — and `httpUrl` must
 * map to `http`, not `sse`: a Streamable HTTP server rejects the SSE
 * handshake's opening GET with 405, so guessing wrong is a hard failure.
 */
export function resolveTransport(raw: Record<string, unknown>): McpTransportType {
  const declared = typeof raw.type === 'string' ? raw.type : raw.transport;
  if (typeof declared === 'string') {
    const normalized = declared.toLowerCase().replace(/[-_]/g, '');
    if (normalized === 'stdio') return 'stdio';
    if (normalized === 'sse') return 'sse';
    if (normalized === 'http' || normalized === 'streamablehttp') return 'http';
  }
  if (typeof raw.httpUrl === 'string') return 'http';
  if (typeof raw.url === 'string') return 'sse';
  return 'stdio';
}

/** The endpoint of a pasted entry, under either key it may use. */
export function resolveServerUrl(raw: Record<string, unknown>): string | undefined {
  if (typeof raw.url === 'string') return raw.url;
  if (typeof raw.httpUrl === 'string') return raw.httpUrl;
  return undefined;
}

/** The Rust event carrying the full server list after any change. */
export const MCP_SERVERS_CHANGED_EVENT = 'mcp_servers_changed';

function cacheToolNames(servers: McpServerState[]): void {
  for (const server of servers) {
    if (server.tools.length > 0) {
      populateMcpToolDisplayNameCache(server.config.id, server.config.name, server.tools);
    }
  }
}

// ============================================
// STORE IMPLEMENTATION
// ============================================
export const useMcpStore = create<McpStoreState>((set, get) => {
  /** Replace one server in the list with Rust's answer. */
  const putServer = (state: McpServerState) => {
    cacheToolNames([state]);
    set((s) => {
      const exists = s.servers.some((srv) => srv.config.id === state.config.id);
      return {
        servers: exists
          ? s.servers.map((srv) => (srv.config.id === state.config.id ? state : srv))
          : [...s.servers, state],
      };
    });
  };

  /**
   * Run a Rust action. Errors land on `error` (and, for the server it was
   * about, Rust has already put them on that server's state via the event).
   */
  const run = async <T,>(label: string, action: () => Promise<T>): Promise<T | null> => {
    try {
      set({ error: null });
      return await action();
    } catch (error) {
      console.error(`[MCP] ${label} failed:`, error);
      set({ error: String(error) });
      return null;
    }
  };

  return {
    servers: [],
    isLoading: false,
    configPath: null,
    error: null,
    initialized: false,

    applyServers: (servers) => {
      cacheToolNames(servers);
      set({ servers, initialized: true });
    },

    // Read the list Rust already holds; `force` re-reads the config files.
    loadServers: async (force = false) => {
      const { initialized, isLoading } = get();
      if ((initialized && !force) || isLoading) return;
      set({ isLoading: true, error: null });
      try {
        const servers = await invoke<McpServerState[]>(
          force ? 'mcp_load_servers' : 'mcp_get_servers',
        );
        get().applyServers(servers);
        set({ isLoading: false });
      } catch (error) {
        console.error('[MCP] Failed to load servers:', error);
        set({ error: String(error), isLoading: false, initialized: true });
      }
    },

    // Re-read the config files (picks up hand edits).
    refreshServers: async () => {
      set({ isLoading: true, error: null });
      try {
        get().applyServers(await invoke<McpServerState[]>('mcp_load_servers'));
        set({ isLoading: false });
      } catch (error) {
        console.error('[MCP] Failed to refresh servers:', error);
        set({ error: String(error), isLoading: false });
      }
    },

    setWorkspace: async (root) => {
      const servers = await run('set workspace', () =>
        invoke<McpServerState[]>('mcp_set_workspace', { root }),
      );
      if (servers) get().applyServers(servers);
    },

    getConfigPath: async () => {
      const path = await run('config path', () => invoke<string>('mcp_get_config_path'));
      if (path) set({ configPath: path });
      return path;
    },

    checkCommand: (command) =>
      run('check command', () => invoke<McpCommandCheck>('mcp_check_command', { command })),

    addServer: async (config) => {
      // Rust keys servers by name; the id it receives is replaced.
      const state = await run('add server', () =>
        invoke<McpServerState>('mcp_add_server', { config: { ...config, id: config.name } }),
      );
      if (state) putServer(state);
      return state;
    },

    updateServer: async (config) => {
      const state = await run('update server', () =>
        invoke<McpServerState>('mcp_update_server', { config }),
      );
      // A rename moves the server to a new id; the event carries the list.
      if (state) {
        set((s) => ({ servers: s.servers.filter((srv) => srv.config.id !== config.id) }));
        putServer(state);
      }
      return state;
    },

    removeServer: async (id) => {
      const done = await run('remove server', () => invoke('mcp_remove_server', { id }));
      if (done === null) return false;
      set((s) => ({ servers: s.servers.filter((srv) => srv.config.id !== id) }));
      return true;
    },

    toggleServer: async (id, enabled) => {
      const state = await run('toggle server', () =>
        invoke<McpServerState>('mcp_toggle_server', { id, enabled }),
      );
      if (state) putServer(state);
      return state;
    },

    connectServer: async (id) => {
      const state = await run('connect server', () =>
        invoke<McpServerState>('mcp_connect_server', { id }),
      );
      if (state) putServer(state);
      return state;
    },

    restartServer: async (id) => {
      const state = await run('restart server', () =>
        invoke<McpServerState>('mcp_restart_server', { id }),
      );
      if (state) putServer(state);
      return state;
    },

    disconnectServer: async (id) => {
      const done = await run('disconnect server', () => invoke('mcp_disconnect_server', { id }));
      return done !== null;
    },

    callTool: async (request) => {
      try {
        return await invoke<McpToolCallResult>('mcp_call_tool', { request });
      } catch (error) {
        console.error('[MCP] Failed to call tool:', error);
        return { success: false, error: String(error) };
      }
    },

    getAllTools: async () => {
      const tools = await run('list tools', () =>
        invoke<Array<[string, McpToolInfo]>>('mcp_get_all_tools'),
      );
      return (tools ?? []).map(([serverId, tool]) => ({ serverId, tool }));
    },

    getServer: (id) => get().servers.find((srv) => srv.config.id === id),
  };
});
