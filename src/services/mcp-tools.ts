/**
 * MCP Tools Service
 * Integrates MCP server tools into the Aurora agent
 */
import {
  type McpServerState,
  type McpToolInfo,
  useMcpStore,
} from "../store/useMcpStore";
import type { FunctionParameters, ToolDefinition } from "../tools/types";

interface ParsedMcpToolName {
  autoApprove: boolean;
  originalToolName: string;
  serverId: string;
  serverName: string;
}

/**
 * Execute an MCP tool call
 */
export async function executeMcpTool(
  toolName: string,
  args: Record<string, unknown>,
): Promise<string> {
  const parsed = parseMcpToolName(toolName);

  if (!parsed) {
    throw new Error(`Invalid MCP tool name: ${toolName}`);
  }

  const { serverId, originalToolName } = parsed;
  const { callTool, getServer } = useMcpStore.getState();

  const server = getServer(serverId);
  if (!server) {
    throw new Error(`MCP server not found: ${serverId}`);
  }

  if (server.status !== "connected") {
    throw new Error(`MCP server ${server.config.name} is not connected`);
  }

  const result = await callTool({
    serverId,
    toolName: originalToolName,
    arguments: args,
  });

  if (!result) {
    throw new Error("Failed to call MCP tool: No result returned");
  }

  if (!result.success) {
    throw new Error(result.error || "MCP tool call failed");
  }

  // Format the result content
  if (result.content && result.content.length > 0) {
    return result.content
      .map((item) => {
        if (item.text) return item.text;
        if (item.data) return `[Binary data: ${item.mimeType || "unknown"}]`;
        return JSON.stringify(item);
      })
      .join("\n");
  }

  return "Tool executed successfully (no output)";
}

/**
 * Get all available MCP tools from connected servers
 */
export function getMcpToolDefinitions(): ToolDefinition[] {
  const { servers } = useMcpStore.getState();
  const tools: ToolDefinition[] = [];

  for (const server of servers) {
    // Only include tools from connected and enabled servers
    if (server.status === "connected" && server.config.enabled) {
      for (const tool of server.tools) {
        tools.push(
          mcpToolToDefinition(server.config.id, server.config.name, tool),
        );
      }
    }
  }

  return tools;
}

/**
 * Get a summary of available MCP servers and tools for the system prompt
 */
export function getMcpToolsSummary(): string {
  const { servers } = useMcpStore.getState();

  // Log for debugging
  console.log(
    "[MCP Tools] Getting summary, servers:",
    servers.length,
    servers.map((s) => ({
      name: s.config.name,
      status: s.status,
      enabled: s.config.enabled,
      tools: s.tools.length,
    })),
  );

  const connectedServers = servers.filter(
    (s) => s.status === "connected" && s.config.enabled,
  );

  if (connectedServers.length === 0) {
    // Also mention configured but not connected servers
    const configuredServers = servers.filter((s) => s.config.enabled);
    if (configuredServers.length > 0) {
      const lines = [
        "",
        "## MCP (Model Context Protocol) Servers",
        "",
        `You have ${configuredServers.length} MCP server(s) configured but not connected:`,
        "",
      ];
      for (const server of configuredServers) {
        lines.push(`- **${server.config.name}** (Status: ${server.status})`);
      }
      lines.push("");
      lines.push(
        "The user needs to connect these servers from Settings > MCP Servers before you can use their tools.",
      );
      lines.push("");
      return lines.join("\n");
    }
    return "";
  }

  const totalToolCount = connectedServers.reduce(
    (sum, server) => sum + server.tools.length,
    0,
  );

  const lines: string[] = [
    "",
    "## MCP (Model Context Protocol) Servers",
    "",
    `You have access to ${totalToolCount} MCP tool(s) across ${connectedServers.length} connected server(s).`,
    "When describing MCP tools to the user, use friendly names in the form `Server Name: Tool Name`.",
    "Do not expose raw internal MCP tool IDs unless the user explicitly asks for the exact callable name.",
    "Skills and rules are separate from tools and must not be counted as tools.",
    "",
  ];

  for (const server of connectedServers) {
    lines.push(`### ${server.config.name}`);
    if (server.serverInfo?.version) {
      lines.push(`Version: ${server.serverInfo.version}`);
    }
    lines.push(`Tool count: ${server.tools.length}`);
    lines.push("");

    if (server.tools.length > 0) {
      lines.push("Available tools:");
      for (const tool of server.tools) {
        lines.push(
          `- \`${server.config.name}: ${formatMcpToolLabel(tool.name)}\`${tool.description ? ` — ${tool.description}` : ""}`,
        );
      }
      lines.push("");
    }
  }

  lines.push(
    "Internally, MCP tools are callable by a prefixed name, but user-facing explanations should prefer friendly display names.",
  );
  lines.push("");

  return lines.join("\n");
}

/**
 * Get a display-friendly name for a tool
 * For MCP tools: returns "serverName: originalToolName"
 * For regular tools: returns the tool name as-is
 */
export function getToolDisplayName(toolName: string): string {
  if (!isMcpTool(toolName)) {
    return toolName;
  }

  // Refresh server-backed caches before serving cached display names
  getServersForParse();

  // Check cache first (populated when MCP tools are loaded)
  const cached = mcpToolDisplayNameCache.get(toolName);
  if (cached) {
    return cached;
  }

  // Try to get from store (has full server info)
  const parsed = parseMcpToolName(toolName);
  if (parsed) {
    const displayName = `${parsed.serverName}: ${formatMcpToolLabel(parsed.originalToolName)}`;
    mcpToolDisplayNameCache.set(toolName, displayName);
    return displayName;
  }

  // Fallback: Extract tool name from the end
  // Format: mcp_{serverId}_{toolName}
  // Example: mcp_mcp_1767509230024_pqf9mg17y_db_info
  // Server IDs can contain underscores, so we need to find where the tool name starts

  const withoutPrefix = toolName.slice(4); // Remove "mcp_"

  // Common MCP tool name patterns (these are typically the actual tool names)
  const knownToolPatterns = [
    "db_info",
    "list_tables",
    "describe_table",
    "read_query",
    "write_query",
    "create_record",
    "read_records",
    "update_record",
    "delete_record",
    "query",
    "execute",
    "search",
    "find",
    "get",
    "list",
    "create",
    "update",
    "delete",
    "read",
    "write",
    "call",
    "invoke",
  ];

  // Try to match known tool patterns at the end
  for (const pattern of knownToolPatterns) {
    if (withoutPrefix.endsWith(`_${pattern}`)) {
      const displayName = `MCP: ${pattern}`;
      mcpToolDisplayNameCache.set(toolName, displayName);
      return displayName;
    }
  }

  // Fallback: take last 1-2 underscore-separated parts as tool name
  const parts = withoutPrefix.split("_");
  if (parts.length >= 2) {
    const lastPart = parts[parts.length - 1];
    const secondLastPart = parts[parts.length - 2];

    // If second-to-last looks like a verb, include it
    const verbPrefixes = [
      "db",
      "list",
      "get",
      "create",
      "update",
      "delete",
      "read",
      "write",
      "query",
      "search",
      "find",
      "call",
      "describe",
    ];
    if (verbPrefixes.includes(secondLastPart.toLowerCase())) {
      const displayName = `MCP: ${secondLastPart}_${lastPart}`;
      mcpToolDisplayNameCache.set(toolName, displayName);
      return displayName;
    }

    const displayName = `MCP: ${lastPart}`;
    mcpToolDisplayNameCache.set(toolName, displayName);
    return displayName;
  }

  return toolName;
}

/**
 * Check if a tool name is an MCP tool
 */
export function isMcpTool(toolName: string): boolean {
  return toolName.startsWith("mcp_");
}

/**
 * Convert MCP tool info to Aurora tool definition format
 */
export function mcpToolToDefinition(
  serverId: string,
  serverName: string,
  tool: McpToolInfo,
): ToolDefinition {
  // Create a unique tool name prefixed with mcp_ and server id
  const toolName = `mcp_${serverId.replace(/[^a-zA-Z0-9]/g, "_")}_${tool.name}`;
  const friendlyToolName = formatMcpToolLabel(tool.name);

  // Cache the display name for later use (so we don't need store lookup)
  mcpToolDisplayNameCache.set(toolName, `${serverName}: ${friendlyToolName}`);

  // Convert MCP input schema to FunctionParameters format
  const inputSchema = tool.inputSchema as FunctionParameters | undefined;
  const parameters: FunctionParameters =
    inputSchema && inputSchema.type === "object"
      ? {
          type: "object",
          properties: inputSchema.properties || {},
          required: inputSchema.required || [],
        }
      : {
          type: "object",
          properties: {},
          required: [],
        };

  return {
    type: "function",
    function: {
      name: toolName,
      description: `[MCP: ${serverName}] ${tool.description || `Call ${friendlyToolName} from the ${serverName} MCP server`}`,
      parameters,
    },
  };
}

/**
 * Parse MCP tool name to extract server ID and original tool name
 */
export function parseMcpToolName(toolName: string): ParsedMcpToolName | null {
  if (!isMcpTool(toolName)) return null;

  const servers = getServersForParse();

  const cached = mcpToolParseCache.get(toolName);
  if (cached !== undefined) {
    return cached;
  }

  // Format: mcp_{serverId}_{toolName}
  // Need to find the server ID from the tool name.
  for (const server of servers) {
    const serverPrefix = `mcp_${server.config.id.replace(/[^a-zA-Z0-9]/g, "_")}_`;
    if (toolName.startsWith(serverPrefix)) {
      const parsed: ParsedMcpToolName = {
        serverId: server.config.id,
        serverName: server.config.name,
        originalToolName: toolName.slice(serverPrefix.length),
        autoApprove: server.config.autoApprove,
      };
      mcpToolParseCache.set(toolName, parsed);
      return parsed;
    }
  }

  mcpToolParseCache.set(toolName, null);
  return null;
}

/**
 * Populate the display name cache for all tools from a server
 * Called when servers are loaded to ensure names are available for saved threads
 */
export function populateMcpToolDisplayNameCache(
  serverId: string,
  serverName: string,
  tools: Array<{ name: string }>,
): void {
  for (const tool of tools) {
    const toolName = `mcp_${serverId.replace(/[^a-zA-Z0-9]/g, "_")}_${tool.name}`;
    mcpToolDisplayNameCache.set(
      toolName,
      `${serverName}: ${formatMcpToolLabel(tool.name)}`,
    );
  }
}

/**
 * Check if an MCP tool should be auto-approved (skip user confirmation)
 */
export function shouldAutoApproveMcpTool(toolName: string): boolean {
  const parsed = parseMcpToolName(toolName);
  return parsed?.autoApprove ?? false;
}

// Cache for MCP tool display names (tool name -> display name)
const mcpToolDisplayNameCache = new Map<string, string>();
// Cache parsed MCP tool names to avoid repeated server scans.
const mcpToolParseCache = new Map<string, ParsedMcpToolName | null>();
let mcpToolParseServersRef: McpServerState[] | null = null;

const MCP_ACRONYM_LABELS: Record<string, string> = {
  api: "API",
  db: "DB",
  id: "ID",
  sql: "SQL",
  ui: "UI",
  url: "URL",
};

function formatMcpToolLabel(toolName: string): string {
  return toolName
    .split("_")
    .filter(Boolean)
    .map((part) => {
      const lower = part.toLowerCase();
      return MCP_ACRONYM_LABELS[lower]
        ? MCP_ACRONYM_LABELS[lower]
        : lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join(" ");
}

const getServersForParse = (): McpServerState[] => {
  const servers = useMcpStore.getState().servers;
  if (servers !== mcpToolParseServersRef) {
    mcpToolParseServersRef = servers;
    mcpToolParseCache.clear();
    mcpToolDisplayNameCache.clear();
  }
  return servers;
};
