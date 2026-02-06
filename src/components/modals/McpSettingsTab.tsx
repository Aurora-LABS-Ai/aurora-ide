/**
 * MCP Settings Tab
 * Configure MCP (Model Context Protocol) servers
 */

import React, { useState, useEffect } from 'react';
import {
  useMcpStore,
  type McpServerConfig,
  type McpServerState,
  type McpTransportType,
} from '../../store/useMcpStore';
import {
  Plus,
  Trash2,
  ChevronDown,
  Play,
  Square,
  RefreshCw,
  Server,
  Terminal,
  Globe,
  AlertCircle,
  CheckCircle,
  Loader2,
  Copy,
  Eye,
  EyeOff,
  Check,
  Pencil,
  Save,
  ShoppingBag,
  Download,
} from 'lucide-react';

import clsx from 'clsx';
import { TogglePill } from '../ui/TogglePill';
import { DeleteConfirmDialog } from '../chat/DeleteConfirmDialog';

// ============================================
// MARKETPLACE DATA
// ============================================

interface MarketplaceItem {
  id: string;
  name: string;
  description: string;
  author: string;
  transport: 'stdio' | 'sse';
  command?: string;
  args?: string[];
  url?: string;
  envExample?: string;
}

const MARKETPLACE_ITEMS: MarketplaceItem[] = [
  {
    id: 'git',
    name: 'Git',
    description: 'Git repository operations (read, commit, diff)',
    author: 'Model Context Protocol',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-git', '.'],
  },
  {
    id: 'postgres',
    name: 'PostgreSQL',
    description: 'Read-only database access for querying tables and schemas',
    author: 'Model Context Protocol',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-postgres', 'postgresql://user:password@localhost/db'],
  },
  {
    id: 'filesystem',
    name: 'Filesystem',
    description: 'Secure file access outside the workspace',
    author: 'Model Context Protocol',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', '/path/to/allowed/dir'],
  },
  {
    id: 'github',
    name: 'GitHub',
    description: 'Search, PRs, Issues, and file operations',
    author: 'Model Context Protocol',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
    envExample: 'GITHUB_PERSONAL_ACCESS_TOKEN=your_token',
  },
  {
    id: 'sqlite',
    name: 'SQLite',
    description: 'SQLite database access and query execution',
    author: 'Model Context Protocol',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-sqlite', 'my-db.sqlite'],
  },
  {
    id: 'google-drive',
    name: 'Google Drive',
    description: 'Access files and folders in Google Drive',
    author: 'Model Context Protocol',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-google-drive'],
  },
  {
    id: 'slack',
    name: 'Slack',
    description: 'Read and post messages to Slack channels',
    author: 'Model Context Protocol',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-slack'],
    envExample: 'SLACK_BOT_TOKEN=xoxb-...\nSLACK_TEAM_ID=T...',
  },
  {
    id: 'brave-search',
    name: 'Brave Search',
    description: 'Web search using Brave Search API',
    author: 'Model Context Protocol',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-brave-search'],
    envExample: 'BRAVE_API_KEY=your_key',
  },
];

// ============================================
// ADD SERVER FORM
// ============================================

type AddMode = 'form' | 'json';

interface AddServerFormProps {
  initialConfig?: Partial<McpServerConfig>;
  onSave: (config: Omit<McpServerConfig, 'id'>) => void;
  onCancel: () => void;
}

const AddServerForm: React.FC<AddServerFormProps> = ({ initialConfig, onSave, onCancel }) => {
  const [mode, setMode] = useState<AddMode>('form');
  
  // Form mode state
  const [name, setName] = useState(initialConfig?.name || '');
  const [transport, setTransport] = useState<McpTransportType>(initialConfig?.transport || 'stdio');
  const [command, setCommand] = useState(initialConfig?.command || '');
  const [args, setArgs] = useState(initialConfig?.args?.join(' ') || '');
  const [url, setUrl] = useState(initialConfig?.url || '');
  const [envVars, setEnvVars] = useState(
    initialConfig?.env 
      ? Object.entries(initialConfig.env).map(([k, v]) => `${k}=${v}`).join('\n') 
      : ''
  );
  const [headerVars, setHeaderVars] = useState(
    initialConfig?.headers 
      ? Object.entries(initialConfig.headers).map(([k, v]) => `${k}=${v}`).join('\n') 
      : ''
  );
  const [autoStart, setAutoStart] = useState(initialConfig?.autoStart || false);
  const [autoApprove, setAutoApprove] = useState(initialConfig?.autoApprove !== false);

  // If initialConfig provided, switch to form mode by default
  useEffect(() => {
    if (initialConfig) {
      setMode('form');
      if (initialConfig.name) setName(initialConfig.name);
      if (initialConfig.transport) setTransport(initialConfig.transport);
      if (initialConfig.command) setCommand(initialConfig.command);
      if (initialConfig.args) setArgs(initialConfig.args.join(' '));
      if (initialConfig.url) setUrl(initialConfig.url);
      if (initialConfig.env) {
        setEnvVars(Object.entries(initialConfig.env).map(([k, v]) => `${k}=${v}`).join('\n'));
      }
      if (initialConfig.headers) {
        setHeaderVars(Object.entries(initialConfig.headers).map(([k, v]) => `${k}=${v}`).join('\n'));
      }
    }
  }, [initialConfig]);

  // JSON mode state
  const [jsonInput, setJsonInput] = useState('');
  const [jsonError, setJsonError] = useState<string | null>(null);

  // Example JSON for reference (supports both formats)
  const exampleJson = `{
  "mcpServers": {
    "my-server": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-git"],
      "env": {}
    }
  }
}`;

  const handleFormSubmit = () => {
    if (!name.trim()) return;
    if (transport === 'stdio' && !command.trim()) return;
    if (transport === 'sse' && !url.trim()) return;

    // Parse args (space-separated)
    const argsArray = args.trim() ? args.trim().split(/\s+/) : [];

    // Parse env vars (KEY=VALUE format, one per line)
    const envObj: Record<string, string> = {};
    if (envVars.trim()) {
      envVars.split('\n').forEach((line) => {
        const [key, ...valueParts] = line.split('=');
        if (key && valueParts.length > 0) {
          envObj[key.trim()] = valueParts.join('=').trim();
        }
      });
    }

    // Parse header vars (KEY=VALUE format, one per line)
    const headerObj: Record<string, string> = {};
    if (headerVars.trim()) {
      headerVars.split('\n').forEach((line) => {
        const [key, ...valueParts] = line.split('=');
        if (key && valueParts.length > 0) {
          headerObj[key.trim()] = valueParts.join('=').trim();
        }
      });
    }

    onSave({
      name: name.trim(),
      transport,
      command: transport === 'stdio' ? command.trim() : undefined,
      args: argsArray,
      env: envObj,
      url: transport === 'sse' ? url.trim() : undefined,
      headers: headerObj,
      enabled: true,
      autoStart,
      autoApprove,
    });
  };

  const handleJsonSubmit = () => {
    setJsonError(null);
    
    try {
      const parsed = JSON.parse(jsonInput);
      
      // Check if it's the full mcpServers format (Claude/Cursor style)
      if (parsed.mcpServers && typeof parsed.mcpServers === 'object') {
        // Extract the first server from mcpServers object
        const serverEntries = Object.entries(parsed.mcpServers);
        if (serverEntries.length === 0) {
          setJsonError('No servers found in mcpServers object');
          return;
        }
        
        // Process each server entry
        for (const [serverName, serverConfig] of serverEntries) {
          const cfg = serverConfig as Record<string, unknown>;
          const transportType: McpTransportType = cfg.url ? 'sse' : 'stdio';
          
          const config: Omit<McpServerConfig, 'id'> = {
            name: serverName,
            transport: transportType,
            command: cfg.command as string | undefined,
            args: Array.isArray(cfg.args) ? cfg.args : [],
            env: typeof cfg.env === 'object' && cfg.env !== null ? cfg.env as Record<string, string> : {},
            url: cfg.url as string | undefined,
            headers: typeof cfg.headers === 'object' && cfg.headers !== null ? cfg.headers as Record<string, string> : {},
            enabled: cfg.enabled !== false,
            autoStart: cfg.autoStart === true,
            autoApprove: cfg.autoApprove !== false, // Default to true
          };
          
          onSave(config);
        }
        return;
      }
      
      // Single server format (simple JSON)
      // Validate required fields
      if (!parsed.name && !parsed.command && !parsed.url) {
        setJsonError('JSON must have "mcpServers" object OR at least "name" and either "command" or "url"');
        return;
      }

      // Determine transport type
      const transportType: McpTransportType = parsed.url ? 'sse' : 'stdio';

      // Build config
      const config: Omit<McpServerConfig, 'id'> = {
        name: parsed.name || 'Unnamed Server',
        transport: transportType,
        command: parsed.command,
        args: Array.isArray(parsed.args) ? parsed.args : [],
        env: typeof parsed.env === 'object' ? parsed.env : {},
        url: parsed.url,
        headers: typeof parsed.headers === 'object' ? parsed.headers : {},
        enabled: parsed.enabled !== false,
        autoStart: parsed.autoStart === true,
        autoApprove: parsed.autoApprove !== false, // Default to true
      };

      onSave(config);
    } catch (e) {
      setJsonError(`Invalid JSON: ${e instanceof Error ? e.message : 'Parse error'}`);
    }
  };

  return (
    <div className="p-3 border border-primary/30 rounded-lg bg-primary/5 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-medium text-text-primary">Add MCP Server</h3>
        {/* Mode toggle */}
        <div className="flex items-center gap-1 bg-input rounded-md p-0.5">
          <button
            onClick={() => setMode('form')}
            className={clsx(
              'px-2 py-0.5 text-[10px] rounded transition-colors',
              mode === 'form'
                ? 'bg-primary text-white'
                : 'text-text-secondary hover:text-text-primary'
            )}
          >
            Form
          </button>
          <button
            onClick={() => setMode('json')}
            className={clsx(
              'px-2 py-0.5 text-[10px] rounded transition-colors',
              mode === 'json'
                ? 'bg-primary text-white'
                : 'text-text-secondary hover:text-text-primary'
            )}
          >
            Raw JSON
          </button>
        </div>
      </div>

      {mode === 'form' ? (
        <>
          {/* Form Mode */}
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-[10px] text-text-secondary block mb-0.5">Name *</label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="My MCP Server"
                className="w-full bg-input border border-input-border rounded px-2 py-1.5 text-xs text-text-primary placeholder:text-text-disabled focus:outline-none focus:border-primary"
              />
            </div>
            <div>
              <label className="text-[10px] text-text-secondary block mb-0.5">Transport *</label>
              <select
                value={transport}
                onChange={(e) => setTransport(e.target.value as McpTransportType)}
                className="w-full bg-input border border-input-border rounded px-2 py-1.5 text-xs text-text-primary focus:outline-none focus:border-primary"
              >
                <option value="stdio">Stdio (Local Process)</option>
                <option value="sse">SSE (HTTP Server)</option>
              </select>
            </div>
          </div>

          {transport === 'stdio' ? (
            <>
              <div>
                <label className="text-[10px] text-text-secondary block mb-0.5">Command *</label>
                <input
                  type="text"
                  value={command}
                  onChange={(e) => setCommand(e.target.value)}
                  placeholder="npx, uvx, node, python..."
                  className="w-full bg-input border border-input-border rounded px-2 py-1.5 text-xs text-text-primary placeholder:text-text-disabled focus:outline-none focus:border-primary font-mono"
                />
              </div>
              <div>
                <label className="text-[10px] text-text-secondary block mb-0.5">Arguments (space-separated)</label>
                <input
                  type="text"
                  value={args}
                  onChange={(e) => setArgs(e.target.value)}
                  placeholder="-y @modelcontextprotocol/server-git"
                  className="w-full bg-input border border-input-border rounded px-2 py-1.5 text-xs text-text-primary placeholder:text-text-disabled focus:outline-none focus:border-primary font-mono"
                />
              </div>
            </>
          ) : (
            <div>
              <label className="text-[10px] text-text-secondary block mb-0.5">URL *</label>
              <input
                type="text"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="http://localhost:3000/sse"
                className="w-full bg-input border border-input-border rounded px-2 py-1.5 text-xs text-text-primary placeholder:text-text-disabled focus:outline-none focus:border-primary font-mono"
              />
            </div>
          )}

          <div>
            <label className="text-[10px] text-text-secondary block mb-0.5">
              Environment Variables (KEY=VALUE, one per line)
            </label>
            <textarea
              value={envVars}
              onChange={(e) => setEnvVars(e.target.value)}
              placeholder="API_KEY=your-key&#10;DEBUG=true"
              rows={2}
              className="w-full bg-input border border-input-border rounded px-2 py-1.5 text-xs text-text-primary placeholder:text-text-disabled focus:outline-none focus:border-primary font-mono resize-none"
            />
          </div>

          {transport === 'sse' && (
            <div>
              <label className="text-[10px] text-text-secondary block mb-0.5">
                Headers (KEY=VALUE, one per line)
              </label>
              <textarea
                value={headerVars}
                onChange={(e) => setHeaderVars(e.target.value)}
                placeholder="Authorization=Bearer token&#10;X-Custom-Header=value"
                rows={2}
                className="w-full bg-input border border-input-border rounded px-2 py-1.5 text-xs text-text-primary placeholder:text-text-disabled focus:outline-none focus:border-primary font-mono resize-none"
              />
            </div>
          )}

          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="autoStart"
                checked={autoStart}
                onChange={(e) => setAutoStart(e.target.checked)}
                className="w-3 h-3 rounded border-border bg-input accent-primary"
              />
              <label htmlFor="autoStart" className="text-[10px] text-text-secondary">
                Auto-start
              </label>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="autoApprove"
                checked={autoApprove}
                onChange={(e) => setAutoApprove(e.target.checked)}
                className="w-3 h-3 rounded border-border bg-input accent-primary"
              />
              <label htmlFor="autoApprove" className="text-[10px] text-text-secondary">
                Auto-approve tools
              </label>
            </div>
          </div>

          <div className="flex justify-end gap-2 pt-1">
            <button onClick={onCancel} className="px-3 py-1 text-xs text-text-secondary hover:text-text-primary">
              Cancel
            </button>
            <button
              onClick={handleFormSubmit}
              disabled={!name.trim() || (transport === 'stdio' ? !command.trim() : !url.trim())}
              className="px-3 py-1 text-xs font-medium text-white bg-primary hover:bg-primary/80 rounded transition-colors disabled:opacity-50"
            >
              Add Server
            </button>
          </div>
        </>
      ) : (
        <>
          {/* JSON Mode */}
          <div>
            <label className="text-[10px] text-text-secondary block mb-0.5">
              Paste MCP Server JSON Configuration
            </label>
            <textarea
              value={jsonInput}
              onChange={(e) => {
                setJsonInput(e.target.value);
                setJsonError(null);
              }}
              placeholder={exampleJson}
              rows={8}
              className="w-full bg-input border border-input-border rounded px-2 py-1.5 text-xs text-text-primary placeholder:text-text-disabled focus:outline-none focus:border-primary font-mono resize-none"
              spellCheck={false}
            />
          </div>

          {jsonError && (
            <div className="p-2 rounded bg-danger/10 border border-danger/20 text-[10px] text-danger flex items-center gap-2">
              <AlertCircle className="w-3 h-3 flex-shrink-0" />
              {jsonError}
            </div>
          )}

          <div className="text-[10px] text-text-disabled">
            <p className="font-medium mb-1">Example JSON format:</p>
            <pre className="bg-input rounded p-2 overflow-x-auto border border-border text-[9px]">
              {exampleJson}
            </pre>
          </div>

          <div className="flex justify-end gap-2 pt-1">
            <button onClick={onCancel} className="px-3 py-1 text-xs text-text-secondary hover:text-text-primary">
              Cancel
            </button>
            <button
              onClick={handleJsonSubmit}
              disabled={!jsonInput.trim()}
              className="px-3 py-1 text-xs font-medium text-white bg-primary hover:bg-primary/80 rounded transition-colors disabled:opacity-50"
            >
              Add Server
            </button>
          </div>
        </>
      )}
    </div>
  );
};

// ============================================
// SERVER CARD
// ============================================

interface ServerCardProps {
  server: McpServerState;
  isExpanded: boolean;
  onToggleExpand: () => void;
}

const ServerCard: React.FC<ServerCardProps> = ({ server, isExpanded, onToggleExpand }) => {
  const { toggleServer, connectServer, disconnectServer, removeServer, updateServer } = useMcpStore();
  const [isConnecting, setIsConnecting] = useState(false);
  const [showEnv, setShowEnv] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [editName, setEditName] = useState(server.config.name);
  const [editTransport, setEditTransport] = useState<McpTransportType>(server.config.transport);
  const [editCommand, setEditCommand] = useState(server.config.command || '');
  const [editArgs, setEditArgs] = useState(server.config.args.join(' '));
  const [editUrl, setEditUrl] = useState(server.config.url || '');
  const [editEnv, setEditEnv] = useState(
    Object.entries(server.config.env)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n')
  );
  const [editAutoStart, setEditAutoStart] = useState(server.config.autoStart);
  const [editAutoApprove, setEditAutoApprove] = useState(server.config.autoApprove);


  useEffect(() => {
    if (!isExpanded) {
      setIsEditing(false);
      return;
    }

    setEditName(server.config.name);
    setEditTransport(server.config.transport);
    setEditCommand(server.config.command || '');
    setEditArgs(server.config.args.join(' '));
    setEditUrl(server.config.url || '');
    setEditEnv(
      Object.entries(server.config.env)
        .map(([key, value]) => `${key}=${value}`)
        .join('\n')
    );
    setEditAutoStart(server.config.autoStart);
    setEditAutoApprove(server.config.autoApprove);
  }, [isExpanded, server.config]);

  const handleConnect = async () => {
    setIsConnecting(true);
    await connectServer(server.config.id);
    setIsConnecting(false);
  };

  const handleDisconnect = async () => {
    await disconnectServer(server.config.id);
  };

  const handleToggle = async () => {
    await toggleServer(server.config.id, !server.config.enabled);
  };

  const handleSaveEdit = async () => {
    const envObj: Record<string, string> = {};
    if (editEnv.trim()) {
      editEnv.split('\n').forEach((line) => {
        const [key, ...valueParts] = line.split('=');
        if (key && valueParts.length > 0) {
          envObj[key.trim()] = valueParts.join('=').trim();
        }
      });
    }

    const updatedConfig: McpServerConfig = {
      ...server.config,
      name: editName.trim() || server.config.name,
      transport: editTransport,
      command: editTransport === 'stdio' ? editCommand.trim() : undefined,
      args: editArgs.trim() ? editArgs.trim().split(/\s+/) : [],
      url: editTransport === 'sse' ? editUrl.trim() : undefined,
      env: envObj,
      autoStart: editAutoStart,
      autoApprove: editAutoApprove,
    };

    await updateServer(updatedConfig);
    setIsEditing(false);
  };

  const handleCancelEdit = () => {
    setEditName(server.config.name);
    setEditTransport(server.config.transport);
    setEditCommand(server.config.command || '');
    setEditArgs(server.config.args.join(' '));
    setEditUrl(server.config.url || '');
    setEditEnv(
      Object.entries(server.config.env)
        .map(([key, value]) => `${key}=${value}`)
        .join('\n')
    );
    setEditAutoStart(server.config.autoStart);
    setEditAutoApprove(server.config.autoApprove);
    setIsEditing(false);
  };


  const handleRemove = () => {
    setShowDeleteDialog(true);
  };

  const confirmRemove = async () => {
    await removeServer(server.config.id);
    setShowDeleteDialog(false);
  };

  const getStatusIcon = () => {
    switch (server.status) {
      case 'connected':
        return <CheckCircle className="w-3 h-3 text-success" />;
      case 'connecting':
        return <Loader2 className="w-3 h-3 text-primary animate-spin" />;
      case 'error':
        return <AlertCircle className="w-3 h-3 text-danger" />;
      default:
        return <Server className="w-3 h-3 text-text-disabled" />;
    }
  };

  const getStatusText = () => {
    switch (server.status) {
      case 'connected':
        return 'Connected';
      case 'connecting':
        return 'Connecting...';
      case 'error':
        return 'Error';
      default:
        return 'Disconnected';
    }
  };

  return (
    <div className="border border-border rounded-lg bg-titlebar overflow-hidden">
      {/* Header */}
      <div
        className="flex items-center justify-between px-3 py-2 cursor-pointer hover:bg-input/30"
        onClick={onToggleExpand}
      >
        <div className="flex items-center gap-2">
          <ChevronDown
            className={clsx('w-3.5 h-3.5 text-text-disabled transition-transform', isExpanded && 'rotate-180')}
          />
          {server.config.transport === 'stdio' ? (
            <Terminal className="w-3.5 h-3.5 text-text-secondary" />
          ) : (
            <Globe className="w-3.5 h-3.5 text-text-secondary" />
          )}
          <span className="text-xs font-medium text-text-primary">{server.config.name}</span>
          <span
            className={clsx(
              'text-[9px] px-1.5 py-0.5 rounded flex items-center gap-1',
              server.status === 'connected' && 'bg-success/20 text-success',
              server.status === 'connecting' && 'bg-primary/20 text-primary',
              server.status === 'error' && 'bg-danger/20 text-danger',
              server.status === 'disconnected' && 'bg-input text-text-disabled'
            )}
          >
            {getStatusIcon()}
            {getStatusText()}
          </span>
          {server.tools.length > 0 && (
            <span className="text-[9px] px-1 py-0.5 rounded bg-primary/10 text-primary">
              {server.tools.length} tools
            </span>
          )}
          {server.config.autoApprove && (
            <span className="text-[9px] px-1 py-0.5 rounded bg-success/10 text-success flex items-center gap-0.5" title="Tools auto-approved">
              <Check className="w-2.5 h-2.5" />
              Auto
            </span>
          )}
        </div>
        <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
          {/* Connect/Disconnect button */}
          {server.config.enabled && (
            <>
              {server.status === 'connected' ? (
                <button
                  onClick={handleDisconnect}
                  className="p-1 rounded text-text-secondary hover:text-danger hover:bg-danger/10"
                  title="Disconnect"
                >
                  <Square className="w-3.5 h-3.5" />
                </button>
              ) : (
                <button
                  onClick={handleConnect}
                  disabled={isConnecting || server.status === 'connecting'}
                  className="p-1 rounded text-text-secondary hover:text-success hover:bg-success/10 disabled:opacity-50"
                  title="Connect"
                >
                  {isConnecting || server.status === 'connecting' ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Play className="w-3.5 h-3.5" />
                  )}
                </button>
              )}
            </>
          )}
          <button
            onClick={() => setIsEditing((prev) => !prev)}
            className={clsx(
              "p-1 rounded",
              isEditing
                ? "text-primary bg-primary/10"
                : "text-text-secondary hover:text-text-primary hover:bg-input"
            )}
            title={isEditing ? "Stop editing" : "Edit server"}
          >
            <Pencil className="w-3.5 h-3.5" />
          </button>
          {/* Delete button */}
          <button
            onClick={handleRemove}
            className="p-1 rounded text-text-disabled hover:text-danger hover:bg-danger/10"
            title="Remove"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
          {/* Enable/Disable toggle */}
          <TogglePill
            checked={server.config.enabled}
            onChange={() => handleToggle()}
            ariaLabel={`Toggle ${server.config.name || 'MCP server'}`}
            variant="primary"
            size="sm"
          />
        </div>

      </div>

      {/* Expanded Content */}
      {isExpanded && (
        <div className="px-3 pb-3 pt-1 border-t border-border space-y-2">
          {/* Error message */}
          {server.error && (
            <div className="p-2 rounded bg-danger/10 border border-danger/20 text-[10px] text-danger">
              {server.error}
            </div>
          )}

          {/* Server Info */}
          {server.serverInfo && (
            <div className="text-[10px] text-text-secondary">
              Server: {server.serverInfo.name}
              {server.serverInfo.version && ` v${server.serverInfo.version}`}
            </div>
          )}

          {/* Auto-approve toggle */}
          <div className="flex items-center justify-between py-1">
            <div className="flex items-center gap-2">
              <Check className="w-3.5 h-3.5 text-success" />
              <span className="text-[10px] text-text-secondary">Auto-approve all tools</span>
            </div>
            <TogglePill
              checked={isEditing ? editAutoApprove : server.config.autoApprove}
              onChange={async (next) => {
                if (isEditing) {
                  setEditAutoApprove(next);
                  return;
                }
                const updatedConfig = { ...server.config, autoApprove: next };
                await updateServer(updatedConfig);
              }}
              ariaLabel="Toggle MCP auto-approve all tools"
              variant="success"
              size="sm"
            />
          </div>

          {isEditing ? (
            <div className="space-y-2">
              <div>
                <label className="text-[10px] text-text-disabled block mb-0.5">Name</label>
                <input
                  type="text"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  className="w-full bg-input border border-input-border rounded px-2 py-1.5 text-xs text-text-primary focus:outline-none focus:border-primary"
                />
              </div>
              <div>
                <label className="text-[10px] text-text-disabled block mb-0.5">Transport</label>
                <select
                  value={editTransport}
                  onChange={(e) => setEditTransport(e.target.value as McpTransportType)}
                  className="w-full bg-input border border-input-border rounded px-2 py-1.5 text-xs text-text-primary focus:outline-none focus:border-primary"
                >
                  <option value="stdio">Stdio</option>
                  <option value="sse">SSE (HTTP Server)</option>
                </select>
              </div>
              {editTransport === 'stdio' ? (
                <>
                  <div>
                    <label className="text-[10px] text-text-disabled block mb-0.5">Command</label>
                    <input
                      type="text"
                      value={editCommand}
                      onChange={(e) => setEditCommand(e.target.value)}
                      className="w-full bg-input border border-input-border rounded px-2 py-1.5 text-xs text-text-primary focus:outline-none focus:border-primary font-mono"
                    />
                  </div>
                  <div>
                    <label className="text-[10px] text-text-disabled block mb-0.5">Args</label>
                    <input
                      type="text"
                      value={editArgs}
                      onChange={(e) => setEditArgs(e.target.value)}
                      className="w-full bg-input border border-input-border rounded px-2 py-1.5 text-xs text-text-primary focus:outline-none focus:border-primary font-mono"
                    />
                  </div>
                </>
              ) : (
                <div>
                  <label className="text-[10px] text-text-disabled block mb-0.5">URL</label>
                  <input
                    type="text"
                    value={editUrl}
                    onChange={(e) => setEditUrl(e.target.value)}
                    className="w-full bg-input border border-input-border rounded px-2 py-1.5 text-xs text-text-primary focus:outline-none focus:border-primary font-mono"
                  />
                </div>
              )}
              <div>
                <label className="text-[10px] text-text-disabled block mb-0.5">Environment Variables</label>
                <textarea
                  value={editEnv}
                  onChange={(e) => setEditEnv(e.target.value)}
                  rows={2}
                  className="w-full bg-input border border-input-border rounded px-2 py-1.5 text-xs text-text-primary focus:outline-none focus:border-primary font-mono resize-none"
                />
              </div>
              <div className="flex items-center justify-between">
                <label className="text-[10px] text-text-secondary">Auto-start</label>
                <TogglePill
                  checked={editAutoStart}
                  onChange={setEditAutoStart}
                  ariaLabel="Toggle MCP auto-start"
                  variant="primary"
                  size="sm"
                />
              </div>
              <div className="flex items-center justify-end gap-2 pt-1">
                <button
                  onClick={handleCancelEdit}
                  className="px-2.5 py-1 text-[10px] text-text-secondary hover:text-text-primary"
                >
                  Cancel
                </button>
                <button
                  onClick={handleSaveEdit}
                  className="px-2.5 py-1 text-[10px] font-semibold text-white bg-primary hover:bg-primary/80 rounded"
                >
                  <span className="inline-flex items-center gap-1">
                    <Save className="w-3 h-3" />
                    Save
                  </span>
                </button>
              </div>
            </div>
          ) : (
            <>
              {/* Transport info */}
              <div>
                <label className="text-[10px] text-text-disabled block mb-0.5">
                  {server.config.transport === 'stdio' ? 'Command' : 'URL'}
                </label>
                <div className="text-[10px] text-text-secondary font-mono bg-input rounded px-2 py-1 border border-border">
                  {server.config.transport === 'stdio' ? (
                    <>
                      {server.config.command} {server.config.args.join(' ')}
                    </>
                  ) : (
                    server.config.url
                  )}
                </div>
              </div>

              {/* Environment variables */}
              {Object.keys(server.config.env).length > 0 && (
                <div>
                  <div className="flex items-center justify-between mb-0.5">
                    <label className="text-[10px] text-text-disabled">Environment Variables</label>
                    <button
                      onClick={() => setShowEnv(!showEnv)}
                      className="p-0.5 rounded text-text-disabled hover:text-text-secondary"
                    >
                      {showEnv ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
                    </button>
                  </div>
                  {showEnv && (
                    <div className="text-[10px] text-text-secondary font-mono bg-input rounded px-2 py-1 border border-border space-y-0.5">
                      {Object.entries(server.config.env).map(([key, value]) => (
                        <div key={key}>
                          {key}={value}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </>
          )}


          {/* Tools list with tooltips */}
          {server.tools.length > 0 && (
            <div>
              <label className="text-[10px] text-text-disabled block mb-1">
                Available Tools ({server.tools.length})
              </label>
              <div className="flex flex-wrap gap-1">
                {server.tools.map((tool) => (
                  <div key={tool.name} className="group relative">
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-primary/10 text-primary font-mono border border-primary/20 cursor-help">
                      {tool.name}
                    </span>
                    {/* Tooltip - matches context menu styling */}
                    <div className="absolute bottom-full left-0 mb-1 hidden group-hover:block z-50 w-64 max-w-xs pointer-events-none">
                      <div className="bg-sidebar border border-border rounded shadow-lg p-2">
                        <p className="text-[10px] font-medium text-text-primary mb-1">{tool.name}</p>
                        {tool.description && (
                          <p className="text-[9px] text-text-secondary leading-relaxed">{tool.description}</p>
                        )}
                        {!tool.description && (
                          <p className="text-[9px] text-text-disabled italic">No description available</p>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Resources list */}
          {server.resources.length > 0 && (
            <div>
              <label className="text-[10px] text-text-disabled block mb-1">Available Resources</label>
              <div className="flex flex-wrap gap-1">
                {server.resources.map((resource) => (
                  <span
                    key={resource.uri}
                    className="text-[10px] px-1.5 py-0.5 rounded bg-input text-text-secondary font-mono border border-border"
                    title={resource.description || resource.uri}
                  >
                    {resource.name}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Delete Confirmation Dialog */}
      <DeleteConfirmDialog
        isOpen={showDeleteDialog}
        itemName={server.config.name}
        itemType="server"
        onConfirm={confirmRemove}
        onCancel={() => setShowDeleteDialog(false)}
      />
    </div>
  );
};

// ============================================
// MARKETPLACE CARD
// ============================================

interface MarketplaceCardProps {
  item: MarketplaceItem;
  isInstalled: boolean;
  onInstall: (item: MarketplaceItem) => void;
}

const MarketplaceCard: React.FC<MarketplaceCardProps> = ({ item, isInstalled, onInstall }) => {
  return (
    <div className="border border-border rounded-lg bg-titlebar p-3 flex flex-col justify-between h-full">
      <div>
        <div className="flex items-start justify-between mb-2">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded bg-primary/10 flex items-center justify-center text-primary">
              <Globe className="w-4 h-4" />
            </div>
            <div>
              <h4 className="text-xs font-medium text-text-primary">{item.name}</h4>
              <p className="text-[9px] text-text-secondary">by {item.author}</p>
            </div>
          </div>
          {isInstalled && (
            <span className="text-[9px] px-1.5 py-0.5 rounded bg-success/10 text-success flex items-center gap-1">
              <Check className="w-2.5 h-2.5" />
              Installed
            </span>
          )}
        </div>
        
        <p className="text-[10px] text-text-secondary leading-relaxed mb-3 h-8 line-clamp-2">
          {item.description}
        </p>
        
        <div className="flex items-center gap-2 mb-3">
          <span className="text-[9px] px-1.5 py-0.5 rounded bg-input text-text-secondary font-mono border border-border">
            {item.transport}
          </span>
          {item.transport === 'stdio' && (
            <span className="text-[9px] px-1.5 py-0.5 rounded bg-input text-text-disabled font-mono border border-border truncate max-w-[120px]">
              {item.command}
            </span>
          )}
        </div>
      </div>

      <button
        onClick={() => onInstall(item)}
        disabled={isInstalled}
        className={clsx(
          "w-full py-1.5 rounded text-[10px] font-medium transition-colors flex items-center justify-center gap-1.5",
          isInstalled
            ? "bg-input text-text-disabled cursor-default"
            : "bg-primary text-white hover:bg-primary/80"
        )}
      >
        {isInstalled ? (
          "Installed"
        ) : (
          <>
            <Download className="w-3 h-3" />
            Install
          </>
        )}
      </button>
    </div>
  );
};

// ============================================
// MAIN COMPONENT
// ============================================

export const McpSettingsTab: React.FC = () => {
  const { servers, isLoading, configPath, error, loadServers, refreshServers, getConfigPath, addServer } = useMcpStore();
  const [activeTab, setActiveTab] = useState<'installed' | 'marketplace'>('installed');
  const [isAddingServer, setIsAddingServer] = useState(false);
  const [expandedServer, setExpandedServer] = useState<string | null>(null);
  const [installConfig, setInstallConfig] = useState<Partial<McpServerConfig> | undefined>(undefined);

  // Load servers on mount (only once, preserves connection state)
  useEffect(() => {
    loadServers(); // Will skip if already initialized
    getConfigPath();
  }, []);

  const handleAddServer = async (config: Omit<McpServerConfig, 'id'>) => {
    await addServer(config);
    setIsAddingServer(false);
    setInstallConfig(undefined);
  };

  const handleInstall = (item: MarketplaceItem) => {
    // Prepare config from marketplace item
    const config: Partial<McpServerConfig> = {
      name: item.name,
      transport: item.transport,
      command: item.command,
      args: item.args || [],
      url: item.url,
      enabled: true,
      autoStart: true,
      autoApprove: true,
    };
    
    // Add env example if present
    if (item.envExample) {
      const env: Record<string, string> = {};
      item.envExample.split('\n').forEach(line => {
        const [k, v] = line.split('=');
        if (k && v) env[k] = v;
      });
      config.env = env;
    }

    setInstallConfig(config);
    setIsAddingServer(true);
    setActiveTab('installed');
  };

  const handleRefresh = () => {
    refreshServers(); // Force refresh from backend
  };

  const [copied, setCopied] = useState(false);

  const handleCopyPath = async () => {
    if (configPath) {
      try {
        await navigator.clipboard.writeText(configPath);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      } catch (error) {
        console.error('Failed to copy path:', error);
      }
    }
  };

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-medium text-text-primary">MCP Servers</h3>
          <p className="text-[10px] text-text-secondary mt-0.5">
            Connect to Model Context Protocol servers to extend Aurora's capabilities
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleRefresh}
            disabled={isLoading}
            className="p-1.5 rounded text-text-secondary hover:text-text-primary hover:bg-input disabled:opacity-50"
            title="Refresh"
          >
            <RefreshCw className={clsx('w-3.5 h-3.5', isLoading && 'animate-spin')} />
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-1 border-b border-border">
        <button
          onClick={() => setActiveTab('installed')}
          className={clsx(
            "px-3 py-1.5 text-xs font-medium border-b-2 transition-colors flex items-center gap-1.5",
            activeTab === 'installed'
              ? "border-primary text-primary"
              : "border-transparent text-text-secondary hover:text-text-primary"
          )}
        >
          <Server className="w-3.5 h-3.5" />
          Installed
          <span className="bg-input text-text-secondary px-1.5 rounded-full text-[9px]">
            {servers.length}
          </span>
        </button>
        <button
          onClick={() => setActiveTab('marketplace')}
          className={clsx(
            "px-3 py-1.5 text-xs font-medium border-b-2 transition-colors flex items-center gap-1.5",
            activeTab === 'marketplace'
              ? "border-primary text-primary"
              : "border-transparent text-text-secondary hover:text-text-primary"
          )}
        >
          <ShoppingBag className="w-3.5 h-3.5" />
          Marketplace
        </button>
      </div>

      {/* Content */}
      {activeTab === 'installed' ? (
        <div className="space-y-4">
          {/* Action Bar */}
          <div className="flex items-center justify-between">
            {configPath && (
              <button
                onClick={handleCopyPath}
                className="flex items-center gap-2 text-[10px] text-text-disabled hover:text-text-secondary transition-colors group"
                title="Click to copy path"
              >
                {copied ? (
                  <Check className="w-3 h-3 text-success" />
                ) : (
                  <Copy className="w-3 h-3 group-hover:text-primary" />
                )}
                <span className="font-mono">{configPath}</span>
                {copied && <span className="text-success text-[9px]">Copied!</span>}
              </button>
            )}
            
            <button
              onClick={() => {
                setInstallConfig(undefined);
                setIsAddingServer(true);
              }}
              className="flex items-center gap-1 px-2 py-1 text-[10px] font-medium text-white bg-primary hover:bg-primary/80 rounded transition-colors"
            >
              <Plus className="w-3 h-3" />
              Add Custom Server
            </button>
          </div>

          {/* Error message */}
          {error && (
            <div className="p-2 rounded bg-danger/10 border border-danger/20 text-xs text-danger flex items-center gap-2">
              <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" />
              {error}
            </div>
          )}

          {/* Add server form */}
          {isAddingServer && (
            <AddServerForm 
              initialConfig={installConfig}
              onSave={handleAddServer} 
              onCancel={() => {
                setIsAddingServer(false);
                setInstallConfig(undefined);
              }} 
            />
          )}

          {/* Server list */}
          {isLoading ? (
            <div className="flex items-center justify-center py-8 text-text-secondary">
              <Loader2 className="w-5 h-5 animate-spin" />
            </div>
          ) : servers.length === 0 && !isAddingServer ? (
            <div className="text-center py-8">
              <Server className="w-8 h-8 text-text-disabled mx-auto mb-2" />
              <p className="text-xs text-text-secondary">No MCP servers configured</p>
              <p className="text-[10px] text-text-disabled mt-1">
                Check the Marketplace to discover available tools
              </p>
              <button
                onClick={() => setActiveTab('marketplace')}
                className="mt-3 px-3 py-1.5 text-xs font-medium text-primary bg-primary/10 hover:bg-primary/20 rounded transition-colors"
              >
                Browse Marketplace
              </button>
            </div>
          ) : (
            <div className="space-y-2">
              {servers.map((server) => (
                <ServerCard
                  key={server.config.id}
                  server={server}
                  isExpanded={expandedServer === server.config.id}
                  onToggleExpand={() =>
                    setExpandedServer(expandedServer === server.config.id ? null : server.config.id)
                  }
                />
              ))}
            </div>
          )}
        </div>
      ) : (
        /* Marketplace Tab */
        <div className="grid grid-cols-2 gap-3">
          {MARKETPLACE_ITEMS.map((item) => {
            const isInstalled = servers.some(s => s.config.name === item.name); // Simple check by name
            return (
              <MarketplaceCard
                key={item.id}
                item={item}
                isInstalled={isInstalled}
                onInstall={handleInstall}
              />
            );
          })}
        </div>
      )}
    </div>
  );
};

